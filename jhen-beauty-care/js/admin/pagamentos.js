/**
 * Admin → Pagamentos: consulta, baixa de pagamento presencial e registro de estorno.
 * Somente IDs e status do gateway são armazenados (nunca dados de cartão).
 */
import { supabase } from '../supabase.js';
import { initAdminPage, paginationHTML } from './admin.js';
import {
  esc, fmtMoney, fmtDateTime, paymentBadge, errorMessage, todayKey, addDaysKey, localToISO,
  METHOD_LABELS, KIND_LABELS, PAYMENT_STATUS_LABELS, testBadge,
} from '../utils.js';
import { toast, confirmDialog, errorHTML, emptyHTML } from '../ui.js';
import { icon } from '../icons.js';

const PAGE_SIZE = 25;
const state = { page: 1, from: addDaysKey(todayKey(), -30), to: todayKey(), status: '', method: '' };

async function load() {
  const el = document.getElementById('payments-table');
  const totals = document.getElementById('payment-totals');
  try {
    const base = () => supabase.from('payments');
    let q = base().select(`id, amount, kind, method, status, provider, provider_payment_id, paid_at, created_at, refund_amount, is_test_data,
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
    const sum = (f) => all.filter(f).reduce((s, p) => s + Number(p.amount), 0);
    totals.innerHTML = [
      ['Recebido', fmtMoney(sum((p) => ['approved', 'refund_pending', 'refunded'].includes(p.status)) - all.reduce((s, p) => s + Number(p.refund_amount || 0), 0)), true],
      ['Pendente', fmtMoney(sum((p) => p.status === 'pending'))],
      ['Estornos pendentes', all.filter((p) => p.status === 'refund_pending').length],
      ['Recusados', all.filter((p) => p.status === 'rejected').length],
    ].map(([l, v, f]) => `<div class="stat ${f ? 'stat--feature' : ''}"><span class="stat__label">${l}</span><span class="stat__value">${esc(v)}</span></div>`).join('');

    if (!data.length) { el.innerHTML = emptyHTML({ title: 'Nenhum pagamento no período', text: 'Ajuste os filtros para ver outros registros.' }); return; }
    el.innerHTML = `<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Data</th><th>Cliente</th><th>Agendamento</th><th>Tipo</th><th class="num">Valor</th><th>Status</th><th>ID no gateway</th><th class="actions-cell"><span class="sr-only">Ações</span></th></tr></thead>
      <tbody>${data.map((p) => `<tr>
        <td data-label="Data">${fmtDateTime(p.created_at)}</td>
        <td data-label="Cliente">${esc(p.client?.full_name)} ${testBadge(p.is_test_data)}</td>
        <td data-label="Agendamento">${esc(p.appointment?.service?.name || '')}<span class="cell-sub">${p.appointment ? fmtDateTime(p.appointment.starts_at) : ''}</span></td>
        <td data-label="Tipo">${METHOD_LABELS[p.method]}<span class="cell-sub">${KIND_LABELS[p.kind]}</span></td>
        <td data-label="Valor" class="num">${fmtMoney(p.amount)}${Number(p.refund_amount) ? `<span class="cell-sub">estorno ${fmtMoney(p.refund_amount)}</span>` : ''}</td>
        <td data-label="Status">${paymentBadge(p.status)}</td>
        <td data-label="Gateway"><span class="cell-sub">${esc(p.provider)}${p.provider_payment_id ? ` · ${esc(p.provider_payment_id)}` : ''}</span></td>
        <td class="actions-cell">
          ${p.status === 'pending' && p.appointment?.status !== 'cancelled' ? `<button class="btn btn--outline btn--sm" data-paid="${p.id}">${icon('check')} Marcar como pago</button>` : ''}
          ${p.status === 'refund_pending' ? `<button class="btn btn--outline btn--sm" data-refund="${p.id}">Registrar estorno</button>` : ''}
        </td></tr>`).join('')}</tbody></table>${paginationHTML(state.page, PAGE_SIZE, count)}</div>`;
    el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { state.page = Number(b.dataset.page); load(); }));
    el.querySelectorAll('[data-paid]').forEach((b) => b.addEventListener('click', () => markPaid(data.find((p) => p.id === b.dataset.paid))));
    el.querySelectorAll('[data-refund]').forEach((b) => b.addEventListener('click', () => markRefunded(data.find((p) => p.id === b.dataset.refund))));
  } catch (err) {
    el.innerHTML = errorHTML(errorMessage(err));
  }
}

async function markPaid(p) {
  const ok = await confirmDialog({
    title: 'Confirmar recebimento',
    message: `Registrar ${fmtMoney(p.amount)} de ${p.client?.full_name} como pago? Use para pagamentos recebidos no estúdio (dinheiro, maquininha ou PIX direto).`,
    confirmText: 'Marcar como pago',
  });
  if (!ok) return;
  const { error } = await supabase.from('payments').update({ status: 'approved', provider: p.method === 'on_site' ? 'manual' : p.provider, paid_at: new Date().toISOString() }).eq('id', p.id);
  if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
  toast({ type: 'success', message: 'Pagamento registrado.' });
  load();
}

async function markRefunded(p) {
  const ok = await confirmDialog({
    title: 'Registrar estorno',
    message: `Confirme que o estorno de ${fmtMoney(p.refund_amount)} foi feito no gateway (ou devolvido à cliente).`,
    confirmText: 'Estorno realizado',
  });
  if (!ok) return;
  const { error } = await supabase.from('payments').update({ status: 'refunded' }).eq('id', p.id);
  if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
  toast({ type: 'success', message: 'Estorno registrado.' });
  load();
}

(async () => {
  try { await initAdminPage('pagamentos'); } catch { return; }
  const f = document.getElementById('filters');
  f.from.value = state.from;
  f.to.value = state.to;
  f.status.innerHTML = '<option value="">Todos os status</option>' + Object.entries(PAYMENT_STATUS_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  f.method.innerHTML = '<option value="">Todas as formas</option>' + Object.entries(METHOD_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  f.addEventListener('change', () => {
    Object.assign(state, { from: f.from.value || state.from, to: f.to.value || state.to, status: f.status.value, method: f.method.value, page: 1 });
    load();
  });
  f.addEventListener('submit', (e) => e.preventDefault());
  load();
})();
