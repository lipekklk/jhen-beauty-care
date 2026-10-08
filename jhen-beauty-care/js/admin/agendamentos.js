/**
 * Admin → Agendamentos: listar com filtros, criar para uma cliente, editar,
 * alterar status, remarcar, cancelar e ver detalhes.
 */
import { supabase } from '../supabase.js';
import { initAdminPage, paginationHTML } from './admin.js';
import { APPOINTMENT_SELECT, bookAppointment, updateAppointmentStatus } from '../data.js';
import { showDetails, cancelFlow, rescheduleFlow } from '../appointment-actions.js';
import { createDateTimePicker } from '../calendar.js';
import {
  esc, fmtMoney, fmtTime, fmtDate, fmtDateLong, statusBadge, paymentSummary, errorMessage, unwrap, todayKey, addDaysKey,
  localToISO, STATUS_LABELS, debounce, getParam, METHOD_LABELS, testBadge,
} from '../utils.js';
import { openModal, toast, withLoading, errorHTML, emptyHTML, confirmDialog } from '../ui.js';
import { icon } from '../icons.js';

const PAGE_SIZE = 25;
const state = { page: 1, from: todayKey(), to: addDaysKey(todayKey(), 7), status: '', employee: '', search: '' };
let employees = [];
let services = [];

