/**
 * Seletor de data e horário com disponibilidade real (consulta o banco).
 * Usado no agendamento, na remarcação e na criação de agendamento pelo admin.
 *
 *   const picker = createDateTimePicker(el, { serviceId, employeeId, ignoreAppointment, onSelect });
 *   picker.update({ employeeId }) · picker.reset()
 */
import { getMonthAvailability, getAvailableSlots, getSettings } from './data.js';
import { esc, fmtTime, todayKey, addDaysKey, keyToDate, fmtKeyLong, errorMessage } from './utils.js';
import { icon } from './icons.js';
import { errorHTML } from './ui.js';

const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function createDateTimePicker(root, options) {
  const state = {
    serviceId: options.serviceId,
    employeeId: options.employeeId || null,
    ignoreAppointment: options.ignoreAppointment || null,
    month: todayKey().slice(0, 7) + '-01',
    availability: {},
    selectedDate: null,
    selectedSlot: null,
    maxKey: addDaysKey(todayKey(), 60),
    reqId: 0,
  };

  root.innerHTML = `
    <div class="datetime-picker">
      <div class="calendar" aria-live="polite">
        <div class="calendar__head">
          <button type="button" class="calendar__nav" data-nav="-1" aria-label="Mês anterior">${icon('chevronLeft')}</button>
          <h3 class="calendar__title" id="cal-title"></h3>
          <button type="button" class="calendar__nav" data-nav="1" aria-label="Próximo mês">${icon('chevronRight')}</button>
        </div>
        <div class="calendar__grid" role="group" aria-labelledby="cal-title"></div>
        <div class="calendar__legend" aria-hidden="true">
          <span><i style="background:var(--color-primary-soft)"></i>com horários</span>
          <span><i style="background:var(--color-primary)"></i>selecionado</span>
          <span><i style="background:var(--color-border)"></i>indisponível</span>
        </div>
      </div>
      <div class="slots-panel">
        <p class="muted" data-slots-hint>Escolha um dia no calendário para ver os horários livres.</p>
        <div data-slots></div>
      </div>
    </div>`;

  const cal = root.querySelector('.calendar');
  const grid = root.querySelector('.calendar__grid');
  const title = root.querySelector('.calendar__title');
  const slotsEl = root.querySelector('[data-slots]');
  const hint = root.querySelector('[data-slots-hint]');
  const prevBtn = root.querySelector('[data-nav="-1"]');
  const nextBtn = root.querySelector('[data-nav="1"]');

  getSettings().then((s) => { state.maxKey = addDaysKey(todayKey(), s.max_advance_days); updateNav(); }).catch(() => {});

  function monthShift(delta) {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return d.toISOString().slice(0, 10);
  }
  function updateNav() {
    prevBtn.disabled = state.month <= todayKey().slice(0, 7) + '-01';
    nextBtn.disabled = monthShift(1) > state.maxKey;
  }

  async function loadMonth() {
    const req = ++state.reqId;
    cal.classList.add('is-loading');
    renderGrid();
    try {
      const rows = await getMonthAvailability(state.serviceId, state.month, state.employeeId);
      if (req !== state.reqId) return;
      state.availability = Object.fromEntries(rows.map((r) => [r.day, r.available_slots]));
      renderGrid();
      // seleciona automaticamente o primeiro dia disponível no primeiro carregamento
      if (!state.selectedDate) {
        const first = rows.find((r) => r.available_slots > 0);
        if (first) selectDate(first.day, false);
        else hint.textContent = 'Sem horários livres neste mês. Veja o próximo mês.';
      }
    } catch (err) {
      if (req !== state.reqId) return;
      slotsEl.innerHTML = errorHTML(errorMessage(err, 'Não foi possível carregar a agenda.'));
    } finally {
      if (req === state.reqId) cal.classList.remove('is-loading');
    }
  }

  function renderGrid() {
    const first = keyToDate(state.month);
    const label = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(first);
    title.textContent = label.charAt(0).toUpperCase() + label.slice(1); // "Outubro de 2026"
    const offset = first.getUTCDay();
    const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const today = todayKey();
    let html = DOW.map((d) => `<span class="calendar__dow">${d}</span>`).join('');
    for (let i = 0; i < offset; i++) html += '<span class="calendar__day is-empty" aria-hidden="true"></span>';
    for (let d = 1; d <= days; d++) {
      const key = `${state.month.slice(0, 8)}${String(d).padStart(2, '0')}`;
      const count = state.availability[key];
      const available = count > 0;
      const cls = ['calendar__day', available ? 'is-available' : 'is-unavailable', key === today ? 'is-today' : ''].join(' ');
      const label = `${fmtKeyLong(key)}${available ? `, ${count} horário${count > 1 ? 's' : ''} livre${count > 1 ? 's' : ''}` : ', indisponível'}`;
      html += `<button type="button" class="${cls}" data-date="${key}" aria-label="${esc(label)}" aria-pressed="${key === state.selectedDate}" ${available ? '' : 'aria-disabled="true"'}>${d}</button>`;
    }
    grid.innerHTML = html;
    updateNav();
  }

  async function selectDate(key, focusSlots = true) {
    state.selectedDate = key;
    state.selectedSlot = null;
    options.onSelect?.(null);
    grid.querySelectorAll('.calendar__day').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === key)));
    hint.textContent = `Horários para ${fmtKeyLong(key)}`;
    slotsEl.innerHTML = '<div class="slots">' + Array.from({ length: 6 }, () => '<span class="skeleton" style="height:48px;border-radius:999px"></span>').join('') + '</div>';
    try {
      const rows = await getAvailableSlots(state.serviceId, key, state.employeeId, state.ignoreAppointment);
      if (state.selectedDate !== key) return;
      renderSlots(rows, focusSlots);
    } catch (err) {
      slotsEl.innerHTML = errorHTML(errorMessage(err, 'Não foi possível carregar os horários.'));
    }
  }

  function renderSlots(rows, focusSlots) {
    // um horário pode estar livre para várias profissionais: mostra uma vez
    const unique = [...new Map(rows.map((r) => [r.slot_start, r])).values()]
      .sort((a, b) => new Date(a.slot_start) - new Date(b.slot_start));
    if (!unique.length) {
      slotsEl.innerHTML = '<p class="muted">Os horários deste dia acabaram de ser preenchidos. Escolha outro dia.</p>';
      return;
    }
    const groups = { manhã: [], tarde: [], noite: [] };
    unique.forEach((r) => {
      const h = Number(fmtTime(r.slot_start).slice(0, 2));
      groups[h < 12 ? 'manhã' : h < 18 ? 'tarde' : 'noite'].push(r);
    });
    slotsEl.innerHTML = Object.entries(groups).filter(([, list]) => list.length).map(([label, list]) => `
      <div class="slots-group">
        <p class="slots-group__label">${label}</p>
        <div class="slots" role="group" aria-label="Horários da ${label}">
          ${list.map((r) => `<button type="button" class="slot" data-start="${esc(r.slot_start)}" aria-pressed="false">${fmtTime(r.slot_start)}</button>`).join('')}
        </div>
      </div>`).join('');
    state.rows = unique;
    if (focusSlots) slotsEl.querySelector('.slot')?.focus({ preventScroll: true });
  }

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.calendar__day[data-date]');
    if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
    selectDate(btn.dataset.date);
  });
  slotsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.slot');
    if (!btn) return;
    slotsEl.querySelectorAll('.slot').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    const row = state.rows.find((r) => r.slot_start === btn.dataset.start);
    state.selectedSlot = row;
    options.onSelect?.({ ...row, date: state.selectedDate });
  });
  prevBtn.addEventListener('click', () => { state.month = monthShift(-1); state.selectedDate = null; loadMonth(); });
  nextBtn.addEventListener('click', () => { state.month = monthShift(1); state.selectedDate = null; loadMonth(); });

  loadMonth();

  return {
    update(params) {
      Object.assign(state, params, { selectedDate: null, selectedSlot: null, availability: {} });
      slotsEl.innerHTML = '';
      hint.textContent = 'Escolha um dia no calendário para ver os horários livres.';
      options.onSelect?.(null);
      loadMonth();
    },
    /** Recarrega mês e dia (ex.: após "horário acabou de ser reservado"). */
    refresh() {
      const day = state.selectedDate;
      state.selectedSlot = null;
      options.onSelect?.(null);
      loadMonth().then(() => { if (day) selectDate(day, false); });
    },
    get selection() { return state.selectedSlot ? { ...state.selectedSlot, date: state.selectedDate } : null; },
  };
}
