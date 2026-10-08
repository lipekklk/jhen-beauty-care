/**
 * Componentes de interface: toast, modal, confirmação, loading, skeleton, estados vazios
 * e helpers de formulário. Tudo acessível (aria-live, foco preso no modal, Esc para fechar).
 */
import { icon } from './icons.js';
import { esc, url } from './utils.js';

/* ------------------------------------------------------------------ toast */
let region;
function toastRegion() {
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'false');
    document.body.appendChild(region);
  }
  return region;
}

/**
 * toast('Mensagem') | toast({ type: 'success'|'error'|'warning'|'info', title, message, timeout })
 */
export function toast(opts) {
  const o = typeof opts === 'string' ? { message: opts } : opts;
  const type = o.type || 'info';
  const iconName = { success: 'check', error: 'error', warning: 'alert', info: 'info' }[type];
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `
    <span class="toast__icon">${icon(iconName)}</span>
    <div>${o.title ? `<strong class="toast__title">${esc(o.title)}</strong>` : ''}${esc(o.message || '')}</div>
    <button class="toast__close" type="button" aria-label="Fechar aviso">${icon('close')}</button>`;
  const remove = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 250);
  };
  el.querySelector('.toast__close').addEventListener('click', remove);
  toastRegion().appendChild(el);
  const timeout = o.timeout ?? (type === 'error' ? 7000 : 4500);
  if (timeout) setTimeout(remove, timeout);
  return remove;
}
export const toastSuccess = (message, title) => toast({ type: 'success', message, title });
export const toastError = (message, title) => toast({ type: 'error', message, title });

/* ------------------------------------------------------------------ modal */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Abre um modal. body/footer podem ser string HTML (já escapada) ou Node.
 * Retorna { el, body, close }. onClose é chamado ao fechar por qualquer meio.
 */
export function openModal({ title, body = '', footer = '', size = '', onClose, dismissible = true } = {}) {
  const previous = document.activeElement;
  const id = `modal-${Math.random().toString(36).slice(2, 8)}`;
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `
    <div class="modal__backdrop" data-close></div>
    <div class="modal__dialog ${size === 'lg' ? 'modal__dialog--lg' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
      <div class="modal__head">
        <h2 id="${id}-title">${esc(title)}</h2>
        ${dismissible ? `<button class="modal__close" type="button" data-close aria-label="Fechar">${icon('close')}</button>` : ''}
      </div>
      <div class="modal__body"></div>
      <div class="modal__foot"></div>
    </div>`;
  const bodyEl = wrap.querySelector('.modal__body');
  const footEl = wrap.querySelector('.modal__foot');
  if (body instanceof Node) bodyEl.appendChild(body); else bodyEl.innerHTML = body;
  if (footer instanceof Node) footEl.appendChild(footer); else if (footer) footEl.innerHTML = footer; else footEl.remove();

  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    wrap.remove();
    if (!document.querySelector('.modal')) document.body.classList.remove('has-modal');
    previous?.focus?.();
    onClose?.(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const items = [...wrap.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]; const last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  if (dismissible) wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close()));
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  document.body.classList.add('has-modal');
  requestAnimationFrame(() => {
    const target = bodyEl.querySelector('[autofocus]') || bodyEl.querySelector(FOCUSABLE) || wrap.querySelector(FOCUSABLE);
    target?.focus();
  });
  return { el: wrap, body: bodyEl, foot: footEl, close };
}

/** Diálogo de confirmação. Resolve true/false. */
export function confirmDialog({ title = 'Confirmar', message = '', html = '', confirmText = 'Confirmar', cancelText = 'Voltar', danger = false } = {}) {
  return new Promise((resolve) => {
    const footer = document.createElement('div');
    footer.style.display = 'contents';
    footer.innerHTML = `
      <button type="button" class="btn btn--ghost" data-act="cancel">${esc(cancelText)}</button>
      <button type="button" class="btn ${danger ? 'btn--danger' : ''}" data-act="ok">${esc(confirmText)}</button>`;
    const m = openModal({ title, body: html || `<p>${esc(message)}</p>`, footer, onClose: (r) => resolve(Boolean(r)) });
    footer.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close(false));
    footer.querySelector('[data-act="ok"]').addEventListener('click', () => m.close(true));
  });
}

