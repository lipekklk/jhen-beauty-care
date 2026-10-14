// =============================================================================
// Edge Function: create-payment
// Prepara o pagamento de um agendamento no Checkout Pro do Mercado Pago.
//
// Segurança:
//  - exige usuário autenticado e só aceita pagamentos da PRÓPRIA cliente;
//  - o VALOR, o procedimento e a cliente vêm do banco, nunca do navegador;
//  - recusa pagamento expirado, já pago, em análise ou com pagamento online desligado;
//  - reaproveita a preferência ainda válida (sem duplicar cobranças);
//  - limite de tentativas por usuário; CORS restrito; nada de segredo na resposta;
//  - os dados do cartão são digitados no Mercado Pago, nunca passam por aqui.
//
// Secrets: MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_ENV, SITE_URL (e opcional ALLOWED_ORIGINS)
// =============================================================================
import { adminClient, callerUser, ConfigError, corsHeaders, env, fail, isUuid, json, log, originAllowed, rateLimit, readJson, errCode } from '../_shared/utils.ts';
import { createPreference, isCheckoutUrl, mpConfig, mpDate, MpError, recordEvent } from '../_shared/mercadopago.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 405, 'METHOD_NOT_ALLOWED');
  if (!originAllowed(req)) return fail(req, 403, 'ORIGIN_NOT_ALLOWED');

  try {
    const cfg = mpConfig(); // falha cedo se o Mercado Pago não estiver configurado
    const caller = await callerUser(req);
    if (!caller) return fail(req, 401, 'NOT_AUTHENTICATED');

    const body = await readJson(req);
    const paymentId = body?.payment_id;
    if (!isUuid(paymentId)) return fail(req, 400, 'INVALID_REQUEST');

    const db = adminClient();
    if (!(await rateLimit(db, `create-payment:${caller.user.id}`, 10, 600))) return fail(req, 429, 'TOO_MANY_REQUESTS');

    const { data: settings } = await db.from('settings').select('payment_provider, business_name').eq('id', 1).single();
    if (settings?.payment_provider !== 'mercadopago') return fail(req, 503, 'ONLINE_PAYMENT_UNAVAILABLE');

    const { data: p } = await db
      .from('payments')
      .select(`id, client_id, amount, currency, kind, method, status, provider_preference_id, checkout_url, checkout_expires_at,
               appointment:appointments(id, status, starts_at, service:services(name)),
               client:profiles(full_name, email)`)
      .eq('id', paymentId)
      .maybeSingle();
    // pagamento de outra pessoa responde igual a inexistente (não revela que existe)
    if (!p || p.client_id !== caller.user.id) return fail(req, 404, 'NOT_FOUND');
    if (p.method !== 'online') return fail(req, 409, 'NOT_ONLINE_PAYMENT');
    if (['approved', 'refund_pending', 'refunded'].includes(p.status)) return fail(req, 409, 'ALREADY_PAID');
    if (p.status === 'in_process') return fail(req, 409, 'PAYMENT_IN_PROCESS');
    if (['charged_back', 'in_mediation'].includes(p.status)) return fail(req, 409, 'INVALID_STATUS');

    // deno-lint-ignore no-explicit-any
    const appt = p.appointment as any;
    const expiresAt = p.checkout_expires_at ? new Date(p.checkout_expires_at) : null;
    // margem de 1 min para a cliente conseguir concluir no Mercado Pago
    if (!appt || appt.status !== 'pending_payment' || !expiresAt || expiresAt.getTime() < Date.now() + 60_000) {
      return fail(req, 409, 'PAYMENT_EXPIRED');
    }

    // Reaproveita a preferência já criada para este pagamento (duplo clique, voltar do checkout etc.)
    if (p.provider_preference_id && isCheckoutUrl(p.checkout_url)) {
      return json(req, { url: p.checkout_url, expires_at: p.checkout_expires_at, reused: true });
    }

    const site = env('SITE_URL').replace(/\/+$/, '');
    const back = (r: string) => `${site}/pagamento.html?ref=${p.id}&r=${r}`;
    // deno-lint-ignore no-explicit-any
    const client = p.client as any;
    const [firstName, ...rest] = String(client?.full_name ?? '').replace(/\(.*?\)/g, '').trim().split(/\s+/);
    const title = `${appt.service?.name ?? 'Procedimento'} — ${settings?.business_name ?? 'JHEN beauty care'}`.slice(0, 250);

    const preference = {
      items: [{
        id: p.id,
        title,
        description: p.kind === 'deposit' ? 'Sinal para reservar o horário' : 'Pagamento do procedimento agendado',
        quantity: 1,
        currency_id: p.currency || 'BRL',
        unit_price: Number(p.amount), // valor do BANCO
      }],
      payer: { email: client?.email ?? undefined, name: firstName || undefined, surname: rest.join(' ') || undefined },
      external_reference: p.id,
      back_urls: { success: back('success'), pending: back('pending'), failure: back('failure') },
      // retorno automático só com HTTPS (endereços locais, como o Live Server, podem ser recusados pelo MP)
      ...(site.startsWith('https://') ? { auto_return: 'approved' } : {}),
      // o checkout deixa de aceitar pagamentos quando a reserva do horário expira
      expires: true,
      expiration_date_from: mpDate(new Date(Date.now() - 60_000)),
      expiration_date_to: mpDate(expiresAt),
      payment_methods: {
        // sem boleto/lotérica: levam dias para compensar e a reserva do horário dura minutos
        excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }],
        installments: cfg.maxInstallments,
      },
      statement_descriptor: cfg.statementDescriptor,
      metadata: { payment_id: p.id, appointment_id: appt.id },
    };

    let pref: Record<string, unknown>;
    try {
      // a mesma chave dentro do mesmo minuto evita preferências duplicadas por cliques repetidos
      pref = await createPreference(preference, `pref-${p.id}-${Math.floor(Date.now() / 60_000)}`);
    } catch (err) {
      const code = err instanceof MpError ? err.message : 'error';
      await recordEvent(db, { source: 'checkout', payment_id: p.id, outcome: 'preference_failed', detail: code });
      log('preference_failed', { payment_id: p.id, code });
      return fail(req, 502, 'GATEWAY_UNAVAILABLE');
    }

    // credenciais antigas de teste (TEST-...) usam sandbox_init_point; as atuais usam init_point
    const url = cfg.mode === 'test' && cfg.token.startsWith('TEST-') && pref.sandbox_init_point
      ? pref.sandbox_init_point
      : pref.init_point;
    if (!pref.id || !isCheckoutUrl(url)) {
      await recordEvent(db, { source: 'checkout', payment_id: p.id, outcome: 'preference_invalid' });
      return fail(req, 502, 'GATEWAY_UNAVAILABLE');
    }

    await db.from('payments').update({ provider_preference_id: String(pref.id), checkout_url: url, provider: 'mercadopago' }).eq('id', p.id);
    await recordEvent(db, { source: 'checkout', payment_id: p.id, outcome: 'preference_created' });
    log('preference_created', { payment_id: p.id, mode: cfg.mode });
    return json(req, { url, expires_at: p.checkout_expires_at, reused: false });
  } catch (err) {
    if (err instanceof ConfigError) {
      log('config_missing', { variable: err.variable });
      return fail(req, 503, 'ONLINE_PAYMENT_UNAVAILABLE');
    }
    console.error('create-payment', errCode(err));
    return fail(req, 500, 'INTERNAL_ERROR');
  }
});
