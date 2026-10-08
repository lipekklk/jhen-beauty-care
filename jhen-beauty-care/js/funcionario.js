/**
 * Área da profissional: dashboard.html (hoje) e agenda.html (pasta /funcionario).
 * Dados de clientes vêm da função get_employee_agenda, que devolve só o necessário
 * para o atendimento (nome, telefone, procedimento, observações) e nada financeiro.
 */
import { supabase } from './supabase.js';
import { requireRole } from './auth.js';
import { renderAppShell } from './layout.js';
import { getSettings, updateAppointmentStatus } from './data.js';
import {
  esc, fmtTime, fmtDuration, fmtKeyLong, statusBadge, STATUS_LABELS, errorMessage, unwrap, todayKey, addDaysKey,
  weekdayOfKey, localToISO, dateKey, firstName, testBadge, onlyDigits, fmtKeyShort,
} from './utils.js';
import { toast, emptyHTML, errorHTML, skeletonHTML, confirmDialog, openModal, withLoading } from './ui.js';
import { icon } from './icons.js';

const page = document.body.dataset.page;
let profile;

const STAFF_STATUSES = ['scheduled', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show', 'cancelled'];

async function fetchAgenda(fromKey, toKeyExclusive) {
  return unwrap(await supabase.rpc('get_employee_agenda', {
    p_from: localToISO(fromKey, '00:00'),
    p_to: localToISO(toKeyExclusive, '00:00'),
    p_employee_id: profile.employee_id,
  }));
}

function statusSelect(a) {
  const locked = ['cancelled', 'pending_payment'].includes(a.status);
  if (locked) return statusBadge(a.status);
  return `<label class="sr-only" for="st-${a.id}">Status do atendimento</label>
    <select class="select" id="st-${a.id}" data-status="${a.id}" style="min-height:40px;width:auto">
      ${STAFF_STATUSES.map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
    </select>`;
}

function itemHTML(a, { now = new Date() } = {}) {
  const live = new Date(a.starts_at) <= now && new Date(a.ends_at) > now && !['cancelled', 'no_show', 'completed'].includes(a.status);
  const past = new Date(a.ends_at) < now;
  return `
    <li class="appt ${live ? 'is-now' : ''} ${past ? 'is-past' : ''}">
      <div class="appt__time"><strong>${fmtTime(a.starts_at)}</strong><span>até ${fmtTime(a.ends_at)}</span></div>
      <div>
        <p class="appt__title">${esc(a.client_name || 'Cliente')} ${testBadge(a.is_test_data)}</p>
        <div class="appt__meta">
          <span>${esc(a.service_name)} (${fmtDuration(a.duration_minutes)})</span>
          ${a.client_phone ? `<a href="tel:${onlyDigits(a.client_phone)}">${icon('phone')} ${esc(a.client_phone)}</a>` : ''}
          <span>${esc(a.payment_status)}</span>
          ${!profile.employee_id ? `<span>com ${esc(a.employee_name)}</span>` : ''}
        </div>
        ${a.notes ? `<p class="muted" style="margin:var(--space-2) 0 0;font-size:var(--fs-sm)">${icon('message')} ${esc(a.notes)}</p>` : ''}
      </div>
      <div class="appt__side">
        ${statusSelect(a)}
        ${['cancelled', 'completed', 'no_show'].includes(a.status) ? '' : `<button class="btn btn--ghost btn--sm" data-change="${a.id}">Pedir alteração</button>`}
      </div>
    </li>`;
}

function bindItems(root, list, reload) {
  root.querySelectorAll('[data-status]').forEach((sel) => {
    const a = list.find((x) => x.id === sel.dataset.status);
    sel.addEventListener('change', async () => {
      const next = sel.value;
      if (next === 'cancelled' || next === 'no_show') {
        const ok = await confirmDialog({
          title: next === 'cancelled' ? 'Cancelar atendimento?' : 'Marcar como não compareceu?',
          message: `${a.client_name}, ${a.service_name} às ${fmtTime(a.starts_at)}. A cliente será avisada${next === 'cancelled' ? ' e o horário fica livre' : ''}.`,
          confirmText: next === 'cancelled' ? 'Cancelar atendimento' : 'Confirmar', danger: true,
        });
        if (!ok) { sel.value = a.status; return; }
      }
      sel.disabled = true;
      try {
        await updateAppointmentStatus(a.id, next);
        toast({ type: 'success', message: `Status alterado para "${STATUS_LABELS[next]}".` });
        reload();
      } catch (err) {
        sel.value = a.status;
        toast({ type: 'error', message: errorMessage(err) });
      } finally { sel.disabled = false; }
    });
  });
  root.querySelectorAll('[data-change]').forEach((btn) => btn.addEventListener('click', () => {
    const a = list.find((x) => x.id === btn.dataset.change);
    const body = `<p class="muted">${esc(a.client_name)}, ${esc(a.service_name)} às ${fmtTime(a.starts_at)}. A administração recebe seu pedido.</p>
      <div class="field"><label for="change-msg">O que precisa mudar?</label><textarea class="textarea" id="change-msg" maxlength="500" placeholder="Ex.: preciso trocar para o fim da tarde"></textarea></div>`;
    const footer = document.createElement('div');
    footer.style.display = 'contents';
    footer.innerHTML = '<button class="btn btn--ghost" data-x>Voltar</button><button class="btn" data-send>Enviar pedido</button>';
    const m = openModal({ title: 'Pedir alteração', body, footer });
    footer.querySelector('[data-x]').addEventListener('click', () => m.close());
    footer.querySelector('[data-send]').addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
      const msg = m.el.querySelector('#change-msg');
      if (msg.value.trim().length < 3) { msg.setAttribute('aria-invalid', 'true'); msg.focus(); return; }
      const { error } = await supabase.rpc('request_appointment_change', { p_appointment_id: a.id, p_message: msg.value.trim() });
      if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
      toast({ type: 'success', message: 'Pedido enviado para a administração.' });
      m.close();
    }, 'Enviando…'));
  }));
}

