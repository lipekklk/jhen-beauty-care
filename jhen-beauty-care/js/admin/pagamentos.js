/**
 * Admin → Pagamentos: consulta, estorno pelo Mercado Pago, consulta do status real,
 * baixa de pagamento feito no estúdio e eventos do webhook.
 *
 * Pagamentos ONLINE só mudam de status pela confirmação do Mercado Pago (o banco bloqueia
 * alteração manual). Pagamentos NO ESTÚDIO podem ser baixados manualmente.
 * Somente IDs e status do gateway são armazenados (nunca dados de cartão).
 */
import { supabase } from '../supabase.js';
import { initAdminPage, paginationHTML } from './admin.js';
import { requestRefund, syncPayment } from '../pagamentos.js';
import {
  esc, fmtMoney, fmtDateTime, paymentBadge, errorMessage, todayKey, addDaysKey, localToISO,
  METHOD_LABELS, KIND_LABELS, PAYMENT_STATUS_LABELS, testBadge, paymentMethodLabel,
} from '../utils.js';
import { toast, confirmDialog, errorHTML, emptyHTML, withLoading, openModal } from '../ui.js';
import { icon } from '../icons.js';

const PAGE_SIZE = 25;
const state = { page: 1, from: addDaysKey(todayKey(), -30), to: todayKey(), status: '', method: '' };
const isOnline = (p) => p.method !== 'on_site';

async function load() {
  const el = document.getElementById('payments-table');
  const totals = document.getElementById('payment-totals');
  try {
    const base = () => supabase.from('payments');
    let q = base().select(`id, amount, kind, method, status, provider, provider_payment_id, provider_status_detail, payment_type,
        payment_method_id, card_last_four, live_mode, paid_at, created_at, refund_amount, refund_requested_at, is_test_data,
        client:profiles(full_name), appointment:appointments(id, starts_at, status, service:services(name))`, { count: 'exact' })
      .gte('created_at', localToISO(state.from, '00:00'))
      .lt('created_at', localToISO(addDaysKey(state.to, 1), '00:00'))
      .order('created_at', { ascending: false })
      .range((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE - 1);
    if (state.status) q = q.eq('status', state.status);
    if (state.method) q = q.eq('method', state.method);
    const { data, error, count } = await q;
    if (error) throw error;

    // totais do período (todas as páginas)
    const { data: all, error: e2 } = await base().select('amount, status, refund_amount')
      .gte('created_at', localToISO(state.from, '00:00')).lt('created_at', localToISO(addDaysKey(state.to, 1), '00:00'));
    if (e2) throw e2;
    const received = all.filter((p) => ['approved', 'refund_pending', 'refunded'].includes(p.status))
      .reduce((s, p) => s + Number(p.amount) - (p.status === 'refunded' ? Number(p.refund_amount || 0) : 0), 0);
    totals.innerHTML = [
      ['Recebido', fmtMoney(received), true],
      ['Pendente', fmtMoney(all.filter((p) => ['pending', 'in_process'].includes(p.status)).reduce((s, p) => s + Number(p.amount), 0))],
      ['Estornos pendentes', all.filter((p) => p.status === 'refund_pending').length],
      ['Contestados / em disputa', all.filter((p) => ['charged_back', 'in_mediation'].includes(p.status)).length],
    ].map(([l, v, f]) => `<div class="stat ${f ? 'stat--feature' : ''}"><span class="stat__label">${l}</span><span class="stat__value">${esc(v)}</span></div>`).join('');

    if (!data.length) { el.innerHTML = emptyHTML({ title: 'Nenhum pagamento no período', text: 'Ajuste os filtros para ver outros registros.' }); return; }
    el.innerHTML = `<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Data</th><th>Cliente</th><th>Agendamento</th><th>Forma</th><th class="num">Valor</th><th>Status</th><th>Mercado Pago</th><th class="actions-cell"><span class="sr-only">Ações</span></th></tr></thead>
      <tbody>${data.map((p) => `<tr>
        <td data-label="Data">${fmtDateTime(p.created_at)}</td>
        <td data-label="Cliente">${esc(p.client?.full_name)} ${testBadge(p.is_test_data)}</td>
        <td data-label="Agendamento">${esc(p.appointment?.service?.name || '')}<span class="cell-sub">${p.appointment ? fmtDateTime(p.appointment.starts_at) : ''}</span></td>
        <td data-label="Forma">${esc(paymentMethodLabel(p))}<span class="cell-sub">${KIND_LABELS[p.kind]}</span></td>
        <td data-label="Valor" class="num">${fmtMoney(p.amount)}${Number(p.refund_amount) ? `<span class="cell-sub">estorno ${fmtMoney(p.refund_amount)}</span>` : ''}</td>
        <td data-label="Status">${paymentBadge(p.status)}${p.live_mode === false ? '<span class="cell-sub">pagamento de teste</span>' : ''}</td>
        <td data-label="Mercado Pago"><span class="cell-sub">${isOnline(p) ? (p.provider_payment_id ? `nº ${esc(p.provider_payment_id)}` : 'sem pagamento ainda') : 'no estúdio'}</span></td>
        <td class="actions-cell">${actions(p)}</td></tr>`).join('')}</tbody></table>${paginationHTML(state.page, PAGE_SIZE, count)}</div>`;
    el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { state.page = Number(b.dataset.page); load(); }));
    const find = (id) => data.find((p) => p.id === id);
    el.querySelectorAll('[data-paid]').forEach((b) => b.addEventListener('click', () => markPaid(find(b.dataset.paid))));
    el.querySelectorAll('[data-manual-refund]').forEach((b) => b.addEventListener('click', () => markRefunded(find(b.dataset.manualRefund))));
    el.querySelectorAll('[data-mp-refund]').forEach((b) => b.addEventListener('click', () => refundOnline(find(b.dataset.mpRefund))));
    el.querySelectorAll('[data-sync]').forEach((b) => b.addEventListener('click', () => withLoading(b, async () => {
      try {
        const r = await syncPayment(b.dataset.sync);
        toast({ type: 'success', message: `Status no Mercado Pago: ${PAYMENT_STATUS_LABELS[r.status] || r.status}.` });
        load();
      } catch (err) { toast({ type: 'error', message: errorMessage(err) }); }
    })));
    el.querySelectorAll('[data-events]').forEach((b) => b.addEventListener('click', () => showEvents(find(b.dataset.events))));
  } catch (err) {
    el.innerHTML = errorHTML(errorMessage(err));
  }
}

