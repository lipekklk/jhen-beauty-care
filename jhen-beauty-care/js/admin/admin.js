/**
 * Base do painel administrativo: proteção de acesso, shell e um construtor
 * de formulários em modal reutilizado por todos os cadastros (CRUD).
 */
import { requireRole } from '../auth.js';
import { renderAppShell } from '../layout.js';
import { getSettings } from '../data.js';
import { esc } from '../utils.js';
import { openModal, toast, withLoading, setFieldError, clearErrors } from '../ui.js';
import { errorMessage } from '../utils.js';

/** Protege a página (somente admin), desenha o shell e devolve o perfil. */
export async function initAdminPage(active) {
  const profile = await requireRole(['admin']);
  await getSettings().catch(() => {});
  renderAppShell(profile, 'admin', active);
  return profile;
}

/**
 * Campos: { name, label, type, options:[{value,label}], required, hint, min, max, step,
 *           placeholder, full (ocupa linha inteira), html (conteúdo livre) }
 */
export function fieldHTML(f, value) {
  const id = `f-${f.name}`;
  const req = f.required ? 'required' : '';
  const common = `id="${id}" name="${f.name}" ${req} ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.step != null ? `step="${f.step}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.maxlength ? `maxlength="${f.maxlength}"` : ''}`;
  const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : '';
  const v = value ?? f.default ?? '';
  if (f.type === 'html') return `<div class="field" style="${f.full ? 'grid-column:1/-1' : ''}">${f.html}</div>`;
  if (f.type === 'checkbox') {
    return `<div class="field" style="${f.full !== false ? 'grid-column:1/-1' : ''}"><label class="switch"><input type="checkbox" ${common} ${v ? 'checked' : ''}><span class="switch__track"></span><span>${esc(f.label)}</span></label>${hint}</div>`;
  }
  let control;
  if (f.type === 'textarea') control = `<textarea class="textarea" ${common}>${esc(v)}</textarea>`;
  else if (f.type === 'select') {
    control = `<select class="select" ${common}>${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else control = `<input class="input" type="${f.type || 'text'}" ${common} value="${esc(v)}">`;
  return `<div class="field" style="${f.full ? 'grid-column:1/-1' : ''}"><label for="${id}">${esc(f.label)}${f.required ? '' : ' <span class="muted">(opcional)</span>'}</label>${control}${hint}</div>`;
}

/** Lê os valores do formulário convertendo tipos (number, checkbox, vazio → null). */
export function readForm(form, fields) {
  const out = {};
  fields.filter((f) => f.type !== 'html').forEach((f) => {
    const el = form.elements[f.name];
    if (!el) return;
    if (f.type === 'checkbox') out[f.name] = el.checked;
    else if (f.type === 'number') out[f.name] = el.value === '' ? null : Number(el.value);
    else out[f.name] = el.value.trim() === '' ? null : el.value.trim();
  });
  return out;
}

/**
 * Abre um formulário em modal.
 * onSubmit(values, form) deve lançar erro ou retornar; validate(values) retorna { campo: 'erro' }.
 */
export function formModal({ title, fields, values = {}, submitText = 'Salvar', onSubmit, validate, size, onOpen }) {
  return new Promise((resolve) => {
    let saved = false;
    const form = document.createElement('form');
    form.className = 'form';
    form.noValidate = true;
    form.innerHTML = `<div class="form-row">${fields.map((f) => fieldHTML(f, values[f.name])).join('')}</div>`;
    const footer = document.createElement('div');
    footer.style.display = 'contents';
    footer.innerHTML = `<button type="button" class="btn btn--ghost" data-x>Cancelar</button><button type="button" class="btn" data-ok>${esc(submitText)}</button>`;
    const m = openModal({ title, body: form, footer, size, onClose: () => resolve(saved) });
    onOpen?.(form, m);
    const submit = async () => {
      clearErrors(form);
      const vals = readForm(form, fields);
      const required = fields.filter((f) => f.required && (vals[f.name] === null || vals[f.name] === ''));
      required.forEach((f) => setFieldError(form.elements[f.name], 'Campo obrigatório.'));
      const errs = validate?.(vals, form) || {};
      Object.entries(errs).forEach(([k, msg]) => msg && setFieldError(form.elements[k], msg));
      const firstBad = form.querySelector('[aria-invalid="true"]');
      if (firstBad) { firstBad.focus(); return; }
      await withLoading(footer.querySelector('[data-ok]'), async () => {
        try {
          await onSubmit(vals, form);
          saved = true;
          m.close();
        } catch (err) {
          toast({ type: 'error', message: errorMessage(err) });
        }
      }, 'Salvando…');
    };
    footer.querySelector('[data-x]').addEventListener('click', () => m.close());
    footer.querySelector('[data-ok]').addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  });
}

/** Paginação simples para tabelas. */
export function paginationHTML(page, pageSize, total) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return `<div class="pagination"><span>${total} registro(s)</span>
    <span class="actions"><button class="btn btn--ghost btn--sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Anterior</button>
    <span style="align-self:center">${page} de ${pages}</span>
    <button class="btn btn--ghost btn--sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Próxima</button></span></div>`;
}
