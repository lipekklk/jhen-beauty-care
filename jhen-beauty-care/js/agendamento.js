/**
 * Fluxo de agendamento (agendamento.html)
 * 1 Procedimento → 2 Profissional → 3 Data e horário → 4 Resumo e pagamento → 5 Confirmação
 *
 * Todas as regras (horário livre, funcionamento, bloqueios, conflitos) são revalidadas
 * no banco pela função book_appointment. O front só guia a cliente.
 */
import { renderPublicHeader, renderPublicFooter } from './layout.js';
import { getActiveServices, getEmployeesForService, getSettings, bookAppointment } from './data.js';
import { createDateTimePicker } from './calendar.js';
import { startCheckout, checkoutErrorMessage } from './pagamentos.js';
import { getSession, getProfile } from './auth.js';
import { supabaseReady } from './supabase.js';
import {
  esc, url, fmtMoney, fmtDuration, fmtTime, fmtDateLong, getParam, errorMessage, initials, firstName,
  METHOD_LABELS, testBadge, waLink,
} from './utils.js';
import { toast, withLoading, emptyHTML, errorHTML, skeletonHTML } from './ui.js';
import { icon } from './icons.js';

const DRAFT_KEY = 'jhen:booking-draft';
const STEPS = ['Procedimento', 'Profissional', 'Data e horário', 'Resumo e pagamento', 'Confirmação'];

const state = {
  step: 1,
  services: [],
  service: null,
  employees: [],
  employee: null,      // null = sem preferência
  slot: null,          // { slot_start, slot_end, employee_id, employee_name, date }
  method: null,
  notes: '',
  settings: null,
  booking: null,       // resposta do book_appointment
  picker: null,
  onlineEnabled: false, // Mercado Pago configurado pela administração
};

const stepsEl = document.getElementById('steps');
const container = document.getElementById('step-container');
const summaryEl = document.getElementById('summary');

/* ------------------------------------------------------------------ helpers */
function saveDraft() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      serviceId: state.service?.id, employeeId: state.employee?.id || null, slot: state.slot, method: state.method, notes: state.notes,
    }));
  } catch { /* armazenamento indisponível: segue sem rascunho */ }
}
function readDraft() {
  try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
}
function clearDraft() { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } }

function allowedMethods() {
  const s = state.service;
  if (!s) return [];
  if (s.payment_mode === 'on_site') return ['on_site'];
  const list = [];
  // a escolha entre cartão de crédito, débito ou Pix acontece dentro do Mercado Pago
  if (state.onlineEnabled) list.push('online');
  if (s.allow_on_site && state.settings?.on_site_payment_enabled) list.push('on_site');
  return list;
}
function amountNow() {
  const s = state.service;
  if (!s || state.method === 'on_site' || s.payment_mode === 'on_site') return 0;
  return s.payment_mode === 'deposit' ? Number(s.deposit_amount) : Number(s.price);
}
const singleEmployee = () => state.employees.length === 1;

/* ------------------------------------------------------------------ renderização */
function renderSteps() {
  stepsEl.innerHTML = STEPS.map((label, i) => {
    const n = i + 1;
    const cls = n < state.step ? 'is-done' : '';
    return `<li class="${cls}" ${n === state.step ? 'aria-current="step"' : ''}>${label}</li>`;
  }).join('');
  // no celular a barra de etapas rola: mantém a etapa atual visível
  const current = stepsEl.querySelector('[aria-current="step"]');
  if (current) stepsEl.scrollLeft = current.offsetLeft - (stepsEl.clientWidth - current.offsetWidth) / 2;
}

