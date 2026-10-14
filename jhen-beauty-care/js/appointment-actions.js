/**
 * Ações sobre um agendamento, reutilizadas pela área da cliente e pelo admin:
 * detalhes, cancelar (com política), remarcar, pagar reserva pendente e avaliar.
 * Cada ação devolve true quando alterou algo (para a tela recarregar).
 */
import { supabase } from './supabase.js';
import { cancellationQuote, cancelAppointment, rescheduleAppointment } from './data.js';
import { createDateTimePicker } from './calendar.js';
import { startCheckout, requestRefund, checkoutErrorMessage } from './pagamentos.js';
import {
  esc, fmtMoney, fmtDuration, fmtDateLong, fmtTime, fmtDateTime, statusBadge, paymentSummary, paymentBadge,
  KIND_LABELS, errorMessage, paymentMethodLabel, url,
} from './utils.js';
import { openModal, confirmDialog, toast, withLoading } from './ui.js';
import { icon } from './icons.js';

export const isUpcoming = (a) => ['pending_payment', 'scheduled', 'confirmed'].includes(a.status) && new Date(a.ends_at) > new Date();
/** Reserva aguardando pagamento online, ainda dentro do prazo. */
const payablePayment = (a) => (a.payments || []).find((p) => ['pending', 'rejected'].includes(p.status)
  && ['online', 'pix', 'card'].includes(p.method)
  && (!p.checkout_expires_at || new Date(p.checkout_expires_at) > new Date(Date.now() + 60_000)));
export const canPay = (a) => a.status === 'pending_payment' && Boolean(payablePayment(a));

/* ------------------------------------------------------------------ detalhes */
export function showDetails(a, { onAction } = {}) {
  const pay = paymentSummary(a.payments);
  const body = `
    <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;margin-bottom:var(--space-4)">${statusBadge(a.status)}<span class="badge status--${esc(pay.status)}">${esc(pay.label)}</span></div>
    <dl class="kv">
      <dt>Procedimento</dt><dd>${esc(a.service?.name || '—')}</dd>
      <dt>Profissional</dt><dd>${esc(a.employee?.display_name || '—')}</dd>
      <dt>Data</dt><dd>${esc(fmtDateLong(a.starts_at))}</dd>
      <dt>Horário</dt><dd>${fmtTime(a.starts_at)} às ${fmtTime(a.ends_at)} (${fmtDuration(a.service?.duration_minutes)})</dd>
      <dt>Valor</dt><dd>${fmtMoney(a.price)}</dd>
      <dt>Pago</dt><dd>${fmtMoney(pay.paid)}</dd>
      ${a.notes ? `<dt>Observações</dt><dd>${esc(a.notes)}</dd>` : ''}
      ${a.status === 'cancelled' && a.cancel_reason ? `<dt>Motivo</dt><dd>${esc(a.cancel_reason)}</dd>` : ''}
      ${Number(a.cancellation_fee) > 0 ? `<dt>Taxa de cancelamento</dt><dd>${fmtMoney(a.cancellation_fee)}</dd>` : ''}
    </dl>
    ${(a.payments || []).length ? `
      <h3 style="font-size:var(--fs-lg);margin-top:var(--space-5)">Pagamentos</h3>
      <ul class="notif-list">${a.payments.map((p) => `
        <li class="notif"><div><strong>${fmtMoney(p.amount)} · ${esc(paymentMethodLabel(p))} · ${KIND_LABELS[p.kind]}</strong>
        <p>${paymentBadge(p.status)} ${p.paid_at ? `pago em ${fmtDateTime(p.paid_at)}` : ''}
        ${p.provider_payment_id && p.method !== 'on_site' ? `<br><span class="muted">Transação Mercado Pago nº ${esc(p.provider_payment_id)}</span>` : ''}</p></div></li>`).join('')}</ul>` : ''}`;
  const footer = document.createElement('div');
  footer.style.display = 'contents';
  const buttons = [];
  if (canPay(a)) buttons.push('<button class="btn" data-act="pay">Pagar agora</button>');
  if (['scheduled', 'confirmed'].includes(a.status) && new Date(a.starts_at) > new Date()) buttons.push('<button class="btn btn--outline" data-act="reschedule">Remarcar</button>');
  if (isUpcoming(a)) buttons.push('<button class="btn btn--ghost" data-act="cancel">Cancelar</button>');
  footer.innerHTML = buttons.join('') || '<button class="btn btn--ghost" data-close-modal>Fechar</button>';
  const m = openModal({ title: 'Detalhes do agendamento', body, footer });
  footer.querySelector('[data-close-modal]')?.addEventListener('click', () => m.close());
  footer.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => { m.close(); onAction?.(b.dataset.act); }));
}

