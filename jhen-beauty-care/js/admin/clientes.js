/**
 * Admin → Clientes: listar, pesquisar, visualizar, editar, bloquear e alterar permissões.
 */
import { supabase } from '../supabase.js';
import { initAdminPage, formModal, paginationHTML } from './admin.js';
import { APPOINTMENT_SELECT } from '../data.js';
import {
  esc, fmtDate, fmtDateTime, fmtMoney, statusBadge, errorMessage, unwrap, debounce, ROLE_LABELS, isValidPhone,
  initials, testBadge, paymentSummary,
} from '../utils.js';
import { openModal, confirmDialog, toast, errorHTML, emptyHTML } from '../ui.js';
import { icon } from '../icons.js';

const PAGE_SIZE = 20;
const state = { page: 1, search: '', role: 'client' };
let me;

async function load() {
  const el = document.getElementById('clients-table');
  el.setAttribute('aria-busy', 'true');
  try {
    let q = supabase.from('profiles')
      .select('id, full_name, email, phone, birth_date, role, is_blocked, is_test_data, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE - 1);
    if (state.role !== 'all') q = q.eq('role', state.role);
    if (state.search) {
      const s = state.search.replace(/[%,()]/g, ' ').trim();
      q = q.or(`full_name.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`);
    }
    const { data, error, count } = await q;
    if (error) throw error;
    if (!data.length) {
      el.innerHTML = emptyHTML({ title: state.search ? 'Nenhum resultado' : 'Nenhum cadastro ainda', text: state.search ? 'Tente outro nome, e-mail ou telefone.' : 'As clientes aparecem aqui quando criam a conta no site.' });
      return;
    }
    el.innerHTML = `
      <div class="table-wrap"><table class="table table--stack">
        <thead><tr><th>Nome</th><th>Contato</th><th>Papel</th><th>Status</th><th>Desde</th><th class="actions-cell"><span class="sr-only">Ações</span></th></tr></thead>
        <tbody>${data.map((p) => `
          <tr>
            <td data-label="Nome"><span class="cell-strong">${esc(p.full_name || '—')}</span> ${testBadge(p.is_test_data)}</td>
            <td data-label="Contato">${esc(p.email || '')}<span class="cell-sub">${esc(p.phone || '')}</span></td>
            <td data-label="Papel">${ROLE_LABELS[p.role]}</td>
            <td data-label="Status">${p.is_blocked ? '<span class="badge status--cancelled">Bloqueada</span>' : '<span class="badge status--completed">Ativa</span>'}</td>
            <td data-label="Desde">${fmtDate(p.created_at)}</td>
            <td class="actions-cell">
              <button class="icon-btn" data-act="view" data-id="${p.id}" aria-label="Ver ${esc(p.full_name)}">${icon('eye')}</button>
              <button class="icon-btn" data-act="edit" data-id="${p.id}" aria-label="Editar ${esc(p.full_name)}">${icon('edit')}</button>
              <button class="icon-btn" data-act="role" data-id="${p.id}" aria-label="Permissões de ${esc(p.full_name)}">${icon('shield')}</button>
              <button class="icon-btn icon-btn--danger" data-act="block" data-id="${p.id}" aria-label="${p.is_blocked ? 'Desbloquear' : 'Bloquear'} ${esc(p.full_name)}">${icon(p.is_blocked ? 'lock' : 'ban')}</button>
            </td>
          </tr>`).join('')}</tbody>
      </table>${paginationHTML(state.page, PAGE_SIZE, count)}</div>`;
    el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { state.page = Number(b.dataset.page); load(); }));
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const p = data.find((x) => x.id === b.dataset.id);
      ({ view, edit, role: changeRole, block: toggleBlock })[b.dataset.act](p);
    }));
  } catch (err) {
    el.innerHTML = errorHTML(errorMessage(err));
  } finally { el.removeAttribute('aria-busy'); }
}

