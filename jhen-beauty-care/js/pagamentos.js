/**
 * Fluxo de pagamento online.
 *
 *  - settings.payment_provider = 'sandbox'     → simulação (desenvolvimento/demonstração)
 *  - settings.payment_provider = 'mercadopago' → Edge Function "create-payment" (segredo do gateway
 *                                                fica no servidor). PIX: QR Code na tela.
 *                                                Cartão: redireciona ao Checkout do Mercado Pago.
 *
 * Este arquivo NUNCA recebe nem envia número de cartão/CVV.
 * A confirmação oficial do pagamento chega pelo webhook (Edge Function "payment-webhook").
 */
import { supabase } from './supabase.js';
import { getSettings } from './data.js';
import { esc, fmtMoney, errorMessage, url, METHOD_LABELS } from './utils.js';
import { openModal, toast, withLoading } from './ui.js';
import { icon } from './icons.js';

const POLL_MS = 4000;

/** Consulta o status atual de um pagamento (RLS: só o dono ou admin). */
export async function getPaymentStatus(paymentId) {
  const { data, error } = await supabase
    .from('payments')
    .select('id, status, appointment:appointments(status)')
    .eq('id', paymentId)
    .single();
  if (error) throw error;
  return data;
}

function countdown(el, expiresAt, onEnd) {
  if (!expiresAt || !el) return () => {};
  const end = new Date(expiresAt).getTime();
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (!left) { clearInterval(timer); onEnd?.(); }
  };
  const timer = setInterval(tick, 1000);
  tick();
  return () => clearInterval(timer);
}

/**
 * Abre o fluxo de pagamento. Resolve com:
 *  'approved' | 'rejected' | 'pending' (fechou sem concluir) | 'expired' | 'redirect'
 */
export async function processPayment({ paymentId, method, amount, expiresAt, description = '' }) {
  const settings = await getSettings();
  if (settings.payment_provider === 'sandbox') return sandboxFlow({ paymentId, method, amount, expiresAt, description });
  return gatewayFlow({ paymentId, method, amount, expiresAt, description });
}

/* ------------------------------------------------------------------ sandbox */
function sandboxFlow({ paymentId, method, amount, expiresAt, description }) {
  return new Promise((resolve) => {
    let result = 'pending';
    const body = `
      <div class="alert alert--warning" style="margin-bottom:var(--space-5)">${icon('info')}
        <p><strong>Modo de teste.</strong> Nenhuma cobrança real é feita. Em produção, este passo usa o Mercado Pago.</p></div>
      ${method === 'pix' ? `
        <div class="pix-box">
          <div class="pix-qr" aria-hidden="true"><img src="${url('assets/logo/monograma-j-vinho.png')}" alt="" style="width:60%;height:auto;image-rendering:auto"></div>
          <div>
            <p>Pague <strong>${fmtMoney(amount)}</strong> com PIX${description ? ` para <strong>${esc(description)}</strong>` : ''}.</p>
            <div class="field"><label for="pix-code">PIX copia e cola (exemplo)</label>
              <div class="copy-field"><input class="input" id="pix-code" readonly value="00020126-SANDBOX-JHEN-${esc(paymentId.slice(0, 8))}">
              <button type="button" class="btn btn--outline btn--sm" data-copy>${icon('copy')} Copiar</button></div></div>
          </div>
        </div>` : `
        <p>Pague <strong>${fmtMoney(amount)}</strong> com cartão${description ? ` para <strong>${esc(description)}</strong>` : ''}.</p>
        <p class="muted">Em produção você será levada ao checkout seguro do Mercado Pago para digitar os dados do cartão. Eles nunca passam por este site.</p>`}
      ${expiresAt ? `<p class="muted" style="margin-top:var(--space-4)">Seu horário fica reservado por <span class="countdown" data-countdown>--:--</span>.</p>` : ''}`;
    const footer = document.createElement('div');
    footer.style.display = 'contents';
    footer.innerHTML = `
      <button type="button" class="btn btn--ghost" data-act="fail">Simular falha</button>
      <button type="button" class="btn" data-act="ok">${icon('check')} Simular pagamento aprovado</button>`;
    const m = openModal({ title: `Pagamento com ${METHOD_LABELS[method]}`, body, footer, onClose: () => { stop(); resolve(result); } });
    const stop = countdown(m.el.querySelector('[data-countdown]'), expiresAt, () => { result = 'expired'; m.close(); });
    m.el.querySelector('[data-copy]')?.addEventListener('click', () => copy(m.el.querySelector('#pix-code').value));

    const run = (approve) => async (e) => {
      await withLoading(e.currentTarget, async () => {
        try {
          const { data, error } = await supabase.rpc('simulate_payment', { p_payment_id: paymentId, p_approve: approve });
          if (error) throw error;
          result = data;
          m.close();
        } catch (err) {
          toast({ type: 'error', message: errorMessage(err, 'Não foi possível concluir o pagamento. Tente novamente.') });
          if (/PAYMENT_EXPIRED/.test(err.message)) { result = 'expired'; m.close(); }
        }
      }, 'Processando…');
    };
    footer.querySelector('[data-act="ok"]').addEventListener('click', run(true));
    footer.querySelector('[data-act="fail"]').addEventListener('click', run(false));
  });
}

