/**
 * Página de retorno do Checkout Pro (pagamento.html).
 *
 * Os parâmetros que o Mercado Pago coloca na URL (status, payment_id...) podem ser
 * alterados por qualquer pessoa, então NÃO decidem nada aqui. A página:
 *  1. exige login e só aceita o pagamento da própria cliente (RLS);
 *  2. pede ao servidor para consultar o Mercado Pago (sync-payment);
 *  3. mostra o status gravado no banco — o mesmo que libera (ou não) o horário.
 */
import { renderPublicHeader, renderPublicFooter } from './layout.js';
import { requireRole } from './auth.js';
import { supabase } from './supabase.js';
import { syncPayment, startCheckout, checkoutErrorMessage } from './pagamentos.js';
import { esc, url, getParam, fmtMoney, fmtDateLong, fmtTime, errorMessage, paymentMethodLabel } from './utils.js';
import { toast, withLoading, errorHTML } from './ui.js';
import { icon } from './icons.js';
import { getSettings } from './data.js';

const box = document.getElementById('pay-result');
const ref = getParam('ref');
// dica opcional: o ID que o MP anexa à URL. O servidor confere se pertence a este pagamento.
const mpHint = [getParam('payment_id'), getParam('collection_id')].find((v) => v && /^\d{1,20}$/.test(v)) || null;
const returnedAs = getParam('r'); // success | pending | failure (apenas para o texto, nunca para liberar algo)
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '');

const POLL_MS = 6000;
const POLL_MAX = 25; // ~2,5 min acompanhando um pagamento em processamento
let polls = 0;

async function loadPurchase() {
  const { data, error } = await supabase.from('purchases').select('*').eq('id', ref).maybeSingle();
  if (error) throw error;
  return data;
}

function canRetry(p) {
  return p.appointment_status === 'pending_payment' && ['pending', 'rejected'].includes(p.status)
    && p.checkout_expires_at && new Date(p.checkout_expires_at) > new Date(Date.now() + 60_000);
}

function summaryHTML(p) {
  return `
    <dl class="kv pay-result__details">
      <dt>Procedimento</dt><dd>${esc(p.product_name)}</dd>
      <dt>Data</dt><dd>${esc(fmtDateLong(p.appointment_starts_at))}, às ${fmtTime(p.appointment_starts_at)}</dd>
      <dt>Valor</dt><dd>${fmtMoney(p.amount)}${p.kind === 'deposit' ? ' (sinal)' : ''}</dd>
      ${p.payment_type ? `<dt>Forma</dt><dd>${esc(paymentMethodLabel(p))}</dd>` : ''}
      ${p.mercadopago_payment_id ? `<dt>Transação</dt><dd>Mercado Pago nº ${esc(p.mercadopago_payment_id)}</dd>` : ''}
    </dl>`;
}

function view({ tone, iconName, title, text, p, actions = '' }) {
  box.innerHTML = `
    <div class="success-mark pay-result__mark pay-result__mark--${tone}">${icon(iconName)}</div>
    <h1 id="pay-title" class="pay-result__title">${esc(title)}</h1>
    <p class="muted pay-result__text">${esc(text)}</p>
    ${p ? summaryHTML(p) : ''}
    <div class="actions pay-result__actions">${actions}</div>
    <p class="pay-result__mp">${icon('lock')} Pagamento processado pelo Mercado Pago</p>`;
  box.querySelector('h1')?.focus?.();
}

const btnPurchases = `<a class="btn" href="${url('cliente/compras.html')}">Ver minhas compras</a>`;
const btnAppointments = `<a class="btn btn--outline" href="${url('cliente/agendamentos.html')}">Meus agendamentos</a>`;
const btnNew = `<a class="btn btn--outline" href="${url('agendamento.html')}">Fazer novo agendamento</a>`;

function bindRetry(p) {
  box.querySelector('[data-retry]')?.addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    try {
      await startCheckout(p.id);
    } catch (err) {
      toast({ type: 'error', message: checkoutErrorMessage(err) });
      refresh(false);
    }
  }, 'Preparando pagamento seguro…'));
}