async function view(p) {
  const m = openModal({ title: p.full_name || 'Cliente', size: 'lg', body: '<p class="muted">Carregando histórico…</p>' });
  try {
    const appts = unwrap(await supabase.from('appointments').select(APPOINTMENT_SELECT).eq('client_id', p.id).order('starts_at', { ascending: false }));
    const done = appts.filter((a) => a.status === 'completed');
    const spent = appts.reduce((s, a) => s + paymentSummary(a.payments).paid, 0);
    m.body.innerHTML = `
      <div style="display:flex;gap:var(--space-4);align-items:center;margin-bottom:var(--space-5)">
        <span class="avatar avatar--lg">${esc(initials(p.full_name))}</span>
        <dl class="kv"><dt>E-mail</dt><dd>${esc(p.email || '—')}</dd><dt>Telefone</dt><dd>${esc(p.phone || '—')}</dd>
        <dt>Nascimento</dt><dd>${p.birth_date ? fmtDate(`${p.birth_date}T12:00:00Z`) : '—'}</dd><dt>Cadastro</dt><dd>${fmtDate(p.created_at)}</dd></dl>
      </div>
      <div class="stats" style="margin-bottom:var(--space-5)">
        <div class="stat"><span class="stat__label">Agendamentos</span><span class="stat__value">${appts.length}</span></div>
        <div class="stat"><span class="stat__label">Concluídos</span><span class="stat__value">${done.length}</span></div>
        <div class="stat"><span class="stat__label">Total pago</span><span class="stat__value">${fmtMoney(spent)}</span></div>
      </div>
      <h3 style="font-size:var(--fs-lg)">Histórico</h3>
      ${appts.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Data</th><th>Procedimento</th><th>Profissional</th><th>Status</th></tr></thead><tbody>
        ${appts.map((a) => `<tr><td>${fmtDateTime(a.starts_at)}</td><td>${esc(a.service?.name)}</td><td>${esc(a.employee?.display_name)}</td><td>${statusBadge(a.status)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Sem agendamentos.</p>'}`;
  } catch (err) {
    m.body.innerHTML = errorHTML(errorMessage(err));
  }
}

async function edit(p) {
  const saved = await formModal({
    title: 'Editar cadastro',
    values: p,
    fields: [
      { name: 'full_name', label: 'Nome completo', required: true, full: true, maxlength: 120 },
      { name: 'phone', label: 'Telefone', type: 'tel' },
      { name: 'birth_date', label: 'Data de nascimento', type: 'date' },
      { name: 'email_info', type: 'html', full: true, html: `<p class="hint">E-mail de acesso: <strong>${esc(p.email || '')}</strong>. A troca de e-mail é feita pela própria cliente, com confirmação por link.</p>` },
    ],
    validate: (v) => ({ phone: v.phone && !isValidPhone(v.phone) ? 'Telefone inválido.' : '' }),
    onSubmit: async (v) => unwrap(await supabase.from('profiles').update({ full_name: v.full_name, phone: v.phone, birth_date: v.birth_date }).eq('id', p.id)),
  });
  if (saved) { toast({ type: 'success', message: 'Cadastro atualizado.' }); load(); }
}

async function changeRole(p) {
  const saved = await formModal({
    title: 'Permissões de acesso',
    values: { role: p.role },
    submitText: 'Salvar permissão',
    fields: [
      { name: 'role', label: 'Papel', type: 'select', full: true, required: true, options: Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })) },
      { name: 'info', type: 'html', full: true, html: `<div class="alert alert--info">${icon('info')}<div>
        <p><strong>Cliente:</strong> agenda e vê só os próprios dados.</p>
        <p><strong>Funcionária:</strong> vê a própria agenda e os dados básicos das clientes que vai atender. Para aparecer no agendamento, cadastre-a também em Equipe.</p>
        <p><strong>Administradora:</strong> acesso total ao painel, inclusive financeiro.</p></div></div>` },
    ],
    onSubmit: async (v) => {
      if (p.id === me.id && v.role !== 'admin') throw new Error('CANNOT_DEMOTE_SELF');
      unwrap(await supabase.rpc('admin_set_role', { p_user_id: p.id, p_role: v.role }));
    },
  });
  if (saved) { toast({ type: 'success', message: 'Permissão atualizada.' }); load(); }
}

async function toggleBlock(p) {
  if (p.id === me.id) { toast({ type: 'warning', message: 'Você não pode bloquear a própria conta.' }); return; }
  const block = !p.is_blocked;
  const ok = await confirmDialog({
    title: block ? 'Bloquear cliente?' : 'Desbloquear cliente?',
    message: block
      ? `${p.full_name} não poderá fazer novos agendamentos. Os agendamentos existentes continuam valendo.`
      : `${p.full_name} volta a poder agendar normalmente.`,
    confirmText: block ? 'Bloquear' : 'Desbloquear', danger: block,
  });
  if (!ok) return;
  const { error } = await supabase.from('profiles').update({ is_blocked: block }).eq('id', p.id);
  if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
  toast({ type: 'success', message: block ? 'Cliente bloqueada.' : 'Cliente desbloqueada.' });
  load();
}

(async () => {
  try { me = await initAdminPage('clientes'); } catch { return; }
  document.getElementById('search').addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }, 350));
  document.getElementById('role-filter').addEventListener('change', (e) => { state.role = e.target.value; state.page = 1; load(); });
  load();
})();