function groupByDay(list) {
  const map = new Map();
  list.forEach((a) => {
    const k = dateKey(a.starts_at);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(a);
  });
  return map;
}

/* ------------------------------------------------------------------ hoje */
async function initDashboard() {
  const clock = document.getElementById('clock');
  const tick = () => { clock.textContent = fmtTime(new Date().toISOString()); };
  tick();
  setInterval(tick, 15000);
  document.getElementById('today-label').textContent = fmtKeyLong(todayKey());
  document.getElementById('hello').textContent = `Bom trabalho, ${firstName(profile.full_name)}!`;

  const listEl = document.getElementById('today-list');
  const nextEl = document.getElementById('next-client');
  const reload = async () => {
    listEl.innerHTML = skeletonHTML(3);
    try {
      const list = await fetchAgenda(todayKey(), addDaysKey(todayKey(), 1));
      const active = list.filter((a) => !['cancelled'].includes(a.status));
      const now = new Date();
      document.getElementById('stat-today').textContent = active.length;
      document.getElementById('stat-done').textContent = list.filter((a) => a.status === 'completed').length;
      document.getElementById('stat-left').textContent = active.filter((a) => new Date(a.starts_at) > now && !['completed', 'no_show'].includes(a.status)).length;
      const next = active.find((a) => new Date(a.ends_at) > now && !['completed', 'no_show'].includes(a.status));
      nextEl.innerHTML = next
        ? `<span class="stat__label">Próxima cliente</span>
           <span class="stat__value" style="font-size:1.6rem">${esc(next.client_name)}</span>
           <span class="stat__hint">${fmtTime(next.starts_at)} · ${esc(next.service_name)} · ${fmtDuration(next.duration_minutes)}</span>`
        : '<span class="stat__label">Próxima cliente</span><span class="stat__value" style="font-size:1.4rem">Sem mais atendimentos hoje</span>';
      listEl.innerHTML = list.length
        ? `<ul class="appt-list">${list.map((a) => itemHTML(a, { now })).join('')}</ul>`
        : emptyHTML({ title: 'Agenda livre hoje', text: 'Nenhum atendimento marcado para hoje.' });
      bindItems(listEl, list, reload);
    } catch (err) {
      listEl.innerHTML = errorHTML(errorMessage(err), 'retry-today');
      document.getElementById('retry-today')?.addEventListener('click', reload);
    }
  };
  reload();
  setInterval(reload, 120000); // atualiza a cada 2 min
}

