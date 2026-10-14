// Integração com o Mercado Pago (Checkout Pro + Payments API + Webhooks).
// Baseado na documentação oficial e no SDK oficial (mercadopago/sdk-nodejs):
//   - POST /checkout/preferences       cria a preferência do Checkout Pro
//   - GET  /v1/payments/{id}            consulta o pagamento (fonte da verdade)
//   - GET  /v1/payments/search          busca por external_reference
//   - POST /v1/payments/{id}/refunds    estorno total ou parcial
//   - Webhook: header x-signature "ts=...,v1=..." + x-request-id; manifesto
//     "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" assinado com HMAC-SHA256 (hex).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { env, isUuid, log } from './utils.ts';

const OFFICIAL_API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 8000;

export type MpEnv = 'test' | 'production';

export function mpConfig() {
  const mode = (Deno.env.get('MERCADOPAGO_ENV') ?? 'test').toLowerCase() as MpEnv;
  if (mode !== 'test' && mode !== 'production') throw new Error('MERCADOPAGO_ENV deve ser test ou production');
  // MERCADOPAGO_API_URL existe só para testes automatizados com um servidor simulado.
  // Em produção é ignorada: as chamadas vão sempre para a API oficial.
  const override = Deno.env.get('MERCADOPAGO_API_URL');
  return {
    mode,
    token: env('MERCADOPAGO_ACCESS_TOKEN'),
    apiBase: mode === 'production' || !override ? OFFICIAL_API : override.replace(/\/+$/, ''),
    requireLive: mode === 'production',
    maxInstallments: Math.min(Math.max(Number(Deno.env.get('MERCADOPAGO_MAX_INSTALLMENTS') ?? '1') || 1, 1), 12),
    statementDescriptor: (Deno.env.get('MERCADOPAGO_STATEMENT_DESCRIPTOR') ?? 'JHENBEAUTY').slice(0, 13),
  };
}

export class MpError extends Error {
  constructor(public status: number, public code: string) {
    super(`mercadopago_${status}_${code}`);
  }
}