function renderSummary() {
  const s = state.service;
  if (!s || state.step === 5) { summaryEl.hidden = true; return; }
  summaryEl.hidden = false;
  const empName = state.slot?.employee_name && state.employee ? state.employee.display_name
    : state.employee ? state.employee.display_name : (singleEmployee() ? state.employees[0].display_name : 'Sem preferência');
  summaryEl.innerHTML = `
    <h2 class="h4" style="font-size:var(--fs-xl)">Seu agendamento</h2>
    <dl>
      <div><dt>Procedimento</dt><dd>${esc(s.name)}</dd></div>
      <div><dt>Duração</dt><dd>${fmtDuration(s.duration_minutes)}</dd></div>
      ${state.step >= 2 ? `<div><dt>Profissional</dt><dd>${esc(empName)}</dd></div>` : ''}
      ${state.slot ? `<div><dt>Data</dt><dd>${esc(fmtDateLong(state.slot.slot_start))}</dd></div>
      <div><dt>Horário</dt><dd>${fmtTime(state.slot.slot_start)} às ${fmtTime(state.slot.slot_end)}</dd></div>` : ''}
      ${state.method ? `<div><dt>Pagamento</dt><dd>${state.method === 'on_site' ? 'No estúdio' : METHOD_LABELS[state.method]}</dd></div>` : ''}
      <div class="summary__total"><dt>Total</dt><dd>${fmtMoney(s.price)}</dd></div>
      ${state.method && state.method !== 'on_site' && s.payment_mode === 'deposit'
        ? `<div><dt>Sinal agora</dt><dd>${fmtMoney(s.deposit_amount)}</dd></div><div><dt>Restante no dia</dt><dd>${fmtMoney(s.price - s.deposit_amount)}</dd></div>` : ''}
    </dl>`;
}

