/**
 * Admin → Equipe: cadastrar profissionais, procedimentos que realizam,
 * dias e horários de trabalho, status.
 */
import { supabase, uploadMedia } from '../supabase.js';
import { initAdminPage, formModal } from './admin.js';
import { esc, errorMessage, unwrap, isValidEmail, WEEKDAYS, initials, testBadge } from '../utils.js';
import { openModal, toast, withLoading, errorHTML, emptyHTML, bindTabs } from '../ui.js';
import { icon } from '../icons.js';

let services = [];
let businessHours = [];

async function load() {
  const el = document.getElementById('team');
  try {
    const team = unwrap(await supabase.from('employees')
      .select('id, display_name, title, bio, photo_url, is_active, is_test_data, profile:profiles(id, email, phone, role), employee_services(service_id), employee_hours(*)')
      .order('is_active', { ascending: false }).order('display_name'));
    if (!team.length) {
      el.innerHTML = emptyHTML({ title: 'Nenhuma profissional cadastrada', text: 'Adicione a primeira profissional para liberar o agendamento online.', action: { label: 'Adicionar profissional', id: 'empty-add' } });
      document.getElementById('empty-add')?.addEventListener('click', addEmployee);
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Profissional</th><th>Cargo</th><th>Procedimentos</th><th>Dias de trabalho</th><th>Status</th><th class="actions-cell"><span class="sr-only">Ações</span></th></tr></thead>
      <tbody>${team.map((e) => {
        const svc = e.employee_services.map((x) => services.find((s) => s.id === x.service_id)?.name).filter(Boolean);
        const days = workingDays(e).map((d) => WEEKDAYS[d].slice(0, 3)).join(', ') || '—';
        return `<tr>
          <td data-label="Profissional"><div style="display:flex;gap:var(--space-3);align-items:center"><span class="avatar">${e.photo_url ? `<img src="${esc(e.photo_url)}" alt="">` : esc(initials(e.display_name))}</span>
            <div><span class="cell-strong">${esc(e.display_name)}</span> ${testBadge(e.is_test_data)}<span class="cell-sub">${esc(e.profile?.email || '')}</span></div></div></td>
          <td data-label="Cargo">${esc(e.title)}</td>
          <td data-label="Procedimentos">${svc.length ? esc(svc.join(', ')) : '<span class="muted">Nenhum</span>'}</td>
          <td data-label="Dias">${esc(days)}</td>
          <td data-label="Status">${e.is_active ? '<span class="badge status--completed">Ativa</span>' : '<span class="badge">Inativa</span>'}</td>
          <td class="actions-cell"><button class="btn btn--outline btn--sm" data-edit="${e.id}">${icon('edit')} Editar</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editEmployee(team.find((x) => x.id === b.dataset.edit))));
  } catch (err) {
    el.innerHTML = errorHTML(errorMessage(err));
  }
}

/** Dias trabalhados: jornada própria ou, sem linha, os dias abertos do estúdio. */
function workingDays(e) {
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => {
    const own = e.employee_hours.find((h) => h.weekday === d);
    if (own) return own.is_working;
    return businessHours.find((h) => h.weekday === d)?.is_open;
  });
}

async function addEmployee() {
  const saved = await formModal({
    title: 'Adicionar profissional',
    submitText: 'Adicionar',
    fields: [
      { name: 'info', type: 'html', full: true, html: `<div class="alert alert--info">${icon('info')}<p>A profissional precisa ter uma conta no site. Peça para ela se cadastrar em <strong>Criar conta</strong> e depois informe o e-mail aqui. Se a Edge Function <code>invite-employee</code> estiver publicada, enviamos um convite automático para e-mails sem conta.</p></div>` },
      { name: 'email', label: 'E-mail da conta', type: 'email', required: true, full: true },
      { name: 'display_name', label: 'Nome exibido no agendamento', required: true, maxlength: 80 },
      { name: 'title', label: 'Cargo', default: 'Designer de sobrancelhas', required: true },
    ],
    validate: (v) => ({ email: v.email && !isValidEmail(v.email) ? 'E-mail inválido.' : '' }),
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('admin_upsert_employee', { p_email: v.email, p_display_name: v.display_name, p_title: v.title });
      if (!error) return;
      if (!/USER_NOT_FOUND/.test(error.message)) throw error;
      // tenta convite via Edge Function (opcional, usa service_role no servidor)
      const inv = await supabase.functions.invoke('invite-employee', { body: { email: v.email, display_name: v.display_name, title: v.title } });
      if (inv.error) throw error;
      toast({ type: 'success', message: `Convite enviado para ${v.email}.` });
    },
  });
  if (saved) { toast({ type: 'success', message: 'Profissional adicionada. Agora defina procedimentos e horários.' }); load(); }
}

function editEmployee(e) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Seções do cadastro">
      <button role="tab" data-tab="dados" aria-controls="tp-dados" aria-selected="true">Dados</button>
      <button role="tab" data-tab="servicos" aria-controls="tp-servicos" aria-selected="false" tabindex="-1">Procedimentos</button>
      <button role="tab" data-tab="horarios" aria-controls="tp-horarios" aria-selected="false" tabindex="-1">Horários</button>
    </div>
    <div class="tab-panel" id="tp-dados" role="tabpanel">
      <form class="form" id="emp-form" novalidate>
        <div style="display:flex;gap:var(--space-4);align-items:center">
          <span class="avatar avatar--lg" id="emp-photo">${e.photo_url ? `<img src="${esc(e.photo_url)}" alt="">` : esc(initials(e.display_name))}</span>
          <label class="btn btn--outline btn--sm">${icon('image')} Trocar foto<input type="file" accept="image/jpeg,image/png,image/webp" id="emp-photo-input" class="sr-only"></label>
        </div>
        <div class="form-row">
          <div class="field"><label for="emp-name">Nome exibido</label><input class="input" id="emp-name" name="display_name" value="${esc(e.display_name)}" maxlength="80" required></div>
          <div class="field"><label for="emp-title">Cargo</label><input class="input" id="emp-title" name="title" value="${esc(e.title)}" required></div>
        </div>
        <div class="field"><label for="emp-bio">Apresentação <span class="muted">(opcional)</span></label><textarea class="textarea" id="emp-bio" name="bio" maxlength="400">${esc(e.bio || '')}</textarea></div>
        <label class="switch"><input type="checkbox" name="is_active" ${e.is_active ? 'checked' : ''}><span class="switch__track"></span><span>Ativa (aparece no agendamento)</span></label>
        <p class="hint">E-mail de acesso: ${esc(e.profile?.email || '')}</p>
      </form>
    </div>
    <div class="tab-panel" id="tp-servicos" role="tabpanel" hidden>
      <p class="muted">Marque os procedimentos que ${esc(e.display_name)} realiza.</p>
      <div class="chip-list">${services.map((s) => `<label class="chip"><input type="checkbox" value="${s.id}" ${e.employee_services.some((x) => x.service_id === s.id) ? 'checked' : ''}>${esc(s.name)}${s.is_active ? '' : ' (inativo)'}</label>`).join('')}</div>
    </div>
    <div class="tab-panel" id="tp-horarios" role="tabpanel" hidden>
      <p class="muted">Deixe "Igual ao estúdio" para seguir o horário de funcionamento. Folgas e férias ficam em Configurações → Bloqueios.</p>
      <div class="hours-editor">${[1, 2, 3, 4, 5, 6, 0].map((d) => hoursRow(d, e.employee_hours.find((h) => h.weekday === d))).join('')}</div>
    </div>`;
  const footer = document.createElement('div');
  footer.style.display = 'contents';
  footer.innerHTML = '<button class="btn btn--ghost" data-x>Cancelar</button><button class="btn" data-save>Salvar alterações</button>';
  const m = openModal({ title: `Editar ${e.display_name}`, body, footer, size: 'lg' });
  bindTabs(body.querySelector('[role="tablist"]'));

  let photoUrl = e.photo_url;
  body.querySelector('#emp-photo-input').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      photoUrl = await uploadMedia(file, 'employees');
      body.querySelector('#emp-photo').innerHTML = `<img src="${esc(photoUrl)}" alt="">`;
    } catch (err) { toast({ type: 'error', message: errorMessage(err) }); }
  });
  body.querySelectorAll('.hours-row').forEach((row) => {
    const sel = row.querySelector('select');
    const paint = () => row.classList.toggle('is-closed', sel.value !== 'custom');
    sel.addEventListener('change', paint); paint();
  });

  footer.querySelector('[data-x]').addEventListener('click', () => m.close());
  footer.querySelector('[data-save]').addEventListener('click', (ev) => withLoading(ev.currentTarget, async () => {
    const f = body.querySelector('#emp-form');
    if (f.display_name.value.trim().length < 2) { f.display_name.setAttribute('aria-invalid', 'true'); f.display_name.focus(); return; }
    try {
      // 1. dados
      unwrap(await supabase.from('employees').update({
        display_name: f.display_name.value.trim(), title: f.title.value.trim(), bio: f.bio.value.trim() || null,
        is_active: f.is_active.checked, photo_url: photoUrl,
      }).eq('id', e.id));
      // 2. procedimentos (diferença entre marcado e atual)
      const checked = [...body.querySelectorAll('#tp-servicos input:checked')].map((i) => i.value);
      const current = e.employee_services.map((x) => x.service_id);
      const add = checked.filter((id) => !current.includes(id));
      const remove = current.filter((id) => !checked.includes(id));
      if (add.length) unwrap(await supabase.from('employee_services').insert(add.map((service_id) => ({ employee_id: e.id, service_id }))));
      if (remove.length) unwrap(await supabase.from('employee_services').delete().eq('employee_id', e.id).in('service_id', remove));
      // 3. horários
      const rows = [...body.querySelectorAll('.hours-row')].map((row) => readHoursRow(row, e.id));
      const invalid = rows.find((r) => r.error);
      if (invalid) { toast({ type: 'error', message: invalid.error }); return; }
      const upserts = rows.filter((r) => r.mode !== 'default').map(({ mode, error, ...r }) => r);
      const defaults = rows.filter((r) => r.mode === 'default').map((r) => r.weekday);
      if (upserts.length) unwrap(await supabase.from('employee_hours').upsert(upserts, { onConflict: 'employee_id,weekday' }));
      if (defaults.length) unwrap(await supabase.from('employee_hours').delete().eq('employee_id', e.id).in('weekday', defaults));
      toast({ type: 'success', message: 'Cadastro atualizado.' });
      m.close();
      load();
    } catch (err) {
      toast({ type: 'error', message: errorMessage(err) });
    }
  }, 'Salvando…'));
}

function hoursRow(day, h) {
  const mode = !h ? 'default' : h.is_working ? (h.start_time ? 'custom' : 'default') : 'off';
  const t = (v) => (v ? v.slice(0, 5) : '');
  return `<div class="hours-row" data-day="${day}">
    <span class="hours-row__day">${WEEKDAYS[day]}</span>
    <select class="select" aria-label="Jornada de ${WEEKDAYS[day]}" style="min-height:42px">
      <option value="default" ${mode === 'default' ? 'selected' : ''}>Igual ao estúdio</option>
      <option value="custom" ${mode === 'custom' ? 'selected' : ''}>Horário próprio</option>
      <option value="off" ${mode === 'off' ? 'selected' : ''}>Não trabalha</option>
    </select>
    <div class="hours-row__fields">
      <input class="input" type="time" data-k="start_time" value="${t(h?.start_time)}" aria-label="Início">
      <input class="input" type="time" data-k="end_time" value="${t(h?.end_time)}" aria-label="Fim">
      <input class="input" type="time" data-k="break_start" value="${t(h?.break_start)}" aria-label="Início do intervalo">
      <input class="input" type="time" data-k="break_end" value="${t(h?.break_end)}" aria-label="Fim do intervalo">
    </div>
  </div>`;
}

function readHoursRow(row, employeeId) {
  const weekday = Number(row.dataset.day);
  const mode = row.querySelector('select').value;
  const v = (k) => row.querySelector(`[data-k="${k}"]`).value || null;
  const base = { employee_id: employeeId, weekday, mode };
  if (mode === 'default') return base;
  if (mode === 'off') return { ...base, is_working: false, start_time: null, end_time: null, break_start: null, break_end: null };
  const r = { ...base, is_working: true, start_time: v('start_time'), end_time: v('end_time'), break_start: v('break_start'), break_end: v('break_end') };
  if (!r.start_time || !r.end_time || r.end_time <= r.start_time) r.error = `${WEEKDAYS[weekday]}: informe início e fim (fim depois do início).`;
  if (Boolean(r.break_start) !== Boolean(r.break_end) || (r.break_start && r.break_end <= r.break_start)) r.error = `${WEEKDAYS[weekday]}: intervalo incompleto ou inválido.`;
  return r;
}

(async () => {
  try { await initAdminPage('funcionarios'); } catch { return; }
  [services, businessHours] = await Promise.all([
    supabase.from('services').select('id, name, is_active').order('sort_order').then(unwrap),
    supabase.from('business_hours').select('*').then(unwrap),
  ]).catch(() => [[], []]);
  document.getElementById('add-employee').addEventListener('click', addEmployee);
  load();
})();