/* ------------------------------------------------------------------ agenda */
function initAgenda() {
  const listEl = document.getElementById('agenda-list');
  const label = document.getElementById('range-label');
  const filters = document.getElementById('agenda-filters');
  let filter = 'today';
  let anchor = todayKey();

  const range = () => {
    const t = anchor;
    switch (filter) {
      case 'tomorrow': return [addDaysKey(t, 1), addDaysKey(t, 2)];
      case 'week': { const start = addDaysKey(t, -((weekdayOfKey(t) + 6) % 7)); return [start, addDaysKey(start, 7)]; }
      case 'month': { const start = `${t.slice(0, 8)}01`; const [y, m] = start.split('-').map(Number); const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); return [start, end]; }
      case 'history': return [addDaysKey(todayKey(), -60), todayKey()];
      default: return [t, addDaysKey(t, 1)];
    }
  };

  const reload = async () => {
    const [from, to] = range();
    label.textContent = filter === 'history' ? 'Últimos 60 dias'
      : to === addDaysKey(from, 1) ? fmtKeyLong(from) : `${fmtKeyShort(from)} a ${fmtKeyShort(addDaysKey(to, -1))}`;
    listEl.innerHTML = skeletonHTML(4);
    try {
      let list = await fetchAgenda(from, to);
      if (filter === 'history') list = list.reverse();
      if (!list.length) {
        listEl.innerHTML = emptyHTML({ title: 'Nenhum atendimento no período', text: 'Escolha outro filtro para ver mais dias.' });
        return;
      }
      const now = new Date();
      listEl.innerHTML = [...groupByDay(list)].map(([day, items]) => `
        <section class="day-group" aria-label="${esc(fmtKeyLong(day))}">
          <h2 class="day-group__title">${esc(fmtKeyLong(day))} <small>${items.filter((a) => a.status !== 'cancelled').length} atendimento(s)</small></h2>
          <ul class="appt-list">${items.map((a) => itemHTML(a, { now })).join('')}</ul>
        </section>`).join('');
      bindItems(listEl, list, reload);
    } catch (err) {
      listEl.innerHTML = errorHTML(errorMessage(err), 'retry-agenda');
      document.getElementById('retry-agenda')?.addEventListener('click', reload);
    }
  };

  filters.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    filter = btn.dataset.filter;
    anchor = todayKey();
    filters.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    reload();
  });
  const step = (dir) => {
    const days = { today: 1, tomorrow: 1, week: 7, history: 0 }[filter];
    if (filter === 'month') {
      const [y, m] = anchor.split('-').map(Number);
      anchor = new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10);
    } else if (days) anchor = addDaysKey(anchor, dir * days);
    reload();
  };
  document.getElementById('range-prev').addEventListener('click', () => step(-1));
  document.getElementById('range-next').addEventListener('click', () => step(1));
  reload();
}

/* ------------------------------------------------------------------ init */
(async () => {
  try {
    profile = await requireRole(['employee', 'admin']);
  } catch { return; }
  await getSettings().catch(() => {});
  renderAppShell(profile, 'employee', page);
  ({ dashboard: initDashboard, agenda: initAgenda })[page]?.();
})();
