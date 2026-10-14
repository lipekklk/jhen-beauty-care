// =============================================================================
// Edge Function: payment-webhook
// Recebe as notificações (Webhooks) do Mercado Pago.
//
// Nunca confia no conteúdo da notificação:
//  1. valida a assinatura x-signature (HMAC-SHA256 com a chave secreta do webhook);
//  2. valida o formato do evento e do ID;
//  3. ignora entregas repetidas (x-request-id já processado);
//  4. CONSULTA o pagamento na API do Mercado Pago (fonte da verdade);
//  5. aplica no banco via apply_gateway_payment (confere valor, moeda, referência,
//     ordem dos eventos e duplicidade) — só então o horário é confirmado;
//  6. responde 200 rápido; erros temporários respondem 500 para o MP tentar de novo.
//
// Publicar SEM verificação de JWT (o Mercado Pago não envia JWT do Supabase):
//   supabase functions deploy payment-webhook --no-verify-jwt
// Secrets: MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_WEBHOOK_SECRET, MERCADOPAGO_ENV
// =============================================================================
import { adminClient, ConfigError, env, log, errCode } from '../_shared/utils.ts';
import { applyMpPayment, getPayment, MpError, recordEvent, validSignature } from '../_shared/mercadopago.ts';

const text = (status: number, body: string) => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return text(405, 'method not allowed');

  try {
    const secret = env('MERCADOPAGO_WEBHOOK_SECRET');
    const url = new URL(req.url);
    const raw = await req.text();
    if (raw.length > 16_384) return text(413, 'payload too large');
    let body: Record<string, unknown> = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return text(400, 'invalid json');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return text(400, 'invalid body');

    const xSignature = req.headers.get('x-signature');
    const xRequestId = req.headers.get('x-request-id');
    // o SDK oficial lê data.id da URL; o corpo é usado só como alternativa
    const data = (body.data ?? {}) as Record<string, unknown>;
    const dataId = url.searchParams.get('data.id') ?? (data.id != null ? String(data.id) : null);
    const type = url.searchParams.get('type') ?? (typeof body.type === 'string' ? body.type : null);

    // 1. autenticidade (notificações IPN antigas, sem assinatura válida, são recusadas)
    if (!(await validSignature(xSignature, xRequestId, dataId, secret))) {
      log('webhook_invalid_signature', { has_signature: Boolean(xSignature), has_request_id: Boolean(xRequestId) });
      return text(401, 'invalid signature');
    }

    const db = adminClient();
    const requestId = xRequestId ? xRequestId.slice(0, 100) : null;
    const base = {
      source: 'webhook',
      request_id: requestId,
      notification_id: body.id != null ? String(body.id).slice(0, 60) : null,
      action: typeof body.action === 'string' ? body.action.slice(0, 60) : null,
    };

    // 2. só eventos de pagamento interessam
    if (type !== 'payment') {
      await recordEvent(db, { ...base, outcome: 'ignored_type', detail: String(type ?? '').slice(0, 40) });
      return text(200, 'ignored');
    }
    if (!dataId || !/^\d{1,20}$/.test(dataId)) {
      await recordEvent(db, { ...base, outcome: 'invalid_id' });
      return text(400, 'invalid id');
    }

    // 3. entrega repetida: já processada com sucesso
    if (requestId) {
      const { data: seen } = await db.from('payment_events').select('id')
        .eq('provider', 'mercadopago').eq('source', 'webhook').eq('request_id', requestId).maybeSingle();
      if (seen) return text(200, 'duplicate');
    }

    // 4. fonte da verdade: API do Mercado Pago
    let mp: Record<string, unknown>;
    try {
      mp = await getPayment(dataId);
    } catch (err) {
      if (err instanceof MpError && err.status === 404) {
        await recordEvent(db, { ...base, provider_payment_id: dataId, outcome: 'payment_not_found' });
        return text(200, 'not found'); // não adianta o MP reenviar
      }
      log('webhook_fetch_failed', { mp_payment_id: dataId, code: err instanceof MpError ? err.message : 'error' });
      return text(500, 'retry'); // instabilidade: o MP reenvia a notificação
    }

    // 5. aplica (idempotente) — confirma o horário só se aprovado e válido
    const result = await applyMpPayment(db, mp, 'webhook');
    await recordEvent(db, {
      ...base,
      provider_payment_id: dataId,
      payment_id: typeof result.payment_id === 'string' ? result.payment_id : null,
      outcome: String(result.outcome ?? 'unknown'),
      detail: result.status ? String(result.status) : null,
    });
    return text(200, 'ok');
  } catch (err) {
    if (err instanceof ConfigError) {
      log('config_missing', { variable: err.variable });
      return text(503, 'not configured');
    }
    console.error('payment-webhook', errCode(err));
    return text(500, 'retry');
  }
});
