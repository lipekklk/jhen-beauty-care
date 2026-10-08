// =============================================================================
// Edge Function: payment-webhook
// Recebe as notificações do Mercado Pago, VALIDA a assinatura, consulta o pagamento
// na API do Mercado Pago (nunca confia no corpo da notificação) e atualiza o banco
// via public.apply_payment_update (executável apenas com service_role).
//
// Publique SEM verificação de JWT (o Mercado Pago não envia JWT do Supabase):
//   supabase functions deploy payment-webhook --no-verify-jwt
// Secrets: MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET
// =============================================================================
import { adminClient, env } from '../_shared/utils.ts';

const MP_API = Deno.env.get('MP_API_URL') ?? 'https://api.mercadopago.com';

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Valida o header x-signature conforme a documentação do Mercado Pago. */
async function validSignature(req: Request, dataId: string): Promise<boolean> {
  const header = req.headers.get('x-signature') ?? '';
  const requestId = req.headers.get('x-request-id') ?? '';
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=') as [string, string]));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = await hmacHex(env('MP_WEBHOOK_SECRET'), manifest);
  return safeEqual(expected, parts.v1);
}

const STATUS_MAP: Record<string, string> = {
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'rejected',
  refunded: 'refunded',
  charged_back: 'refunded',
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const type = url.searchParams.get('type') ?? body.type;
  const dataId = String(url.searchParams.get('data.id') ?? body?.data?.id ?? '');

  if (type !== 'payment' || !dataId) return new Response('ignored', { status: 200 });
  if (!(await validSignature(req, dataId))) {
    console.warn('Assinatura inválida', dataId);
    return new Response('invalid signature', { status: 401 });
  }

  try {
    // Fonte da verdade: API do Mercado Pago
    const res = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(dataId)}`, {
      headers: { Authorization: `Bearer ${env('MP_ACCESS_TOKEN')}` },
    });
    if (!res.ok) {
      console.error('MP get payment', res.status);
      return new Response('retry', { status: 500 }); // o MP reenvia
    }
    const mp = await res.json();
    const paymentId = mp.external_reference as string | undefined;
    const status = STATUS_MAP[mp.status as string];
    if (!paymentId || !status) return new Response('ok'); // pendente/em análise: aguarda próxima notificação

    const db = adminClient();
    const { data: local } = await db.from('payments').select('id, amount').eq('id', paymentId).single();
    if (!local) return new Response('unknown reference', { status: 200 });

    // Proteção: não aprova se o valor pago for menor que o cobrado
    if (status === 'approved' && Number(mp.transaction_amount) + 0.001 < Number(local.amount)) {
      console.error('Valor divergente', paymentId, mp.transaction_amount, local.amount);
      return new Response('amount mismatch', { status: 200 });
    }

    const { error } = await db.rpc('apply_payment_update', {
      p_payment_id: paymentId,
      p_status: status,
      p_provider: 'mercadopago',
      p_provider_payment_id: String(mp.id),
      p_provider_transaction_id: mp.transaction_details?.transaction_id ?? mp.authorization_code ?? null,
    });
    if (error) {
      console.error('apply_payment_update', error);
      return new Response('retry', { status: 500 });
    }
    return new Response('ok');
  } catch (err) {
    console.error(err);
    return new Response('retry', { status: 500 });
  }
});
