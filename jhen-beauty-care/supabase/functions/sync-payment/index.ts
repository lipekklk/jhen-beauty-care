// =============================================================================
// Edge Function: sync-payment
// Usada pela página de retorno do checkout. Em vez de confiar nos parâmetros da URL
// (que a cliente pode alterar), consulta o Mercado Pago no servidor e aplica o
// estado real — acelera a confirmação caso o webhook ainda não tenha chegado.
//
// Segurança: exige login; só a dona do pagamento (ou a administração) pode sincronizar;
// o pagamento do MP precisa ter external_reference igual ao pagamento local;
// limite de chamadas por usuário. Responde apenas status, nunca dados do gateway.
// =============================================================================
import { adminClient, callerUser, ConfigError, corsHeaders, fail, isUuid, json, originAllowed, rateLimit, readJson, errCode } from '../_shared/utils.ts';
import { applyMpPayment, getPayment, MpError, mpConfig, recordEvent, searchPaymentsByReference } from '../_shared/mercadopago.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 405, 'METHOD_NOT_ALLOWED');
  if (!originAllowed(req)) return fail(req, 403, 'ORIGIN_NOT_ALLOWED');

  try {
    mpConfig();
    const caller = await callerUser(req);
    if (!caller) return fail(req, 401, 'NOT_AUTHENTICATED');

    const body = await readJson(req);
    const paymentId = body?.payment_id;
    const mpPaymentId = body?.mp_payment_id;
    if (!isUuid(paymentId)) return fail(req, 400, 'INVALID_REQUEST');
    if (mpPaymentId != null && !(typeof mpPaymentId === 'string' && /^\d{1,20}$/.test(mpPaymentId))) {
      return fail(req, 400, 'INVALID_REQUEST');
    }

    const db = adminClient();
    if (!(await rateLimit(db, `sync-payment:${caller.user.id}`, 30, 600))) return fail(req, 429, 'TOO_MANY_REQUESTS');

    const { data: p } = await db.from('payments').select('id, client_id, method').eq('id', paymentId).maybeSingle();
    const { data: isAdmin } = await caller.client.rpc('is_admin');
    if (!p || (p.client_id !== caller.user.id && isAdmin !== true)) return fail(req, 404, 'NOT_FOUND');

    if (p.method === 'online') {
      try {
        if (mpPaymentId) {
          const mp = await getPayment(mpPaymentId);
          // o ID vindo da URL só vale se pertencer a ESTE pagamento
          if (mp.external_reference === p.id) await applyMpPayment(db, mp, 'sync');
          else await recordEvent(db, { source: 'sync', payment_id: p.id, provider_payment_id: mpPaymentId, outcome: 'reference_mismatch' });
        } else {
          // sem ID: busca as tentativas desta referência e aplica da mais antiga para a mais nova
          const results = await searchPaymentsByReference(p.id);
          const ordered = results
            .filter((r) => r.external_reference === p.id)
            .sort((a, b) => String(a.date_last_updated ?? '').localeCompare(String(b.date_last_updated ?? '')));
          for (const mp of ordered) await applyMpPayment(db, mp, 'sync');
        }
      } catch (err) {
        if (!(err instanceof MpError && err.status === 404)) {
          await recordEvent(db, { source: 'sync', payment_id: p.id, outcome: 'sync_failed', detail: err instanceof Error ? err.message.slice(0, 60) : 'error' });
        }
        // falha na consulta não é erro para a cliente: o webhook ainda vai confirmar
      }
    }

    const { data: fresh } = await db
      .from('purchases')
      .select('status, appointment_status, access_granted')
      .eq('id', p.id)
      .single();
    return json(req, fresh ?? {});
  } catch (err) {
    if (err instanceof ConfigError) return fail(req, 503, 'ONLINE_PAYMENT_UNAVAILABLE');
    console.error('sync-payment', errCode(err));
    return fail(req, 500, 'INTERNAL_ERROR');
  }
});
