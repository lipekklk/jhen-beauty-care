// =============================================================================
// Edge Function: refund-payment
// Solicita o estorno de um pagamento ao Mercado Pago (POST /v1/payments/{id}/refunds).
//
// Quem pode:
//  - a ADMINISTRAÇÃO: estorno de pagamento aprovado (total) ou de estorno pendente;
//  - a própria CLIENTE: somente quando o banco já calculou um estorno pendente
//    (cancelamento dentro da política). O VALOR vem sempre do banco, nunca do navegador.
// O status "estornado" só é gravado quando o Mercado Pago confirma (webhook/consulta).
// =============================================================================
import { adminClient, callerUser, ConfigError, corsHeaders, fail, isUuid, json, log, originAllowed, rateLimit, readJson, errCode } from '../_shared/utils.ts';
import { applyMpPayment, createRefund, getPayment, MpError, mpConfig, recordEvent } from '../_shared/mercadopago.ts';

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
    if (!isUuid(paymentId)) return fail(req, 400, 'INVALID_REQUEST');

    const db = adminClient();
    if (!(await rateLimit(db, `refund-payment:${caller.user.id}`, 10, 600))) return fail(req, 429, 'TOO_MANY_REQUESTS');

    const { data: p } = await db
      .from('payments')
      .select('id, client_id, method, provider, provider_payment_id, status, amount, refund_amount')
      .eq('id', paymentId)
      .maybeSingle();
    const { data: isAdmin } = await caller.client.rpc('is_admin');
    const owner = p?.client_id === caller.user.id;
    if (!p || (!owner && isAdmin !== true)) return fail(req, 404, 'NOT_FOUND');
    if (p.method !== 'online' || p.provider !== 'mercadopago' || !p.provider_payment_id) return fail(req, 409, 'NOT_ONLINE_PAYMENT');

    let amount: number;
    if (p.status === 'refund_pending') {
      amount = Number(p.refund_amount);
    } else if (p.status === 'approved' && isAdmin === true) {
      amount = Number(p.amount); // estorno total pela administração
    } else {
      return fail(req, 409, 'INVALID_STATUS');
    }
    if (!(amount > 0)) return fail(req, 409, 'NOTHING_TO_REFUND');

    const total = amount >= Number(p.amount) - 0.005;
    const cents = Math.round(amount * 100);
    try {
      await createRefund(p.provider_payment_id, total ? null : amount, `refund-${p.id}-${cents}`);
    } catch (err) {
      const code = err instanceof MpError ? err.message : 'error';
      await recordEvent(db, { source: 'refund', payment_id: p.id, provider_payment_id: p.provider_payment_id, outcome: 'refund_failed', detail: code });
      log('refund_failed', { payment_id: p.id, code });
      return fail(req, 502, 'REFUND_FAILED');
    }

    await db.from('payments').update({ refund_requested_at: new Date().toISOString() }).eq('id', p.id);
    await recordEvent(db, { source: 'refund', payment_id: p.id, provider_payment_id: p.provider_payment_id, outcome: 'refund_requested', detail: `${cents}` });

    // consulta o MP para gravar o estado real (o webhook também confirmará)
    try {
      await applyMpPayment(db, await getPayment(p.provider_payment_id), 'refund');
    } catch { /* o webhook confirma depois */ }

    const { data: fresh } = await db.from('payments').select('status, refund_amount').eq('id', p.id).single();
    return json(req, fresh ?? {});
  } catch (err) {
    if (err instanceof ConfigError) return fail(req, 503, 'ONLINE_PAYMENT_UNAVAILABLE');
    console.error('refund-payment', errCode(err));
    return fail(req, 500, 'INTERNAL_ERROR');
  }
});