/* ------------------------------------------------------------------ cancelar */
export async function cancelFlow(a, { staff = false } = {}) {
  let quote;
  try {
    quote = await cancellationQuote(a.id);
  } catch (err) {
    toast({ type: 'error', message: errorMessage(err) });
    return false;
  }
  if (!quote.can_cancel) {
    await confirmDialog({
      title: 'Cancelamento fora do prazo',
      html: `<div class="alert alert--warning">${icon('alert')}<div><p>${esc(quote.policy_text)}</p>
             <p>Faltam ${quote.hours_before}h para o atendimento e o prazo mínimo é de ${quote.min_hours}h. Fale com o estúdio pelo WhatsApp para resolver.</p></div></div>`,
      confirmText: 'Entendi', cancelText: 'Fechar',
    });
    return false;
  }

  let warning = '';
  if (quote.is_late) {
    warning = `<div class="alert alert--warning" style="margin-bottom:var(--space-4)">${icon('alert')}<div>
      <p><strong>Você está cancelando com menos de ${quote.min_hours}h de antecedência.</strong></p>
      ${Number(quote.fee_amount) > 0 ? `<p>Taxa de cancelamento: ${fmtMoney(quote.fee_amount)}.</p>` : ''}
      ${quote.forfeits_deposit ? '<p>O sinal pago não será devolvido.</p>' : ''}
      <p>${esc(quote.policy_text)}</p></div></div>`;
  }
  const refund = Number(quote.refund_amount) > 0
    ? `<p>Valor a ser estornado: <strong>${fmtMoney(quote.refund_amount)}</strong> (o estorno é feito pela mesma forma de pagamento).</p>` : '';

  const body = document.createElement('div');
  body.innerHTML = `${warning}
    <p>Cancelar <strong>${esc(a.service?.name || 'agendamento')}</strong> em ${esc(fmtDateLong(a.starts_at))}, às ${fmtTime(a.starts_at)}?</p>
    ${refund}
    <div class="field"><label for="cancel-reason">Motivo ${staff ? '' : '<span class="muted">(opcional)</span>'}</label>
    <textarea class="textarea" id="cancel-reason" maxlength="300"></textarea></div>`;
  const footer = document.createElement('div');
  footer.style.display = 'contents';
  footer.innerHTML = '<button class="btn btn--ghost" data-act="no">Manter agendamento</button><button class="btn btn--danger" data-act="yes">Cancelar agendamento</button>';

  return new Promise((resolve) => {
    let changed = false;
    const m = openModal({ title: 'Cancelar agendamento', body, footer, onClose: () => resolve(changed) });
    footer.querySelector('[data-act="no"]').addEventListener('click', () => m.close());
    footer.querySelector('[data-act="yes"]').addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
      try {
        const result = await cancelAppointment(a.id, body.querySelector('#cancel-reason').value);
        changed = true;
        m.close();
        // Estorno online: o valor foi calculado pelo banco; o servidor pede o estorno ao Mercado Pago
        const onlinePaid = (a.payments || []).find((p) => p.status === 'approved' && p.method !== 'on_site' && p.provider === 'mercadopago');
        if (Number(result?.refund_amount) > 0 && onlinePaid) {
          try {
            await requestRefund(onlinePaid.id);
            toast({ type: 'success', message: `Agendamento cancelado. Estorno de ${fmtMoney(result.refund_amount)} solicitado ao Mercado Pago.` });
          } catch {
            toast({ type: 'warning', message: 'Agendamento cancelado. O estorno será processado pelo estúdio em breve.', timeout: 8000 });
          }
        } else {
          toast({ type: 'success', message: 'Agendamento cancelado.' });
        }
      } catch (err) {
        toast({ type: 'error', message: errorMessage(err) });
      }
    }, 'Cancelando…'));
  });
}