function actions(p) {
  const out = [];
  if (!isOnline(p)) {
    if (p.status === 'pending' && p.appointment?.status !== 'cancelled') out.push(`<button class="btn btn--outline btn--sm" data-paid="${p.id}">${icon('check')} Marcar como pago</button>`);
    if (p.status === 'refund_pending') out.push(`<button class="btn btn--outline btn--sm" data-manual-refund="${p.id}">Registrar estorno</button>`);
    return out.join('');
  }
  if (p.provider === 'mercadopago' && p.provider_payment_id) {
    if (p.status === 'refund_pending') out.push(`<button class="btn btn--sm" data-mp-refund="${p.id}">Estornar no Mercado Pago</button>`);
    if (p.status === 'approved') out.push(`<button class="btn btn--ghost btn--sm" data-mp-refund="${p.id}">Estornar</button>`);
  }
  if (p.provider === 'mercadopago') out.push(`<button class="icon-btn" data-sync="${p.id}" aria-label="Consultar status no Mercado Pago" title="Consultar status no Mercado Pago">${icon('refresh')}</button>`);
  out.push(`<button class="icon-btn" data-events="${p.id}" aria-label="Histórico de eventos" title="Histórico de eventos">${icon('list')}</button>`);
  return out.join('');
}

async function refundOnline(p) {
  const amount = p.status === 'refund_pending' ? Number(p.refund_amount) : Number(p.amount);
  const ok = await confirmDialog({
    title: 'Estornar pelo Mercado Pago',
    html: `<p>Devolver <strong>${fmtMoney(amount)}</strong> para ${esc(p.client?.full_name || 'a cliente')} pela mesma forma de pagamento?</p>
      ${p.status === 'approved' ? '<p class="muted">Estorno total: se o atendimento ainda não aconteceu, o horário é cancelado automaticamente quando o Mercado Pago confirmar.</p>' : ''}
      <p class="muted">O status muda para "Estornado" assim que o Mercado Pago confirmar.</p>`,
    confirmText: 'Estornar', danger: true,
  });
  if (!ok) return;
  try {
    const r = await requestRefund(p.id);
    toast({ type: 'success', message: r?.status === 'refunded' ? 'Estorno confirmado pelo Mercado Pago.' : 'Estorno solicitado ao Mercado Pago.' });
  } catch (err) {
    toast({ type: 'error', message: errorMessage(err) });
  }
  load();
}