async function load() {
  const el = document.getElementById('appointments-table');
  el.setAttribute('aria-busy', 'true');
  try {
    let q = supabase.from('appointments')
      .select(`${APPOINTMENT_SELECT}, client:profiles!appointments_client_id_fkey!inner(full_name, phone, email)`, { count: 'exact' })
      .gte('starts_at', localToISO(state.from, '00:00'))
      .lt('starts_at', localToISO(addDaysKey(state.to, 1), '00:00'))
      .order('starts_at')
      .range((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE - 1);
    if (state.status) q = q.eq('status', state.status);
    if (state.employee) q = q.eq('employee_id', state.employee);
    if (state.search) q = q.ilike('client.full_name', `%${state.search.replace(/[%,()]/g, ' ')}%`);
    const { data, error, count } = await q;
    if (error) throw error;
    if (!data.length) {
      el.innerHTML = emptyHTML({ title: 'Nenhum agendamento no período', text: 'Ajuste os filtros ou crie um agendamento.' });
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Data e hora</th><th>Cliente</th><th>Procedimento</th><th>Profissional</th><th>Status</th><th>Pagamento</th><th class="actions-cell"><span class="sr-only">Ações</span></th></tr></thead>
      <tbody>${data.map((a) => {
        const pay = paymentSummary(a.payments);
        return `<tr>
          <td data-label="Data"><span class="cell-strong">${fmtDate(a.starts_at)}</span><span class="cell-sub">${fmtTime(a.starts_at)}–${fmtTime(a.ends_at)}</span></td>
          <td data-label="Cliente">${esc(a.client?.full_name)} ${testBadge(a.is_test_data)}<span class="cell-sub">${esc(a.client?.phone || '')}</span></td>
          <td data-label="Procedimento">${esc(a.service?.name)}<span class="cell-sub">${fmtMoney(a.price)}</span></td>
          <td data-label="Profissional">${esc(a.employee?.display_name)}</td>
          <td data-label="Status">${statusBadge(a.status)}</td>
          <td data-label="Pagamento"><span class="badge status--${pay.status}">${esc(pay.label)}</span></td>
          <td class="actions-cell">
            <button class="icon-btn" data-act="details" data-id="${a.id}" aria-label="Detalhes">${icon('eye')}</button>
            <button class="icon-btn" data-act="edit" data-id="${a.id}" aria-label="Editar">${icon('edit')}</button>
            ${['scheduled', 'confirmed'].includes(a.status) ? `<button class="icon-btn" data-act="reschedule" data-id="${a.id}" aria-label="Remarcar">${icon('calendar')}</button>` : ''}
            ${['pending_payment', 'scheduled', 'confirmed'].includes(a.status) ? `<button class="icon-btn icon-btn--danger" data-act="cancel" data-id="${a.id}" aria-label="Cancelar">${icon('ban')}</button>` : ''}
          </td></tr>`;
      }).join('')}</tbody></table>${paginationHTML(state.page, PAGE_SIZE, count)}</div>`;
    el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { state.page = Number(b.dataset.page); load(); }));
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const a = data.find((x) => x.id === b.dataset.id);
      const run = async (act) => {
        let changed = false;
        if (act === 'details') return showDetails(a, { onAction: run });
        if (act === 'edit') changed = await editAppointment(a);
        if (act === 'reschedule') changed = await rescheduleFlow(a);
        if (act === 'cancel') changed = await cancelFlow(a, { staff: true });
        if (changed) load();
        return undefined;
      };
      run(b.dataset.act);
    }));
  } catch (err) {
    el.innerHTML = errorHTML(errorMessage(err));
  } finally { el.removeAttribute('aria-busy'); }
}

/** Editar: status, valor e observações. */
function editAppointment(a) {
  return new Promise((resolve) => {
    let changed = false;
    const body = document.createElement('form');
    body.className = 'form';
    body.innerHTML = `
      <p class="muted">${esc(a.client?.full_name)} · ${esc(a.service?.name)} · ${esc(fmtDateLong(a.starts_at))}, ${fmtTime(a.starts_at)}</p>
      <div class="form-row">
        <div class="field"><label for="ed-status">Status</label><select class="select" id="ed-status">
          ${Object.entries(STATUS_LABELS).filter(([k]) => k !== 'pending_payment' || a.status === 'pending_payment').map(([k, l]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="ed-price">Valor do atendimento (R$)</label><input class="input" type="number" id="ed-price" min="0" step="0.01" value="${a.price}"></div>
      </div>
      <div class="field"><label for="ed-notes">Observações</label><textarea class="textarea" id="ed-notes" maxlength="500">${esc(a.notes || '')}</textarea></div>`;
    const footer = document.createElement('div');
    footer.style.display = 'contents';
    footer.innerHTML = '<button class="btn btn--ghost" data-x>Cancelar</button><button class="btn" data-ok>Salvar</button>';
    const m = openModal({ title: 'Editar agendamento', body, footer, onClose: () => resolve(changed) });
    footer.querySelector('[data-x]').addEventListener('click', () => m.close());
    footer.querySelector('[data-ok]').addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
      try {
        const status = body.querySelector('#ed-status').value;
        const price = Number(body.querySelector('#ed-price').value);
        if (!(price >= 0)) { toast({ type: 'error', message: 'Informe um valor válido.' }); return; }
        unwrap(await supabase.from('appointments').update({ price, notes: body.querySelector('#ed-notes').value.trim() || null }).eq('id', a.id));
        if (status !== a.status) {
          if (status === 'cancelled') {
            const ok = await confirmDialog({ title: 'Cancelar agendamento?', message: 'A cliente será avisada e o horário fica livre.', confirmText: 'Cancelar agendamento', danger: true });
            if (!ok) return;
          }
          await updateAppointmentStatus(a.id, status);
        }
        toast({ type: 'success', message: 'Agendamento atualizado.' });
        changed = true;
        m.close();
      } catch (err) { toast({ type: 'error', message: errorMessage(err) }); }
    }, 'Salvando…'));
  });
}

/** Criar agendamento para uma cliente (balcão, telefone, WhatsApp). */
function createAppointment() {
  let client = null;
  let slot = null;
  let picker = null;
  const body = document.createElement('div');
  body.className = 'form';
  body.innerHTML = `
    <div class="field" style="position:relative"><label for="cl-search">Cliente</label>
      <input class="input" id="cl-search" placeholder="Busque por nome, e-mail ou telefone" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="cl-results">
      <ul id="cl-results" role="listbox" class="panel" style="position:absolute;z-index:5;left:0;right:0;top:100%;padding:var(--space-2);list-style:none;margin:4px 0 0;max-height:220px;overflow:auto" hidden></ul>
      <span class="hint">A cliente precisa ter conta. Para quem não tem, peça o cadastro pelo site.</span></div>
    <div class="form-row">
      <div class="field"><label for="nw-service">Procedimento</label><select class="select" id="nw-service">
        <option value="">Selecione…</option>${services.map((s) => `<option value="${s.id}">${esc(s.name)} · ${fmtMoney(s.price)}</option>`).join('')}</select></div>
      <div class="field"><label for="nw-employee">Profissional</label><select class="select" id="nw-employee"><option value="">Sem preferência</option></select></div>
      <div class="field"><label for="nw-method">Pagamento</label><select class="select" id="nw-method">
        ${Object.entries(METHOD_LABELS).map(([k, l]) => `<option value="${k}" ${k === 'on_site' ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="hint">PIX/cartão geram cobrança pendente para a cliente pagar na área dela.</span></div>
    </div>
    <div id="nw-picker"><p class="muted">Escolha o procedimento para ver os horários.</p></div>
    <div class="field"><label for="nw-notes">Observações</label><textarea class="textarea" id="nw-notes" maxlength="500"></textarea></div>`;
  const footer = document.createElement('div');
  footer.style.display = 'contents';
  footer.innerHTML = '<button class="btn btn--ghost" data-x>Cancelar</button><button class="btn" data-ok disabled>Criar agendamento</button>';
  const okBtn = footer.querySelector('[data-ok]');
  const m = openModal({ title: 'Novo agendamento', body, footer, size: 'lg' });
  const sync = () => { okBtn.disabled = !(client && slot); };

  // busca de cliente
  const search = body.querySelector('#cl-search');
  const results = body.querySelector('#cl-results');
  search.addEventListener('input', debounce(async () => {
    const s = search.value.replace(/[%,()]/g, ' ').trim();
    client = null; sync();
    if (s.length < 2) { results.hidden = true; return; }
    const { data } = await supabase.from('profiles').select('id, full_name, email, phone, is_blocked')
      .or(`full_name.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`).limit(8);
    results.innerHTML = (data || []).map((p) => `<li><button type="button" class="btn btn--ghost btn--block" style="justify-content:flex-start" data-id="${p.id}" ${p.is_blocked ? 'disabled' : ''}>${esc(p.full_name)} <span class="muted">${esc(p.email || '')}</span>${p.is_blocked ? ' (bloqueada)' : ''}</button></li>`).join('') || '<li class="muted" style="padding:var(--space-2)">Nenhuma cliente encontrada.</li>';
    results.hidden = false;
    search.setAttribute('aria-expanded', 'true');
    results.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => {
      client = data.find((p) => p.id === b.dataset.id);
      search.value = client.full_name;
      results.hidden = true;
      search.setAttribute('aria-expanded', 'false');
      sync();
    }));
  }, 300));

  const svcSel = body.querySelector('#nw-service');
  const empSel = body.querySelector('#nw-employee');
  const mountPicker = () => {
    slot = null; sync();
    if (!svcSel.value) return;
    picker = createDateTimePicker(body.querySelector('#nw-picker'), {
      serviceId: svcSel.value, employeeId: empSel.value || null,
      onSelect: (s) => { slot = s; sync(); },
    });
  };
  svcSel.addEventListener('change', async () => {
    const { data } = await supabase.from('employee_services').select('employee:employees!inner(id, display_name, is_active)').eq('service_id', svcSel.value).eq('employee.is_active', true);
    empSel.innerHTML = '<option value="">Sem preferência</option>' + (data || []).map((r) => `<option value="${r.employee.id}">${esc(r.employee.display_name)}</option>`).join('');
    mountPicker();
  });
  empSel.addEventListener('change', mountPicker);

  footer.querySelector('[data-x]').addEventListener('click', () => m.close());
  okBtn.addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    try {
      await bookAppointment({
        p_service_id: svcSel.value, p_starts_at: slot.slot_start, p_employee_id: empSel.value || null,
        p_payment_method: body.querySelector('#nw-method').value, p_notes: body.querySelector('#nw-notes').value || null,
        p_client_id: client.id,
      });
      toast({ type: 'success', message: `Agendamento criado para ${client.full_name}.` });
      m.close();
      load();
    } catch (err) {
      toast({ type: 'error', message: errorMessage(err) });
      if (/SLOT_TAKEN|SLOT_UNAVAILABLE/.test(err.message)) picker?.refresh();
    }
  }, 'Criando…'));
}

(async () => {
  try { await initAdminPage('agendamentos'); } catch { return; }
  [employees, services] = await Promise.all([
    supabase.from('employees').select('id, display_name').order('display_name').then(unwrap),
    supabase.from('services').select('id, name, price').eq('is_active', true).order('sort_order').then(unwrap),
  ]).catch(() => [[], []]);

  const f = document.getElementById('filters');
  f.from.value = state.from;
  f.to.value = state.to;
  f.status.innerHTML = '<option value="">Todos os status</option>' + Object.entries(STATUS_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  f.employee.innerHTML = '<option value="">Toda a equipe</option>' + employees.map((e) => `<option value="${e.id}">${esc(e.display_name)}</option>`).join('');
  f.addEventListener('change', () => {
    if (f.from.value && f.to.value && f.to.value < f.from.value) f.to.value = f.from.value;
    Object.assign(state, { from: f.from.value || todayKey(), to: f.to.value || f.from.value || todayKey(), status: f.status.value, employee: f.employee.value, page: 1 });
    load();
  });
  f.search.addEventListener('input', debounce(() => { state.search = f.search.value.trim(); state.page = 1; load(); }, 350));
  f.addEventListener('submit', (e) => e.preventDefault());
  document.getElementById('new-appointment').addEventListener('click', createAppointment);
  load();
  if (getParam('novo')) createAppointment();
})();