function render(p) {
  const retry = canRetry(p)
    ? `<button class="btn" type="button" data-retry>${icon('lock')} Tentar novamente</button>` : '';
  const aborted = p.status === 'pending' && !p.mercadopago_payment_id;

  if (p.access_granted && ['approved', 'refunded'].includes(p.status) && Number(p.refund_amount) < Number(p.amount)) {
    view({
      tone: 'ok', iconName: 'check', p,
      title: 'Pagamento aprovado! Seu horário está confirmado.',
      text: 'Enviamos a confirmação para a sua área. Te esperamos!',
      actions: `${btnAppointments.replace('btn--outline', '')}${btnPurchases.replace('class="btn"', 'class="btn btn--outline"')}`,
    });
    return 'final';
  }
  if (['pending', 'in_process'].includes(p.status) && !(aborted && returnedAs === 'failure')
      && (p.mercadopago_payment_id || returnedAs === 'pending' || returnedAs === 'success')) {
    view({
      tone: 'wait', iconName: 'clock', p,
      title: 'Seu pagamento ainda está sendo processado.',
      text: p.status === 'in_process'
        ? 'O Mercado Pago está analisando o pagamento. Assim que for confirmado, seu horário será confirmado automaticamente.'
        : 'Assim que for confirmado, seu horário será confirmado automaticamente. Se você pagou com Pix, isso costuma levar poucos segundos.',
      actions: `${btnPurchases}`,
    });
    return 'waiting';
  }
  if (p.status === 'rejected') {
    view({
      tone: 'error', iconName: 'error', p,
      title: 'Não foi possível confirmar o pagamento.',
      text: retry ? 'Você pode tentar novamente com outra forma de pagamento enquanto o horário estiver reservado.'
        : 'O prazo da reserva terminou e o horário foi liberado. Você pode fazer um novo agendamento.',
      actions: retry || btnNew,
    });
    bindRetry(p);
    return 'final';
  }
  if (aborted && returnedAs !== 'failure' && retry) {
    view({
      tone: 'wait', iconName: 'clock', p,
      title: 'Seu horário está reservado, falta o pagamento.',
      text: 'Conclua o pagamento no Mercado Pago para confirmar o horário antes que a reserva expire.',
      actions: retry.replace('Tentar novamente', 'Pagar agora'),
    });
    bindRetry(p);
    return 'final';
  }
  if (aborted || p.status === 'cancelled' || p.appointment_status === 'cancelled') {
    if (['refund_pending', 'refunded'].includes(p.status)) {
      view({
        tone: 'info', iconName: 'refresh', p,
        title: 'Pagamento estornado.',
        text: 'O horário não pôde ser mantido e o valor está sendo devolvido pelo Mercado Pago, pela mesma forma de pagamento.',
        actions: btnPurchases,
      });
      return 'final';
    }
    view({
      tone: 'info', iconName: 'close', p,
      title: 'O pagamento foi cancelado.',
      text: retry ? 'Você pode retornar e tentar novamente quando quiser, enquanto o horário estiver reservado.'
        : 'Você pode fazer um novo agendamento quando quiser.',
      actions: retry ? `${retry}${btnPurchases.replace('class="btn"', 'class="btn btn--ghost"')}` : btnNew,
    });
    bindRetry(p);
    return 'final';
  }
  if (['refund_pending', 'refunded'].includes(p.status)) {
    view({ tone: 'info', iconName: 'refresh', p, title: 'Pagamento estornado.', text: 'O valor está sendo devolvido pelo Mercado Pago, pela mesma forma de pagamento.', actions: btnPurchases });
    return 'final';
  }
  view({
    tone: 'info', iconName: 'alert', p,
    title: 'Há uma pendência com este pagamento.',
    text: 'Fale com o estúdio pelo WhatsApp para resolver.',
    actions: btnPurchases,
  });
  return 'final';
}

async function refresh(sync = true) {
  try {
    if (sync) {
      try { await syncPayment(ref, polls === 0 ? mpHint : null); } catch { /* o webhook confirma depois */ }
    }
    const p = await loadPurchase();
    if (!p) {
      box.innerHTML = errorHTML('Não encontramos este pagamento na sua conta.');
      return;
    }
    const state = render(p);
    if (state === 'waiting' && polls < POLL_MAX) {
      polls += 1;
      setTimeout(() => refresh(polls % 3 === 0), POLL_MS); // consulta o MP a cada 3 ciclos; nos outros, só o banco
    }
  } catch (err) {
    box.innerHTML = errorHTML(errorMessage(err, 'Não foi possível consultar o pagamento agora.'), 'retry-load');
    document.getElementById('retry-load')?.addEventListener('click', () => refresh(true));
  }
}

(async () => {
  renderPublicHeader('pagamento');
  renderPublicFooter();
  if (!isUuid(ref)) {
    box.innerHTML = errorHTML('Link de pagamento inválido.');
    return;
  }
  try {
    await requireRole(['client', 'admin', 'employee']);
  } catch { return; }
  await getSettings().catch(() => {});
  refresh(true);
})();