/* ------------------------------------------------------------------ loading */
/** Mostra spinner no botão enquanto a promise roda. Evita duplo clique. */
export async function withLoading(button, fn, loadingText) {
  if (!button) return fn();
  if (button.classList.contains('is-loading')) return undefined;
  const original = button.innerHTML;
  button.classList.add('is-loading');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="btn__label">${esc(loadingText || button.textContent.trim())}</span>`;
  try {
    return await fn();
  } finally {
    button.classList.remove('is-loading');
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = original;
  }
}

export const loaderHTML = (text = 'Carregando…') =>
  `<div class="page-loader" role="status"><img src="${url('assets/logo/libelula-vinho.png')}" alt="" width="64" height="50"><span>${esc(text)}</span></div>`;

export function skeletonHTML(lines = 3, { block = false } = {}) {
  if (block) return `<div class="skeleton skeleton--block" aria-hidden="true"></div>`;
  return `<div aria-hidden="true"><div class="skeleton skeleton--title"></div>${Array.from({ length: lines }, (_, i) =>
    `<div class="skeleton skeleton--text" style="width:${90 - i * 12}%"></div>`).join('')}</div><span class="sr-only">Carregando…</span>`;
}

/** Estado vazio com convite à ação. action = { label, href } ou { label, id } */
export function emptyHTML({ title, text = '', action } = {}) {
  let btn = '';
  if (action?.href) btn = `<a class="btn btn--outline" href="${esc(action.href)}">${esc(action.label)}</a>`;
  else if (action?.id) btn = `<button class="btn btn--outline" type="button" id="${esc(action.id)}">${esc(action.label)}</button>`;
  return `<div class="empty-state">
    <img src="${url('assets/logo/libelula-vinho.png')}" alt="" width="72" height="56" loading="lazy">
    <h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${btn}</div>`;
}

export const errorHTML = (message, retryId) =>
  `<div class="alert alert--error" role="alert">${icon('error')}<div><p>${esc(message)}</p>${retryId ? `<button class="link-btn" type="button" id="${esc(retryId)}">Tentar novamente</button>` : ''}</div></div>`;

/* ------------------------------------------------------------------ formulários */
export function setFieldError(input, message) {
  if (!input) return;
  const field = input.closest('.field');
  let el = field?.querySelector('.field-error');
  if (field && !el) {
    el = document.createElement('p');
    el.className = 'field-error';
    el.id = `${input.id || input.name}-error`;
    field.appendChild(el);
  }
  if (message) {
    input.setAttribute('aria-invalid', 'true');
    if (el) { el.textContent = message; input.setAttribute('aria-describedby', el.id); }
  } else {
    input.removeAttribute('aria-invalid');
    if (el) el.textContent = '';
  }
}
export function clearErrors(form) {
  form.querySelectorAll('[aria-invalid]').forEach((i) => setFieldError(i, ''));
}
/**
 * Valida um formulário com regras { nomeCampo: (valor, form) => 'erro' | '' }.
 * Mostra os erros e foca o primeiro campo inválido. Retorna true se válido.
 */
export function validate(form, rules) {
  clearErrors(form);
  let first = null;
  for (const [name, rule] of Object.entries(rules)) {
    const input = form.elements[name];
    if (!input) continue;
    const msg = rule(input.type === 'checkbox' ? input.checked : String(input.value).trim(), form);
    if (msg) { setFieldError(input, msg); first ||= input; }
  }
  first?.focus();
  return !first;
}

/** Botão de mostrar/ocultar senha em .input-group */
export function bindPasswordToggles(root = document) {
  root.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    const input = btn.closest('.input-group').querySelector('input');
    btn.innerHTML = icon('eye');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = icon(show ? 'eyeOff' : 'eye');
      btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    });
  });
}

/** Liga um grupo de abas (role=tablist) aos painéis [data-panel]. */
export function bindTabs(tablist, onChange) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const select = (tab, focus = false) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
    onChange?.(tab.dataset.tab);
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') select(tabs[(i + 1) % tabs.length], true);
      if (e.key === 'ArrowLeft') select(tabs[(i - 1 + tabs.length) % tabs.length], true);
    });
  });
  return { select: (name) => select(tabs.find((t) => t.dataset.tab === name) || tabs[0]) };
}