/* ------------------------------------------------------------------ gateway real */
async function gatewayFlow({ paymentId, method, amount, expiresAt, description }) {
  const { data, error } = await supabase.functions.invoke('create-payment', { body: { payment_id: paymentId } });
  if (error || !data) {
    toast({ type: 'error', message: 'Não foi possível iniciar o pagamento. Tente novamente.' });
    return 'rejected';
  }
  if (data.type === 'redirect' && data.url) {
    // Cartão: checkout hospedado pelo gateway (dados do cartão ficam lá)
    location.href = data.url;
    return 'redirect';
  }
  if (data.type !== 'pix') return 'rejected';

  return new Promise((resolve) => {
    let result = 'pending';
    const body = `
      <div class="pix-box">
        <div class="pix-qr">${data.qr_code_base64 ? `<img src="data:image/png;base64,${esc(data.qr_code_base64)}" alt="QR Code PIX para pagamento de ${fmtMoney(amount)}">` : icon('pix')}</div>
        <div>
          <p>Escaneie o QR Code ou use o PIX copia e cola para pagar <strong>${fmtMoney(amount)}</strong>${description ? ` (${esc(description)})` : ''}.</p>
          <div class="field"><label for="pix-code">PIX copia e cola</label>
            <div class="copy-field"><input class="input" id="pix-code" readonly value="${esc(data.qr_code || '')}">
            <button type="button" class="btn btn--outline btn--sm" data-copy>${icon('copy')} Copiar</button></div></div>
          <p class="muted" role="status"><span class="spinner" style="width:14px;height:14px;vertical-align:-2px"></span> Aguardando confirmação do pagamento…</p>
          ${expiresAt ? `<p class="muted">Reserva válida por <span class="countdown" data-countdown>--:--</span>.</p>` : ''}
        </div>
      </div>`;
    const m = openModal({ title: 'Pagamento com PIX', body, onClose: () => { clearInterval(poll); stop(); resolve(result); } });
    const stop = countdown(m.el.querySelector('[data-countdown]'), expiresAt, () => { result = 'expired'; m.close(); });
    m.el.querySelector('[data-copy]').addEventListener('click', () => copy(data.qr_code));
    const poll = setInterval(async () => {
      try {
        const p = await getPaymentStatus(paymentId);
        if (p.status === 'approved') { result = 'approved'; m.close(); }
        else if (p.status === 'rejected') { result = 'rejected'; m.close(); }
        else if (p.appointment?.status === 'cancelled') { result = 'expired'; m.close(); }
      } catch { /* tenta de novo no próximo ciclo */ }
    }, POLL_MS);
  });
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ type: 'success', message: 'Código PIX copiado.' });
  } catch {
    toast({ type: 'warning', message: 'Não foi possível copiar. Selecione o código e copie manualmente.' });
  }
}

/** Mensagens padronizadas para o resultado do pagamento. */
export const PAYMENT_RESULT_MESSAGES = {
  approved: { type: 'success', message: 'Pagamento aprovado.' },
  rejected: { type: 'error', message: 'Não foi possível concluir o pagamento. Tente novamente.' },
  expired: { type: 'warning', message: 'O tempo para pagamento acabou e o horário foi liberado. Faça um novo agendamento.' },
  pending: { type: 'info', message: 'Pagamento não concluído. Seu horário fica reservado por alguns minutos: pague em "Meus agendamentos".' },
};