async function markPaid(p) {
  const ok = await confirmDialog({
    title: 'Confirmar recebimento',
    message: `Registrar ${fmtMoney(p.amount)} de ${p.client?.full_name} como pago no estúdio (dinheiro, maquininha ou Pix direto)?`,
    confirmText: 'Marcar como pago',
  });
  if (!ok) return;
  const { error } = await supabase.from('payments').update({ status: 'approved', paid_at: new Date().toISOString() }).eq('id', p.id);
  if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
  toast({ type: 'success', message: 'Pagamento registrado.' });
  load();
}

async function markRefunded(p) {
  const ok = await confirmDialog({
    title: 'Registrar estorno',
    message: `Confirme que ${fmtMoney(p.refund_amount)} foram devolvidos à cliente no estúdio.`,
    confirmText: 'Estorno realizado',
  });
  if (!ok) return;
  const { error } = await supabase.from('payments').update({ status: 'refunded', refunded_at: new Date().toISOString() }).eq('id', p.id);
  if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
  toast({ type: 'success', message: 'Estorno registrado.' });
  load();
}

const OUTCOMES = {
  preference_created: 'Checkout criado', preference_failed: 'Falha ao criar checkout', applied: 'Status atualizado',
  no_change: 'Notificação repetida (sem mudança)', stale: 'Notificação antiga ignorada', duplicate_payment: 'Pagamento em duplicidade',
  amount_mismatch: 'Valor divergente', not_live: 'Pagamento de teste ignorado', ignored_other_attempt: 'Outra tentativa ignorada',
  refund_requested: 'Estorno solicitado', auto_refund_requested: 'Estorno automático solicitado', refund_failed: 'Falha no estorno',
  auto_refund_failed: 'Falha no estorno automático', unknown_reference: 'Referência desconhecida', payment_not_found: 'Pagamento não encontrado no MP',
  reference_mismatch: 'ID não pertence a este pagamento', sync_failed: 'Falha na consulta',
};

async function showEvents(p) {
  const m = openModal({ title: 'Histórico do pagamento', size: 'lg', body: '<p class="muted">Carregando…</p>' });
  const { data, error } = await supabase.from('payment_events').select('source, outcome, detail, provider_payment_id, created_at')
    .eq('payment_id', p.id).order('created_at', { ascending: false }).limit(50);
  if (error) { m.body.innerHTML = errorHTML(errorMessage(error)); return; }
  m.body.innerHTML = data.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Quando</th><th>Origem</th><th>Resultado</th><th>ID MP</th></tr></thead><tbody>
    ${data.map((e) => `<tr><td>${fmtDateTime(e.created_at)}</td><td>${esc({ webhook: 'Webhook', sync: 'Consulta', refund: 'Estorno', checkout: 'Checkout' }[e.source] || e.source)}</td>
      <td>${esc(OUTCOMES[e.outcome] || e.outcome)}${e.detail ? `<span class="cell-sub">${esc(PAYMENT_STATUS_LABELS[e.detail] || e.detail)}</span>` : ''}</td>
      <td><span class="cell-sub">${esc(e.provider_payment_id || '—')}</span></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Nenhum evento registrado para este pagamento.</p>';
}

(async () => {
  try { await initAdminPage('pagamentos'); } catch { return; }
  const f = document.getElementById('filters');
  f.from.value = state.from;
  f.to.value = state.to;
  f.status.innerHTML = '<option value="">Todos os status</option>' + Object.entries(PAYMENT_STATUS_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  f.method.innerHTML = '<option value="">Todas as formas</option>' + Object.entries(METHOD_LABELS).map(([k, l]) => `<option value="${k}">${k === 'online' ? 'Mercado Pago (online)' : l}</option>`).join('');
  f.addEventListener('change', () => {
    Object.assign(state, { from: f.from.value || state.from, to: f.to.value || state.to, status: f.status.value, method: f.method.value, page: 1 });
    load();
  });
  f.addEventListener('submit', (e) => e.preventDefault());
  load();
})();
