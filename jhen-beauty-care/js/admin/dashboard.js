/**
 * Painel administrativo: indicadores, gráficos e agenda do dia.
 */
import { supabase } from '../supabase.js';
import { initAdminPage } from './admin.js';
import { barChart, hBars } from '../charts.js';
import {
  esc, url, fmtMoney, fmtTime, fmtKeyShort, todayKey, addDaysKey, localToISO, statusBadge, errorMessage, unwrap,
  fmtRelative, testBadge,
} from '../utils.js';
import { errorHTML, skeletonHTML, emptyHTML } from '../ui.js';

let period = 30;

async function loadStats() {
  const statsEl = document.getElementById('stats');
  const to = todayKey();
  const from = period === 'month' ? `${to.slice(0, 8)}01` : addDaysKey(to, -(period - 1));
  statsEl.setAttribute('aria-busy', 'true');
  try {
    const d = unwrap(await supabase.rpc('admin_dashboard', { p_from: from, p_to: to }));
    const tiles = [
      ['Agendamentos hoje', d.today_count, '', true],
      ['Agendamentos na semana', d.week_count, 'segunda a domingo'],
      ['Faturamento', fmtMoney(d.revenue), 'pagamentos aprovados no período', false, true],
      ['Clientes cadastradas', d.clients_count, `${d.new_clients} nova(s) no período`],
      ['Procedimentos realizados', d.completed_count, 'concluídos no período'],
      ['Cancelamentos', d.cancelled_count, 'no período'],
      ['Não comparecimentos', d.no_show_count, 'no período'],
    ];
    statsEl.innerHTML = tiles.map(([label, value, hint, feature, wide]) => `
      <div class="stat ${feature ? 'stat--feature' : ''} ${wide ? 'stat--wide' : ''}">
        <span class="stat__label">${label}</span><span class="stat__value">${esc(value)}</span>${hint ? `<span class="stat__hint">${hint}</span>` : ''}
      </div>`).join('');

    const refunds = document.getElementById('refund-alert');
    refunds.hidden = !d.pending_refunds;
    refunds.querySelector('[data-count]').textContent = d.pending_refunds;

    barChart(document.getElementById('chart-revenue'),
      d.revenue_by_day.map((r) => ({ label: fmtKeyShort(r.day), value: Number(r.total), title: fmtKeyShort(r.day) })),
      { format: (v) => fmtMoney(v).replace(',00', ''), caption: 'Faturamento por dia' });
    const services = document.getElementById('chart-services');
    if (d.by_service.length) hBars(services, d.by_service.map((s) => ({ label: s.name, value: s.count })));
    else services.innerHTML = '<p class="muted">Nenhum agendamento no período.</p>';

    const status = document.getElementById('status-breakdown');
    const entries = Object.entries(d.by_status);
    status.innerHTML = entries.length
      ? entries.map(([k, v]) => `<li style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--color-border)">${statusBadge(k)}<strong>${v}</strong></li>`).join('')
      : '<li class="muted">Sem dados no período.</li>';
  } catch (err) {
    statsEl.innerHTML = errorHTML(errorMessage(err));
  } finally {
    statsEl.removeAttribute('aria-busy');
  }
}

async function loadToday() {
  const el = document.getElementById('today-agenda');
  el.innerHTML = skeletonHTML(3);
  try {
    const t = todayKey();
    const list = unwrap(await supabase.rpc('get_employee_agenda', { p_from: localToISO(t, '00:00'), p_to: localToISO(addDaysKey(t, 1), '00:00'), p_employee_id: null }));
    el.innerHTML = list.length
      ? `<ul class="appt-list">${list.map((a) => `
          <li class="appt"><div class="appt__time"><strong>${fmtTime(a.starts_at)}</strong><span>${fmtTime(a.ends_at)}</span></div>
          <div><p class="appt__title">${esc(a.client_name)} ${testBadge(a.is_test_data)}</p><div class="appt__meta"><span>${esc(a.service_name)}</span><span>com ${esc(a.employee_name)}</span><span>${esc(a.payment_status)}</span></div></div>
          <div class="appt__side">${statusBadge(a.status)}</div></li>`).join('')}</ul>`
      : emptyHTML({ title: 'Nenhum atendimento hoje', text: '', action: { label: 'Criar agendamento', href: url('admin/agendamentos.html?novo=1') } });
  } catch (err) {
    el.innerHTML = errorHTML(errorMessage(err));
  }
}

async function loadAlerts(profile) {
  const el = document.getElementById('admin-notifications');
  try {
    const items = unwrap(await supabase.from('notifications').select('id, title, message, created_at, read_at, type')
      .eq('user_id', profile.id).eq('channel', 'in_app').order('created_at', { ascending: false }).limit(6));
    el.innerHTML = items.length
      ? `<ul class="notif-list">${items.map((n) => `<li class="notif ${n.read_at ? '' : 'is-unread'}"><div><strong>${esc(n.title)}</strong><p>${esc(n.message)}</p><time>${esc(fmtRelative(n.created_at))}</time></div></li>`).join('')}</ul>`
      : '<p class="muted">Pedidos de alteração da equipe e alertas de estorno aparecem aqui.</p>';
    const unread = items.filter((n) => !n.read_at).map((n) => n.id);
    if (unread.length) await supabase.from('notifications').update({ read_at: new Date().toISOString(), status: 'read' }).in('id', unread);
  } catch {
    el.innerHTML = '<p class="muted">Não foi possível carregar os avisos.</p>';
  }
}

(async () => {
  let profile;
  try { profile = await initAdminPage('dashboard'); } catch { return; }
  document.getElementById('period').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    period = b.dataset.period === 'month' ? 'month' : Number(b.dataset.period);
    document.querySelectorAll('#period [data-period]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadStats();
  });
  loadStats();
  loadToday();
  loadAlerts(profile);
})();