async function mpFetch(path: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const cfg = mpConfig();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    'Content-Type': 'application/json',
  };
  if (init.idempotencyKey) headers['X-Idempotency-Key'] = init.idempotencyKey;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.apiBase}${path}`, { ...init, headers, signal: ctrl.signal });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch { /* corpo não-JSON */ }
    if (!res.ok) throw new MpError(res.status, String(body.error ?? body.message ?? 'error').slice(0, 60));
    return body;
  } catch (err) {
    if (err instanceof MpError) throw err;
    throw new MpError(0, err instanceof DOMException && err.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------- API
export const getPayment = (id: string) => mpFetch(`/v1/payments/${encodeURIComponent(id)}`, { method: 'GET' });

export async function searchPaymentsByReference(ref: string) {
  const q = new URLSearchParams({ external_reference: ref, sort: 'date_created', criteria: 'desc', limit: '10' });
  const body = await mpFetch(`/v1/payments/search?${q}`, { method: 'GET' });
  return Array.isArray(body.results) ? body.results as Record<string, unknown>[] : [];
}

export const createPreference = (pref: Record<string, unknown>, idempotencyKey: string) =>
  mpFetch('/checkout/preferences', { method: 'POST', body: JSON.stringify(pref), idempotencyKey });

/** Estorno: sem amount = total; com amount = parcial. */
export const createRefund = (mpPaymentId: string, amount: number | null, idempotencyKey: string) =>
  mpFetch(`/v1/payments/${encodeURIComponent(mpPaymentId)}/refunds`, {
    method: 'POST',
    body: JSON.stringify(amount == null ? {} : { amount: Math.round(amount * 100) / 100 }),
    idempotencyKey,
  });

/** Formato de data aceito pelo MP: 2026-10-12T15:04:05.000-03:00 */
export function mpDate(d: Date): string {
  const local = new Date(d.getTime() - 3 * 3600_000); // America/Sao_Paulo (sem horário de verão desde 2019)
  return local.toISOString().replace('Z', '-03:00');
}

/** O link do checkout precisa ser do próprio Mercado Pago (evita redirecionar para outro site). */
export function isCheckoutUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    const cfg = mpConfig();
    if (cfg.mode !== 'production' && Deno.env.get('MERCADOPAGO_API_URL')) return u.protocol === 'https:' || u.protocol === 'http:';
    return u.protocol === 'https:' && /(^|\.)(mercadopago|mercadolivre|mercadolibre)\.com(\.br)?$/i.test(u.hostname);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------- assinatura do webhook
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Valida a assinatura exatamente como o SDK oficial (utils/webhook):
 * partes "id:<dataId>", "request-id:<xRequestId>" (só se presentes) e "ts:<ts>",
 * unidas por ";" com ";" final; HMAC-SHA256 em hexadecimal minúsculo; comparação em tempo constante.
 */
export async function validSignature(
  xSignature: string | null,
  xRequestId: string | null,
  dataId: string | null,
  secret: string,
): Promise<boolean> {
  if (!xSignature) return false;
  let ts = '';
  let v1 = '';
  for (const part of xSignature.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k === 'ts') ts = v;
    if (k === 'v1') v1 = v;
  }
  if (!ts || !/^\d+$/.test(ts) || !v1) return false;
  const parts: string[] = [];
  // a documentação pede o data.id em minúsculas quando alfanumérico (IDs de pagamento são numéricos)
  if (dataId?.trim()) parts.push(`id:${dataId.trim().toLowerCase()}`);
  if (xRequestId?.trim()) parts.push(`request-id:${xRequestId.trim()}`);
  parts.push(`ts:${ts}`);
  const expected = await hmacSha256Hex(secret, `${parts.join(';')};`);
  return timingSafeEqual(expected, v1);
}

// ----------------------------------------------------------------------- aplicação do estado
type Db = SupabaseClient;

export async function recordEvent(db: Db, row: Record<string, unknown>) {
  const { error } = await db.from('payment_events').insert({ provider: 'mercadopago', ...row });
  if (error && error.code !== '23505') console.error('payment_events insert', error.code);
  return !error;
}

/**
 * Aplica no banco um pagamento CONSULTADO na API do Mercado Pago.
 * Devolve o resultado do banco e faz estorno automático quando necessário
 * (pagamento duplicado, valor divergente, horário que não pôde ser confirmado).
 */
export async function applyMpPayment(db: Db, mp: Record<string, unknown>, source: 'webhook' | 'sync' | 'refund') {
  const ref = mp.external_reference;
  const mpId = String(mp.id ?? '');
  if (!isUuid(ref)) return { outcome: 'unknown_reference', mpId };

  const refunds = Array.isArray(mp.refunds) ? mp.refunds as Array<Record<string, unknown>> : [];
  const refunded = Number(mp.transaction_amount_refunded ?? refunds.reduce((s, r) => s + Number(r.amount ?? 0), 0)) || 0;
  const card = (mp.card ?? {}) as Record<string, unknown>;
  const cfg = mpConfig();

  const { data, error } = await db.rpc('apply_gateway_payment', {
    p_payment_id: ref,
    p_provider: 'mercadopago',
    p_provider_payment_id: mpId,
    p_status: String(mp.status ?? ''),
    p_status_detail: mp.status_detail ? String(mp.status_detail) : null,
    p_amount: Number(mp.transaction_amount ?? 0),
    p_currency: String(mp.currency_id ?? ''),
    p_payment_type: mp.payment_type_id ? String(mp.payment_type_id) : null,
    p_payment_method_id: mp.payment_method_id ? String(mp.payment_method_id) : null,
    p_last_four: typeof card.last_four_digits === 'string' ? card.last_four_digits : null,
    p_live_mode: typeof mp.live_mode === 'boolean' ? mp.live_mode : null,
    p_updated_at: mp.date_last_updated ?? null,
    p_approved_at: mp.date_approved ?? null,
    p_refunded_amount: refunded,
    p_require_live: cfg.requireLive,
  });
  if (error) throw error;
  const result = data as Record<string, unknown>;

  if (result.refund_required && result.refund_provider_payment_id) {
    await autoRefund(db, String(result.refund_provider_payment_id), ref, result.outcome === 'applied' ? String(ref) : null);
  }
  log('payment_applied', { source, mp_payment_id: mpId, outcome: result.outcome, status: result.status ?? null });
  return result;
}

/** Estorno automático (integral) de um pagamento que não pode ser honrado. Idempotente. */
async function autoRefund(db: Db, mpPaymentId: string, localPaymentId: string, markLocal: string | null) {
  try {
    await createRefund(mpPaymentId, null, `auto-refund-${mpPaymentId}`);
    if (markLocal) await db.from('payments').update({ refund_requested_at: new Date().toISOString() }).eq('id', markLocal);
    await recordEvent(db, { source: 'refund', provider_payment_id: mpPaymentId, payment_id: localPaymentId, outcome: 'auto_refund_requested' });
  } catch (err) {
    const code = err instanceof MpError ? err.message : 'error';
    await recordEvent(db, { source: 'refund', provider_payment_id: mpPaymentId, payment_id: localPaymentId, outcome: 'auto_refund_failed', detail: code });
    log('auto_refund_failed', { mp_payment_id: mpPaymentId, code });
  }
}