/* ------------------------------------------------------------------ remarcar */
export function rescheduleFlow(a) {
  return new Promise((resolve) => {
    let changed = false;
    let selection = null;
    const body = document.createElement('div');
    body.innerHTML = `
      <p class="muted">Atual: ${esc(fmtDateLong(a.starts_at))}, às ${fmtTime(a.starts_at)} com ${esc(a.employee?.display_name || '')}.
      Escolha o novo dia e horário com a mesma profissional.</p>
      <div id="reschedule-picker"></div>`;
    const footer = document.createElement('div');
    footer.style.display = 'contents';
    footer.innerHTML = '<button class="btn btn--ghost" data-act="no">Voltar</button><button class="btn" data-act="yes" disabled>Confirmar novo horário</button>';
    const confirmBtn = footer.querySelector('[data-act="yes"]');
    const m = openModal({ title: 'Remarcar agendamento', body, footer, size: 'lg', onClose: () => resolve(changed) });
    const picker = createDateTimePicker(body.querySelector('#reschedule-picker'), {
      serviceId: a.service_id || a.service?.id,
      employeeId: a.employee_id || a.employee?.id,
      ignoreAppointment: a.id,
      onSelect: (s) => { selection = s; confirmBtn.disabled = !s; },
    });
    footer.querySelector('[data-act="no"]').addEventListener('click', () => m.close());
    confirmBtn.addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
      try {
        await rescheduleAppointment(a.id, selection.slot_start, a.employee_id || a.employee?.id);
        toast({ type: 'success', message: `Agendamento remarcado para ${fmtDateLong(selection.slot_start)}, às ${fmtTime(selection.slot_start)}.` });
        changed = true;
        m.close();
      } catch (err) {
        toast({ type: 'error', message: errorMessage(err) });
        if (/SLOT_TAKEN|SLOT_UNAVAILABLE/.test(err.message)) picker.refresh();
      }
    }, 'Remarcando…'));
  });
}

/* ------------------------------------------------------------------ pagar pendente */
/** Retoma o pagamento de uma reserva no checkout do Mercado Pago. */
export async function payFlow(a, button) {
  const p = payablePayment(a);
  if (!p) return false;
  const run = async () => {
    try {
      await startCheckout(p.id); // redireciona
    } catch (err) {
      toast({ type: 'error', message: checkoutErrorMessage(err) });
      if (/ALREADY_PAID|PAYMENT_IN_PROCESS/.test(err.message)) location.href = url(`pagamento.html?ref=${p.id}`);
    }
  };
  if (button) await withLoading(button, run, 'Preparando pagamento seguro…');
  else await run();
  return true;
}

/* ------------------------------------------------------------------ avaliar */
export function reviewFlow(a, clientId) {
  return new Promise((resolve) => {
    let changed = false;
    let rating = 5;
    const body = document.createElement('div');
    body.innerHTML = `
      <p class="muted">Como foi seu ${esc(a.service?.name?.toLowerCase() || 'atendimento')} em ${esc(fmtDateLong(a.starts_at))}?</p>
      <div class="field"><span class="field-label" id="rating-label">Nota</span>
        <div role="radiogroup" aria-labelledby="rating-label" style="display:flex;gap:4px">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="icon-btn" role="radio" data-n="${n}" aria-checked="${n === rating}" aria-label="${n} estrela${n > 1 ? 's' : ''}" style="color:var(--color-primary)">${icon('star')}</button>`).join('')}
        </div></div>
      <div class="field" style="margin-top:var(--space-4)"><label for="review-comment">Comentário</label>
        <textarea class="textarea" id="review-comment" maxlength="600" required></textarea>
        <span class="hint">Seu primeiro nome pode aparecer no site depois da aprovação do estúdio.</span></div>`;
    const paint = () => body.querySelectorAll('[data-n]').forEach((b) => {
      const on = Number(b.dataset.n) <= rating;
      b.setAttribute('aria-checked', String(Number(b.dataset.n) === rating));
      b.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none');
    });
    body.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', () => { rating = Number(b.dataset.n); paint(); }));
    paint();
    const footer = document.createElement('div');
    footer.style.display = 'contents';
    footer.innerHTML = '<button class="btn btn--ghost" data-act="no">Agora não</button><button class="btn" data-act="yes">Enviar avaliação</button>';
    const m = openModal({ title: 'Avaliar atendimento', body, footer, onClose: () => resolve(changed) });
    footer.querySelector('[data-act="no"]').addEventListener('click', () => m.close());
    footer.querySelector('[data-act="yes"]').addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
      const comment = body.querySelector('#review-comment');
      if (comment.value.trim().length < 3) { comment.setAttribute('aria-invalid', 'true'); comment.focus(); return; }
      const { error } = await supabase.from('reviews').insert({ client_id: clientId, appointment_id: a.id, rating, comment: comment.value.trim() });
      if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
      toast({ type: 'success', message: 'Obrigada pela avaliação!' });
      changed = true;
      m.close();
    }, 'Enviando…'));
  });
}
