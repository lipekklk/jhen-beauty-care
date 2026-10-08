/**
 * Admin → Procedimentos: criar, editar, excluir, ativar/desativar,
 * forma de cobrança (integral, sinal, presencial) e profissionais habilitadas.
 */
import { supabase, uploadMedia } from '../supabase.js';
import { initAdminPage, formModal } from './admin.js';
import { invalidate } from '../data.js';
import { esc, fmtMoney, fmtDuration, errorMessage, unwrap, KIND_LABELS, testBadge } from '../utils.js';
import { toast, confirmDialog, errorHTML, emptyHTML } from '../ui.js';
import { icon } from '../icons.js';

let employees = [];

async function load() {
  const el = document.getElementById('services-table');
  try {
    const list = unwrap(await supabase.from('services').select('*, employee_services(employee_id)').order('sort_order').order('name'));
    if (!list.length) {
      el.innerHTML = emptyHTML({ title: 'Nenhum procedimento', text: 'Cadastre o primeiro procedimento para começar a receber agendamentos.', action: { label: 'Novo procedimento', id: 'empty-new' } });
      document.getElementById('empty-new')?.addEventListener('click', () => edit());
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Procedimento</th><th class="num">Preço</th><th>Duração</th><th>Cobrança</th><th>Profissionais</th><th>Ativo</th><th class="actions-cell"><span class="sr-only">Ações</span></th></tr></thead>
      <tbody>${list.map((s) => `
        <tr>
          <td data-label="Procedimento"><div style="display:flex;gap:var(--space-3);align-items:center">
            <span class="choice__thumb" style="width:40px;height:52px">${s.image_url ? `<img src="${esc(s.image_url)}" alt="">` : ''}</span>
            <div><span class="cell-strong">${esc(s.name)}</span> ${testBadge(s.is_test_data)}<span class="cell-sub">${esc(s.description.slice(0, 70))}${s.description.length > 70 ? '…' : ''}</span></div></div></td>
          <td data-label="Preço" class="num">${fmtMoney(s.price)}</td>
          <td data-label="Duração">${fmtDuration(s.duration_minutes)}</td>
          <td data-label="Cobrança">${KIND_LABELS[s.payment_mode]}${s.payment_mode === 'deposit' ? ` (${fmtMoney(s.deposit_amount)})` : ''}${s.payment_mode !== 'on_site' && s.allow_on_site ? '<span class="cell-sub">aceita pagar no local</span>' : ''}</td>
          <td data-label="Profissionais">${s.employee_services.length ? esc(s.employee_services.map((x) => employees.find((e) => e.id === x.employee_id)?.display_name).filter(Boolean).join(', ')) : '<span class="badge status--pending">nenhuma</span>'}</td>
          <td data-label="Ativo"><label class="switch"><input type="checkbox" data-toggle="${s.id}" ${s.is_active ? 'checked' : ''} aria-label="Ativar ${esc(s.name)}"><span class="switch__track"></span></label></td>
          <td class="actions-cell">
            <button class="icon-btn" data-edit="${s.id}" aria-label="Editar ${esc(s.name)}">${icon('edit')}</button>
            <button class="icon-btn icon-btn--danger" data-del="${s.id}" aria-label="Excluir ${esc(s.name)}">${icon('trash')}</button>
          </td>
        </tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(list.find((s) => s.id === b.dataset.edit))));
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => remove(list.find((s) => s.id === b.dataset.del))));
    el.querySelectorAll('[data-toggle]').forEach((c) => c.addEventListener('change', async () => {
      const { error } = await supabase.from('services').update({ is_active: c.checked }).eq('id', c.dataset.toggle);
      if (error) { c.checked = !c.checked; toast({ type: 'error', message: errorMessage(error) }); return; }
      invalidate('services');
      toast({ type: 'success', message: c.checked ? 'Procedimento ativado.' : 'Procedimento desativado. Ele não aparece mais no site.' });
    }));
  } catch (err) {
    el.innerHTML = errorHTML(errorMessage(err));
  }
}

async function edit(s = null) {
  let imageUrl = s?.image_url || null;
  const current = s?.employee_services?.map((x) => x.employee_id) || [];
  const saved = await formModal({
    title: s ? 'Editar procedimento' : 'Novo procedimento',
    size: 'lg',
    values: s || { is_active: true, allow_on_site: true, payment_mode: 'full', sort_order: 0 },
    fields: [
      { name: 'image', type: 'html', full: true, html: `
        <div style="display:flex;gap:var(--space-4);align-items:center">
          <div class="img-preview" id="svc-preview">${imageUrl ? `<img src="${esc(imageUrl)}" alt="">` : ''}</div>
          <div class="stack"><label class="btn btn--outline btn--sm">${icon('image')} Escolher imagem<input type="file" id="svc-image" accept="image/jpeg,image/png,image/webp" class="sr-only"></label>
          <button type="button" class="link-btn" id="svc-image-remove">Remover imagem</button>
          <p class="hint">JPG, PNG ou WebP até 5 MB. Sem imagem, usamos a estampa da marca.</p></div>
        </div>` },
      { name: 'name', label: 'Nome', required: true, maxlength: 80 },
      { name: 'sort_order', label: 'Ordem de exibição', type: 'number', min: 0, step: 1, required: true },
      { name: 'description', label: 'Descrição', type: 'textarea', full: true, maxlength: 400, required: true },
      { name: 'price', label: 'Preço (R$)', type: 'number', min: 0, step: '0.01', required: true },
      { name: 'duration_minutes', label: 'Duração (minutos)', type: 'number', min: 5, max: 600, step: 5, required: true },
      { name: 'payment_mode', label: 'Cobrança', type: 'select', required: true, options: [
        { value: 'full', label: 'Pagamento integral online' }, { value: 'deposit', label: 'Sinal online + restante no local' }, { value: 'on_site', label: 'Pagamento presencial' }] },
      { name: 'deposit_amount', label: 'Valor do sinal (R$)', type: 'number', min: 0, step: '0.01', hint: 'Obrigatório quando a cobrança é por sinal.' },
      { name: 'allow_on_site', label: 'Permitir que a cliente escolha pagar no local', type: 'checkbox' },
      { name: 'is_active', label: 'Ativo (aparece no site)', type: 'checkbox' },
      { name: 'employees', type: 'html', full: true, html: `<span class="field-label">Profissionais habilitadas</span>
        <div class="chip-list">${employees.map((e) => `<label class="chip"><input type="checkbox" name="emp" value="${e.id}" ${current.includes(e.id) ? 'checked' : ''}>${esc(e.display_name)}</label>`).join('') || '<span class="muted">Cadastre profissionais em Equipe.</span>'}</div>` },
      ...(s?.is_test_data ? [{ name: 'is_test_data', label: 'Marcado como dado de teste (desmarque ao revisar)', type: 'checkbox' }] : []),
    ],
    validate: (v) => ({
      deposit_amount: v.payment_mode === 'deposit' && !(v.deposit_amount > 0) ? 'Informe o valor do sinal.'
        : v.deposit_amount != null && v.price != null && v.deposit_amount > v.price ? 'O sinal não pode ser maior que o preço.' : '',
    }),
    onOpen: (form) => {
      const preview = form.querySelector('#svc-preview');
      form.querySelector('#svc-image').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        preview.innerHTML = '<span class="spinner" style="margin:auto;color:var(--color-primary)"></span>';
        try {
          imageUrl = await uploadMedia(file, 'services');
          preview.innerHTML = `<img src="${esc(imageUrl)}" alt="">`;
        } catch (err) {
          preview.innerHTML = imageUrl ? `<img src="${esc(imageUrl)}" alt="">` : '';
          toast({ type: 'error', message: errorMessage(err, 'Não foi possível enviar a imagem.') });
        }
      });
      form.querySelector('#svc-image-remove').addEventListener('click', () => { imageUrl = null; preview.innerHTML = ''; });
      const mode = form.elements.payment_mode;
      const dep = form.elements.deposit_amount.closest('.field');
      const sync = () => { dep.hidden = mode.value !== 'deposit'; };
      mode.addEventListener('change', sync); sync();
    },
    onSubmit: async (v, form) => {
      const row = {
        name: v.name, description: v.description, price: v.price, duration_minutes: v.duration_minutes,
        payment_mode: v.payment_mode, deposit_amount: v.payment_mode === 'deposit' ? v.deposit_amount : null,
        allow_on_site: v.allow_on_site, is_active: v.is_active, sort_order: v.sort_order ?? 0, image_url: imageUrl,
      };
      if (s?.is_test_data) row.is_test_data = v.is_test_data;
      const saved = s
        ? unwrap(await supabase.from('services').update(row).eq('id', s.id).select('id').single())
        : unwrap(await supabase.from('services').insert(row).select('id').single());
      const checked = [...form.querySelectorAll('input[name="emp"]:checked')].map((i) => i.value);
      const add = checked.filter((id) => !current.includes(id));
      const del = current.filter((id) => !checked.includes(id));
      if (add.length) unwrap(await supabase.from('employee_services').insert(add.map((employee_id) => ({ employee_id, service_id: saved.id }))));
      if (del.length) unwrap(await supabase.from('employee_services').delete().eq('service_id', saved.id).in('employee_id', del));
    },
  });
  if (saved) { invalidate('services'); toast({ type: 'success', message: s ? 'Procedimento atualizado.' : 'Procedimento criado.' }); load(); }
}

async function remove(s) {
  const ok = await confirmDialog({
    title: 'Excluir procedimento?',
    message: `"${s.name}" será excluído. Se ele já tiver agendamentos, não é possível excluir: desative em vez disso para manter o histórico.`,
    confirmText: 'Excluir', danger: true,
  });
  if (!ok) return;
  const { error } = await supabase.from('services').delete().eq('id', s.id);
  if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
  invalidate('services');
  toast({ type: 'success', message: 'Procedimento excluído.' });
  load();
}

(async () => {
  try { await initAdminPage('procedimentos'); } catch { return; }
  employees = await supabase.from('employees').select('id, display_name').eq('is_active', true).order('display_name').then(unwrap).catch(() => []);
  document.getElementById('new-service').addEventListener('click', () => edit());
  load();
})();
