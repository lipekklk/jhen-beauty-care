// =============================================================================
// Edge Function: create-payment
// Cria a cobrança no Mercado Pago para um pagamento PENDENTE do próprio usuário.
//   - PIX    → /v1/payments (QR Code + copia e cola, expira junto com a reserva)
//   - Cartão → /checkout/preferences (Checkout Pro: o cartão é digitado no Mercado Pago)
// O valor vem do BANCO (nunca do navegador). Nenhum dado de cartão passa por aqui.
//
// Secrets necessários: MP_ACCESS_TOKEN, SITE_URL (ex.: https://jhenbeautycare.com.br)
// Opcional: ALLOWED_ORIGINS (ex.: https://jhenbeautycare.com.br)
// =============================================================================
import { adminClient, callerUser, corsHeaders, env, json } from '../_shared/utils.ts';

const MP_API = Deno.env.get('MP_API_URL') ?? 'https://api.mercadopago.com';

/** Formato exigido pelo Mercado Pago: 2026-10-07T20:15:00.000-03:00 */
function mpDate(d: Date, offset = '-03:00'): string {
  const local = new Date(d.getTime() - 3 * 3600_000);
  return local.toISOString().replace('Z', offset);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { message: 'Method not allowed' }, 405);

  try {
    const caller = await callerUser(req);
    if (!caller) return json(req, { message: 'NOT_AUTHENTICATED' }, 401);

    const { payment_id } = await req.json().catch(() => ({}));
    if (!payment_id || typeof payment_id !== 'string') return json(req, { message: 'payment_id obrigatório' }, 400);

    const db = adminClient();
    const { data: p, error } = await db
      .from('payments')
      .select('id, amount, method, status, client_id, appointment:appointments(id, status, created_at, starts_at, service:services(name)), client:profiles(full_name, email)')
      .eq('id', payment_id)
      .single();
    if (error || !p) return json(req, { message: 'Pagamento não encontrado' }, 404);

    // Somente a dona do pagamento, com reserva ainda aguardando pagamento
    if (p.client_id !== caller.user.id) return json(req, { message: 'FORBIDDEN' }, 403);
    // deno-lint-ignore no-explicit-any
    const appt = p.appointment as any;
    if (!['pending', 'rejected'].includes(p.status) || appt?.status !== 'pending_payment') {
      return json(req, { message: 'PAYMENT_EXPIRED' }, 409);
    }
    if (p.method === 'on_site') return json(req, { message: 'Pagamento presencial' }, 400);

    const { data: settings } = await db.from('settings').select('payment_hold_minutes, business_name').eq('id', 1).single();
    const expiresAt = new Date(new Date(appt.created_at).getTime() + (settings?.payment_hold_minutes ?? 15) * 60_000);
    // deno-lint-ignore no-explicit-any
    const client = p.client as any;
    const description = `${appt.service?.name ?? 'Procedimento'} — ${settings?.business_name ?? 'JHEN beauty care'}`;
    const notificationUrl = `${env('SUPABASE_URL')}/functions/v1/payment-webhook`;
    const headers = {
      Authorization: `Bearer ${env('MP_ACCESS_TOKEN')}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `${p.id}-${p.method}-${p.status}`,
    };

    if (p.method === 'pix') {
      const res = await fetch(`${MP_API}/v1/payments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          transaction_amount: Number(p.amount),
          description,
          payment_method_id: 'pix',
          external_reference: p.id,
          notification_url: notificationUrl,
          date_of_expiration: mpDate(expiresAt),
          payer: { email: client?.email, first_name: (client?.full_name ?? '').split(' ')[0] },
        }),
      });
      const mp = await res.json();
      if (!res.ok) {
        console.error('MP pix error', res.status, mp);
        return json(req, { message: 'Gateway indisponível' }, 502);
      }
      await db.from('payments').update({ provider: 'mercadopago', provider_payment_id: String(mp.id) }).eq('id', p.id);
      const tx = mp.point_of_interaction?.transaction_data ?? {};
      return json(req, { type: 'pix', qr_code: tx.qr_code, qr_code_base64: tx.qr_code_base64, ticket_url: tx.ticket_url });
    }

    // Cartão: Checkout Pro (página do Mercado Pago)
    const back = `${env('SITE_URL')}/cliente/agendamentos.html?payment_id=${p.id}`;
    const res = await fetch(`${MP_API}/checkout/preferences`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        items: [{ id: p.id, title: description, quantity: 1, unit_price: Number(p.amount), currency_id: 'BRL' }],
        payer: { email: client?.email, name: client?.full_name },
        external_reference: p.id,
        notification_url: notificationUrl,
        back_urls: { success: back, failure: back, pending: back },
        auto_return: 'approved',
        expires: true,
        expiration_date_to: mpDate(expiresAt),
        payment_methods: {
          excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }, { id: 'bank_transfer' }],
          installments: 1,
        },
        statement_descriptor: 'JHEN BEAUTY',
      }),
    });
    const pref = await res.json();
    if (!res.ok) {
      console.error('MP preference error', res.status, pref);
      return json(req, { message: 'Gateway indisponível' }, 502);
    }
    await db.from('payments').update({ provider: 'mercadopago' }).eq('id', p.id);
    return json(req, { type: 'redirect', url: pref.init_point });
  } catch (err) {
    console.error(err);
    return json(req, { message: 'Erro interno' }, 500);
  }
});
