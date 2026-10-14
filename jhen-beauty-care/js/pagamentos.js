/**
 * Pagamento online pelo Checkout Pro do Mercado Pago.
 *
 * O navegador NUNCA recebe nem envia dados de cartão, valores ou status:
 *  - startCheckout()  → pede ao servidor (Edge Function create-payment) o link oficial do
 *                       Mercado Pago para um pagamento JÁ registrado no banco, e redireciona;
 *  - syncPayment()    → pede ao servidor para consultar o Mercado Pago e devolver o status real;
 *  - requestRefund()  → pede ao servidor o estorno (o valor é calculado no banco).
 * A confirmação oficial chega pelo webhook (Edge Function payment-webhook).
 */
import { supabase } from './supabase.js';
import { getSettings } from './data.js';
import { errorMessage } from './utils.js';

/** Chama uma Edge Function e converte erros em códigos conhecidos (ex.: PAYMENT_EXPIRED). */
async function callFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return data;
  let code = 'GATEWAY_UNAVAILABLE';
  try {
    const ctx = error.context;
    const payload = ctx && typeof ctx.json === 'function' ? await ctx.json() : null;
    if (payload?.error) code = payload.error;
    else if (ctx?.status === 401) code = 'NOT_AUTHENTICATED';
  } catch { /* corpo ilegível: mantém o código genérico */ }
  if (/Failed to fetch|NetworkError|FunctionsFetchError/i.test(`${error.name} ${error.message}`)) code = 'GATEWAY_UNAVAILABLE';
  throw new Error(code);
}

/** Pagamento online ligado pela administração (Mercado Pago configurado). */
export async function onlinePaymentEnabled() {
  try {
    return (await getSettings()).payment_provider === 'mercadopago';
  } catch {
    return false;
  }
}

/**
 * Leva a cliente ao checkout seguro do Mercado Pago.
 * Resolve só em caso de erro (em sucesso a página é redirecionada).
 */
export async function startCheckout(paymentId) {
  const data = await callFunction('create-payment', { payment_id: paymentId });
  if (!data?.url || !/^https?:\/\//.test(data.url)) throw new Error('GATEWAY_UNAVAILABLE');
  location.assign(data.url);
  return new Promise(() => {}); // mantém o botão em "Preparando pagamento seguro…" até sair da página
}

/** Consulta o status real (o servidor fala com o Mercado Pago). */
export const syncPayment = (paymentId, mpPaymentId = null) =>
  callFunction('sync-payment', mpPaymentId ? { payment_id: paymentId, mp_payment_id: mpPaymentId } : { payment_id: paymentId });

/** Solicita o estorno ao Mercado Pago (valor definido no banco). */
export const requestRefund = (paymentId) => callFunction('refund-payment', { payment_id: paymentId });

/** Mensagem amigável para falhas no início do checkout. */
export const checkoutErrorMessage = (err) =>
  errorMessage(err, 'Não foi possível abrir o pagamento agora. Tente novamente em instantes.');