function go(step) {
  state.step = step;
  renderSteps();
  renderSummary();
  const fn = { 1: stepService, 2: stepEmployee, 3: stepDateTime, 4: stepReview }[step];
  fn?.();
  container.querySelector('h2')?.setAttribute('tabindex', '-1');
  container.querySelector('h2')?.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------------ 1. procedimento */
function stepService() {
  if (!state.services.length) {
    container.innerHTML = `<div class="step-panel">${emptyHTML({ title: 'Nenhum procedimento disponível', text: 'Volte mais tarde ou fale com o estúdio pelo WhatsApp.' })}</div>`;
    return;
  }
  container.innerHTML = `
    <section class="step-panel" aria-labelledby="st1">
      <h2 id="st1">Qual procedimento você quer fazer?</h2>
      <div class="choice-list" role="list">
        ${state.services.map((s) => `
          <button type="button" class="choice" role="listitem" data-id="${s.id}" aria-pressed="${state.service?.id === s.id}">
            <span class="choice__thumb">${s.image_url ? `<img src="${esc(s.image_url)}" alt="" loading="lazy">` : ''}</span>
            <span><span class="choice__title">${esc(s.name)} ${testBadge(s.is_test_data)}</span>
              <span class="choice__desc">${fmtDuration(s.duration_minutes)}${s.payment_mode === 'deposit' ? ` · sinal de ${fmtMoney(s.deposit_amount)}` : ''}</span></span>
            <span class="choice__price">${fmtMoney(s.price)}</span>
          </button>`).join('')}
      </div>
    </section>`;
  container.querySelectorAll('.choice').forEach((btn) => btn.addEventListener('click', () => selectService(btn.dataset.id)));
}

async function selectService(id) {
  const service = state.services.find((s) => s.id === id);
  if (!service) return;
  if (state.service?.id !== id) { state.slot = null; state.employee = null; state.method = null; }
  state.service = service;
  container.innerHTML = skeletonHTML(3);
  try {
    state.employees = await getEmployeesForService(id);
  } catch (err) {
    container.innerHTML = errorHTML(errorMessage(err));
    return;
  }
  if (!state.employees.length) {
    go(1);
    toast({ type: 'warning', message: 'Este procedimento está sem profissionais disponíveis no momento. Escolha outro ou fale com o estúdio.' });
    return;
  }
  if (singleEmployee()) { state.employee = state.employees[0]; go(3); } else go(2);
}

/* ------------------------------------------------------------------ 2. profissional */
function stepEmployee() {
  container.innerHTML = `
    <section class="step-panel" aria-labelledby="st2">
      <h2 id="st2">Com quem você quer agendar?</h2>
      <div class="choice-list">
        <button type="button" class="choice" data-id="" aria-pressed="${state.employee === null}">
          <span class="choice__avatar">${icon('sparkle')}</span>
          <span><span class="choice__title">Sem preferência</span><span class="choice__desc">Mostra todos os horários livres da equipe</span></span>
          <span></span>
        </button>
        ${state.employees.map((e) => `
          <button type="button" class="choice" data-id="${e.id}" aria-pressed="${state.employee?.id === e.id}">
            <span class="choice__avatar">${e.photo_url ? `<img src="${esc(e.photo_url)}" alt="">` : esc(initials(e.display_name))}</span>
            <span><span class="choice__title">${esc(e.display_name)} ${testBadge(e.is_test_data)}</span><span class="choice__desc">${esc(e.title)}</span></span>
            <span></span>
          </button>`).join('')}
      </div>
      <div class="step-actions"><button type="button" class="btn btn--ghost" data-back>${icon('chevronLeft')} Voltar</button></div>
    </section>`;
  container.querySelectorAll('.choice').forEach((btn) => btn.addEventListener('click', () => {
    const emp = state.employees.find((e) => e.id === btn.dataset.id) || null;
    if (emp?.id !== state.employee?.id) state.slot = null;
    state.employee = emp;
    go(3);
  }));
  container.querySelector('[data-back]').addEventListener('click', () => go(1));
}

/* ------------------------------------------------------------------ 3. data e horário */
function stepDateTime() {
  container.innerHTML = `
    <section class="step-panel" aria-labelledby="st3">
      <h2 id="st3">Escolha o dia e o horário</h2>
      <p class="muted">Mostramos só os horários livres para ${esc(state.service.name.toLowerCase())} (${fmtDuration(state.service.duration_minutes)})${state.employee ? ` com ${esc(state.employee.display_name)}` : ''}.</p>
      <div id="picker"></div>
      <div class="step-actions">
        <button type="button" class="btn btn--ghost" data-back>${icon('chevronLeft')} Voltar</button>
        <button type="button" class="btn" data-next disabled>Continuar</button>
      </div>
    </section>`;
  const next = container.querySelector('[data-next]');
  state.picker = createDateTimePicker(container.querySelector('#picker'), {
    serviceId: state.service.id,
    employeeId: state.employee?.id || null,
    onSelect: (slot) => {
      state.slot = slot;
      next.disabled = !slot;
      renderSummary();
    },
  });
  next.addEventListener('click', () => state.slot && go(4));
  container.querySelector('[data-back]').addEventListener('click', () => go(singleEmployee() ? 1 : 2));
}

/* ------------------------------------------------------------------ 4. resumo e pagamento */
async function stepReview() {
  const methods = allowedMethods();
  if (!methods.includes(state.method)) state.method = methods[0] || null;
  const session = await getSession();
  const s = state.service;
  const due = () => amountNow();
  const methodInfo = {
    online: ['lock', 'Pagar online', 'Cartão de crédito, débito ou Pix pelo Mercado Pago'],
    on_site: ['store', 'No estúdio', 'Pague no dia do atendimento'],
  };

  container.innerHTML = `
    <section class="step-panel" aria-labelledby="st4">
      <h2 id="st4">Confira e escolha como pagar</h2>
      <div class="panel" style="margin-bottom:var(--space-5)">
        <p style="margin:0"><strong>${esc(s.name)}</strong>${state.employee ? ` com ${esc(state.employee.display_name)}` : ''}<br>
        <span class="muted">${esc(fmtDateLong(state.slot.slot_start))}, das ${fmtTime(state.slot.slot_start)} às ${fmtTime(state.slot.slot_end)}</span></p>
      </div>
      <fieldset style="border:0;padding:0;margin:0 0 var(--space-5)">
        <legend class="field-label" style="margin-bottom:var(--space-3)">Forma de pagamento</legend>
        ${methods.length ? '' : `<div class="alert alert--warning">${icon('alert')}<p>O pagamento online deste procedimento está indisponível no momento. Fale com o estúdio pelo WhatsApp para agendar.</p></div>`}
        <div class="pay-methods" role="radiogroup" style="${methods.length > 1 ? '' : 'grid-template-columns:1fr'}">
          ${methods.map((m) => `
            <button type="button" class="choice pay-method" role="radio" data-method="${m}" aria-checked="${state.method === m}">
              ${icon(methodInfo[m][0])}<span><span class="choice__title">${methodInfo[m][1]}</span><span class="choice__desc">${methodInfo[m][2]}</span></span>
            </button>`).join('')}
        </div>
        <p class="muted" id="due-text" style="margin-top:var(--space-3)"></p>
        <div class="secure-note" id="secure-note" hidden>
          ${icon('shield')}
          <p>Você será levada ao <strong>ambiente seguro do Mercado Pago</strong> para pagar. Os dados do cartão são digitados lá: não pedimos nem guardamos número do cartão ou código de segurança. O horário fica reservado por ${state.settings?.payment_hold_minutes || 15} minutos e é confirmado assim que o Mercado Pago aprovar o pagamento.</p>
        </div>
      </fieldset>
      <div class="field">
        <label for="notes">Observações para a profissional <span class="muted">(opcional)</span></label>
        <textarea class="textarea" id="notes" maxlength="500" placeholder="Ex.: primeira vez, alergia a algum produto, preferências de formato">${esc(state.notes)}</textarea>
      </div>
      <div class="alert alert--info" style="margin-top:var(--space-5)">${icon('info')}<p id="policy">${esc(state.settings?.cancellation_policy_text || '')}</p></div>
      <div class="step-actions">
        <button type="button" class="btn btn--ghost" data-back>${icon('chevronLeft')} Voltar</button>
        <button type="button" class="btn btn--lg" data-confirm></button>
      </div>
    </section>`;

  const confirmBtn = container.querySelector('[data-confirm]');
  const dueText = container.querySelector('#due-text');
  const refresh = () => {
    const value = due();
    container.querySelector('#secure-note').hidden = state.method !== 'online';
    confirmBtn.disabled = !state.method;
    if (!state.method) { dueText.textContent = ''; confirmBtn.textContent = 'Indisponível'; renderSummary(); return; }
    dueText.textContent = state.method === 'on_site' || s.payment_mode === 'on_site'
      ? `Você paga ${fmtMoney(s.price)} no estúdio, no dia do atendimento.`
      : s.payment_mode === 'deposit'
        ? `Agora você paga o sinal de ${fmtMoney(value)}. O restante (${fmtMoney(s.price - value)}) é pago no estúdio.`
        : `Você paga ${fmtMoney(value)} agora para confirmar o horário.`;
    confirmBtn.textContent = !session ? 'Entrar para confirmar'
      : value > 0 ? `Pagar ${fmtMoney(value)} com Mercado Pago` : 'Confirmar agendamento';
    renderSummary();
  };
  refresh();

  container.querySelectorAll('[data-method]').forEach((btn) => btn.addEventListener('click', () => {
    state.method = btn.dataset.method;
    container.querySelectorAll('[data-method]').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
    refresh();
  }));
  container.querySelector('#notes').addEventListener('input', (e) => { state.notes = e.target.value; });
  container.querySelector('[data-back]').addEventListener('click', () => go(3));
  confirmBtn.addEventListener('click', () => {
    if (!session) {
      saveDraft();
      location.href = url(`login.html?next=${encodeURIComponent('agendamento.html?retomar=1')}`);
      return;
    }
    confirmBooking(confirmBtn);
  });
}

async function confirmBooking(btn) {
  const profile = await getProfile().catch(() => null);
  if (profile?.is_blocked) {
    toast({ type: 'error', message: errorMessage({ message: 'ACCOUNT_BLOCKED' }) });
    return;
  }
  await withLoading(btn, async () => {
    try {
      // reaproveita uma reserva pendente do mesmo horário (ex.: pagamento recusado e nova tentativa)
      if (!state.booking || state.booking.status !== 'pending_payment' || state.booking._slot !== state.slot.slot_start) {
        state.booking = await bookAppointment({
          p_service_id: state.service.id,
          p_starts_at: state.slot.slot_start,
          p_employee_id: state.employee?.id || null,
          p_payment_method: state.method,
          p_notes: state.notes || null,
        });
        state.booking._slot = state.slot.slot_start;
      }
    } catch (err) {
      const msg = errorMessage(err, 'Não foi possível concluir o agendamento. Tente novamente.');
      toast({ type: 'error', message: msg });
      if (/SLOT_TAKEN|SLOT_UNAVAILABLE/.test(err.message)) { state.slot = null; go(3); }
      return;
    }
    clearDraft();
    if (state.booking.status !== 'pending_payment') { finish('scheduled'); return; }

    // Pagamento online: o servidor cria o checkout do Mercado Pago com o valor do banco
    const label = btn.querySelector('.btn__label');
    if (label) label.textContent = 'Preparando pagamento seguro…';
    try {
      await startCheckout(state.booking.payment_id); // redireciona para o Mercado Pago
    } catch (err) {
      toast({ type: 'error', message: checkoutErrorMessage(err) });
      if (/PAYMENT_EXPIRED/.test(err.message)) { state.booking = null; state.slot = null; go(3); }
      if (/ALREADY_PAID|PAYMENT_IN_PROCESS/.test(err.message)) location.href = url(`pagamento.html?ref=${state.booking.payment_id}`);
      // demais erros: a reserva continua; a cliente pode tentar de novo ou pagar em "Minhas compras"
    }
  }, 'Confirmando…');
}

/* ------------------------------------------------------------------ 5. confirmação */
function icsFile() {
  const fmt = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//JHEN beauty care//Agendamento//PT',
    'BEGIN:VEVENT', `UID:${state.booking.appointment_id}@jhen`, `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(state.slot.slot_start)}`, `DTEND:${fmt(state.slot.slot_end)}`,
    `SUMMARY:${state.service.name} — JHEN beauty care`,
    state.settings?.address ? `LOCATION:${state.settings.address.replace(/[,;]/g, ' ')}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
}

async function finish(kind) {
  state.step = 5;
  renderSteps();
  renderSummary();
  const profile = await getProfile().catch(() => null);
  const titles = { scheduled: 'Seu agendamento foi confirmado!' };
  container.innerHTML = `
    <section class="step-panel panel text-center" aria-labelledby="st5">
      <div class="success-mark" ${kind === 'pending' ? 'style="background:var(--color-warning-soft);color:var(--color-warning)"' : ''}>${icon(kind === 'pending' ? 'clock' : 'check')}</div>
      <h2 id="st5">${titles[kind]}</h2>
      <p class="muted" style="margin-inline:auto">${profile ? `${esc(firstName(profile.full_name))}, ` : ''}${esc(state.service.name)} em ${esc(fmtDateLong(state.slot.slot_start))}, às ${fmtTime(state.slot.slot_start)}.
      ${kind === 'pending' ? 'Conclua o pagamento em "Meus agendamentos" antes que a reserva expire.' : 'Você também recebe esta confirmação na sua área de cliente.'}</p>
      <div class="actions" style="justify-content:center;margin-top:var(--space-5)">
        <a class="btn" href="${url('cliente/agendamentos.html')}">${kind === 'pending' ? 'Pagar agora' : 'Ver meus agendamentos'}</a>
        ${kind !== 'pending' ? `<a class="btn btn--outline" href="${icsFile()}" download="agendamento-jhen.ics">${icon('calendar')} Adicionar à agenda</a>` : ''}
        ${state.settings?.whatsapp ? `<a class="btn btn--ghost" href="${waLink(state.settings.whatsapp, `Olá! Acabei de agendar ${state.service.name} para ${fmtDateLong(state.slot.slot_start)} às ${fmtTime(state.slot.slot_start)}.`)}" target="_blank" rel="noopener">${icon('whatsapp')} Avisar no WhatsApp</a>` : ''}
      </div>
    </section>`;
  container.querySelector('h2').focus?.();
}

/* ------------------------------------------------------------------ init */
async function init() {
  renderPublicHeader('agendamento');
  renderPublicFooter();
  renderSteps();
  if (!supabaseReady) {
    container.innerHTML = errorHTML(errorMessage({ message: 'CONFIG_MISSING' }));
    return;
  }
  container.innerHTML = skeletonHTML(4);
  try {
    [state.services, state.settings] = await Promise.all([getActiveServices(), getSettings()]);
    state.onlineEnabled = state.settings?.payment_provider === 'mercadopago';
  } catch (err) {
    container.innerHTML = errorHTML(errorMessage(err, 'Não foi possível carregar os procedimentos.'), 'retry');
    document.getElementById('retry')?.addEventListener('click', init);
    return;
  }

  const draft = getParam('retomar') ? readDraft() : null;
  const preselect = draft?.serviceId || getParam('servico');
  if (preselect && state.services.some((s) => s.id === preselect)) {
    await selectService(preselect);
    if (draft) {
      state.employee = state.employees.find((e) => e.id === draft.employeeId) || (singleEmployee() ? state.employees[0] : null);
      state.method = draft.method;
      state.notes = draft.notes || '';
      if (draft.slot && new Date(draft.slot.slot_start) > new Date()) { state.slot = draft.slot; go(4); }
      else go(3);
    }
    return;
  }
  go(1);
}

init();
