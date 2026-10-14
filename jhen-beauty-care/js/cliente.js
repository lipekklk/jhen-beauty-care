/**
 * Área da cliente: dashboard.html, agendamentos.html e perfil.html (pasta /cliente).
 */
import { supabase, uploadMedia } from './supabase.js';
import { requireRole, getProfile, clearProfileCache, signIn } from './auth.js';
import { renderAppShell } from './layout.js';
import { APPOINTMENT_SELECT, getSettings } from './data.js';
import { showDetails, cancelFlow, rescheduleFlow, payFlow, reviewFlow, isUpcoming, canPay } from './appointment-actions.js';
import {
  esc, url, fmtMoney, fmtTime, fmtDateLong, fmtWeekdayShort, fmtDayNum, fmtMonthShort, fmtRelative,
  statusBadge, paymentSummary, errorMessage, firstName, unwrap, getParam, isValidPhone, maskPhone, isValidEmail, initials,
  testBadge, fmtDateTime, paymentBadge, paymentMethodLabel, KIND_LABELS,
} from './utils.js';
import { toast, emptyHTML, errorHTML, skeletonHTML, validate, withLoading, bindTabs, bindPasswordToggles } from './ui.js';
import { icon } from './icons.js';

const page = document.body.dataset.page;
let profile;

async function loadAppointments() {
  return unwrap(await supabase.from('appointments')
    .select(`${APPOINTMENT_SELECT}, reviews(id)`)
    .eq('client_id', profile.id)
    .order('starts_at', { ascending: true }));
}

/** Liga os botões de ação de uma lista de agendamentos. */
function bindActions(root, list, reload) {
  root.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
    const a = list.find((x) => x.id === btn.dataset.id);
    if (!a) return;
    const run = async (act) => {
      let changed = false;
      if (act === 'details') return showDetails(a, { onAction: run });
      if (act === 'cancel') changed = await cancelFlow(a);
      if (act === 'reschedule') changed = await rescheduleFlow(a);
      if (act === 'pay') changed = await payFlow(a, btn);
      if (act === 'review') changed = await reviewFlow(a, profile.id);
      if (changed) reload();
      return undefined;
    };
    run(btn.dataset.act);
  }));
}

/** reviews.appointment_id é único: o PostgREST devolve objeto (1:1), não lista. */
const hasReview = (a) => (Array.isArray(a.reviews) ? a.reviews.length > 0 : Boolean(a.reviews));

function actionButtons(a) {
  const btns = [`<button class="btn btn--ghost btn--sm" data-act="details" data-id="${a.id}">Ver detalhes</button>`];
  if (canPay(a)) btns.unshift(`<button class="btn btn--sm" data-act="pay" data-id="${a.id}">Pagar agora</button>`);
  if (['scheduled', 'confirmed'].includes(a.status) && new Date(a.starts_at) > new Date()) {
    btns.push(`<button class="btn btn--outline btn--sm" data-act="reschedule" data-id="${a.id}">Remarcar</button>`);
  }
  if (isUpcoming(a)) btns.push(`<button class="btn btn--ghost btn--sm" data-act="cancel" data-id="${a.id}">Cancelar</button>`);
  if (a.status === 'completed' && !hasReview(a)) btns.push(`<button class="btn btn--outline btn--sm" data-act="review" data-id="${a.id}">${icon('star')} Avaliar</button>`);
  return btns.join('');
}

function apptItemHTML(a) {
  const pay = paymentSummary(a.payments);
  return `
    <li class="appt ${isUpcoming(a) ? '' : 'is-past'}">
      <div class="appt__time"><strong>${fmtDayNum(a.starts_at)}</strong><span>${esc(fmtMonthShort(a.starts_at))} · ${fmtTime(a.starts_at)}</span></div>
      <div>
        <p class="appt__title">${esc(a.service?.name || 'Procedimento')} ${testBadge(a.is_test_data)}</p>
        <div class="appt__meta"><span>${esc(fmtDateLong(a.starts_at))}</span><span>com ${esc(a.employee?.display_name || '—')}</span><span>${fmtMoney(a.price)}</span><span>${esc(pay.label)}</span></div>
      </div>
      <div class="appt__side">${statusBadge(a.status)}<div class="actions">${actionButtons(a)}</div></div>
    </li>`;
}

/* ------------------------------------------------------------------ dashboard */
async function initDashboard() {
  document.getElementById('greeting').textContent = `Olá, ${firstName(profile.full_name) || 'tudo bem'}!`;
  const nextEl = document.getElementById('next-appt');
  const historyEl = document.getElementById('recent-history');
  nextEl.innerHTML = skeletonHTML(3);
  historyEl.innerHTML = skeletonHTML(2);

  const reload = async () => {
    try {
      const list = await loadAppointments();
      const upcoming = list.filter(isUpcoming);
      const done = list.filter((a) => a.status === 'completed').reverse();
      const next = upcoming[0];

      document.getElementById('stat-upcoming').textContent = upcoming.length;
      document.getElementById('stat-done').textContent = done.length;
      document.getElementById('stat-last').textContent = done[0] ? fmtRelative(done[0].starts_at) : '—';

      if (!next) {
        nextEl.innerHTML = emptyHTML({ title: 'Nenhum horário marcado', text: 'Escolha um procedimento e garanta seu próximo horário.', action: { label: 'Agendar agora', href: url('agendamento.html') } });
      } else {
        const pay = paymentSummary(next.payments);
        nextEl.innerHTML = `
          <div class="panel__head"><h2>Seu próximo horário</h2>${statusBadge(next.status)}</div>
          <div class="next-appt">
            <div class="date-capsule" aria-hidden="true">
              <span class="date-capsule__dow">${esc(fmtWeekdayShort(next.starts_at))}</span>
              <span class="date-capsule__day">${fmtDayNum(next.starts_at)}</span>
              <span class="date-capsule__month">${esc(fmtMonthShort(next.starts_at))}</span>
            </div>
            <div>
              <h3 style="margin:0">${esc(next.service?.name)} ${testBadge(next.is_test_data)}</h3>
              <dl class="detail-list">
                <div><dt>Profissional</dt><dd>${esc(next.employee?.display_name || '—')}</dd></div>
                <div><dt>Data</dt><dd>${esc(fmtDateLong(next.starts_at))}</dd></div>
                <div><dt>Horário</dt><dd>${fmtTime(next.starts_at)} às ${fmtTime(next.ends_at)}</dd></div>
                <div><dt>Valor</dt><dd>${fmtMoney(next.price)}</dd></div>
                <div><dt>Pagamento</dt><dd>${esc(pay.label)}</dd></div>
                <div><dt>Status</dt><dd>${statusBadge(next.status)}</dd></div>
              </dl>
              <div class="actions">${actionButtons(next)}</div>
            </div>
          </div>
          ${next.status === 'pending_payment' ? `<div class="alert alert--warning" style="margin-top:var(--space-5)">${icon('clock')}<p>Este horário está reservado aguardando pagamento. Conclua para confirmar.</p></div>` : ''}`;
        bindActions(nextEl, list, reload);
      }

      historyEl.innerHTML = done.length
        ? `<ul class="appt-list">${done.slice(0, 3).map(apptItemHTML).join('')}</ul>`
        : '<p class="muted">Seus atendimentos concluídos aparecem aqui.</p>';
      bindActions(historyEl, list, reload);
    } catch (err) {
      nextEl.innerHTML = errorHTML(errorMessage(err), 'retry-dash');
      document.getElementById('retry-dash')?.addEventListener('click', reload);
    }
  };
  reload();
  loadNotifications();
}

async function loadNotifications() {
  const el = document.getElementById('notifications');
  if (!el) return;
  try {
    const items = unwrap(await supabase.from('notifications')
      .select('id, title, message, created_at, read_at').eq('user_id', profile.id).eq('channel', 'in_app')
      .order('created_at', { ascending: false }).limit(6));
    el.innerHTML = items.length
      ? `<ul class="notif-list">${items.map((n) => `
          <li class="notif ${n.read_at ? '' : 'is-unread'}"><div><strong>${esc(n.title)}</strong><p>${esc(n.message)}</p><time datetime="${n.created_at}">${esc(fmtRelative(n.created_at))}</time></div></li>`).join('')}</ul>`
      : '<p class="muted">Nenhuma notificação por enquanto.</p>';
    const unread = items.filter((n) => !n.read_at).map((n) => n.id);
    if (unread.length) {
      await supabase.from('notifications').update({ read_at: new Date().toISOString(), status: 'read' }).in('id', unread);
    }
  } catch {
    el.innerHTML = '<p class="muted">Não foi possível carregar as notificações.</p>';
  }
}

/* ------------------------------------------------------------------ agendamentos */
async function initAppointments() {
  const panels = {
    upcoming: document.getElementById('panel-upcoming'),
    history: document.getElementById('panel-history'),
    cancelled: document.getElementById('panel-cancelled'),
  };
  bindTabs(document.getElementById('appt-tabs'));

  // retorno do checkout do gateway (cartão)
  const reload = async () => {
    Object.values(panels).forEach((p) => { p.innerHTML = skeletonHTML(3); });
    try {
      const list = await loadAppointments();
      const groups = {
        upcoming: list.filter(isUpcoming),
        history: list.filter((a) => !isUpcoming(a) && a.status !== 'cancelled').reverse(),
        cancelled: list.filter((a) => a.status === 'cancelled').reverse(),
      };
      const empty = {
        upcoming: { title: 'Nenhum horário marcado', text: 'Que tal agendar seu próximo cuidado?', action: { label: 'Agendar agora', href: url('agendamento.html') } },
        history: { title: 'Sem histórico ainda', text: 'Seus procedimentos realizados aparecem aqui.' },
        cancelled: { title: 'Nenhum cancelamento', text: '' },
      };
      for (const [key, items] of Object.entries(groups)) {
        panels[key].innerHTML = items.length ? `<ul class="appt-list">${items.map(apptItemHTML).join('')}</ul>` : emptyHTML(empty[key]);
        bindActions(panels[key], list, reload);
      }
      document.getElementById('count-upcoming').textContent = groups.upcoming.length ? ` (${groups.upcoming.length})` : '';
    } catch (err) {
      panels.upcoming.innerHTML = errorHTML(errorMessage(err), 'retry-list');
      document.getElementById('retry-list')?.addEventListener('click', reload);
    }
  };
  reload();
}

/* ------------------------------------------------------------------ minhas compras */
async function initPurchases() {
  const el = document.getElementById('purchases');
  const stats = document.getElementById('purchase-stats');
  el.innerHTML = skeletonHTML(4);
  try {
    // view "purchases": RLS garante que a cliente só vê as próprias compras
    const list = unwrap(await supabase.from('purchases').select('*').order('purchase_date', { ascending: false }));
    const paid = list.filter((p) => ['approved', 'refund_pending'].includes(p.status) || (p.status === 'refunded' && Number(p.refund_amount) < Number(p.amount)));
    const total = paid.reduce((sum, p) => sum + Number(p.amount) - (p.status === 'refunded' ? Number(p.refund_amount) : 0), 0);
    stats.innerHTML = `
      <div class="stat"><span class="stat__label">Compras</span><span class="stat__value">${list.length}</span></div>
      <div class="stat"><span class="stat__label">Total pago</span><span class="stat__value">${fmtMoney(total)}</span></div>
      <div class="stat"><span class="stat__label">Aguardando pagamento</span><span class="stat__value">${list.filter((p) => p.appointment_status === 'pending_payment').length}</span></div>`;
    if (!list.length) {
      el.innerHTML = emptyHTML({ title: 'Nenhuma compra ainda', text: 'Os pagamentos dos seus agendamentos aparecem aqui.', action: { label: 'Agendar agora', href: url('agendamento.html') } });
      return;
    }
    const canRetry = (p) => p.appointment_status === 'pending_payment' && ['pending', 'rejected'].includes(p.status)
      && p.payment_method !== 'on_site' && p.checkout_expires_at && new Date(p.checkout_expires_at) > new Date(Date.now() + 60_000);
    const access = (p) => {
      if (p.access_granted) return '<span class="badge status--completed">Horário confirmado</span>';
      if (p.appointment_status === 'pending_payment') return '<span class="badge status--pending">Aguardando pagamento</span>';
      if (p.appointment_status === 'cancelled') return '<span class="badge status--cancelled">Horário liberado</span>';
      return `<span class="badge">${esc(p.appointment_status)}</span>`;
    };
    el.innerHTML = `<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Procedimento</th><th class="num">Valor</th><th>Status</th><th>Pagamento</th><th>Acesso</th><th class="actions-cell"><span class="sr-only">Ações</span></th></tr></thead>
      <tbody>${list.map((p) => `
        <tr>
          <td data-label="Procedimento"><span class="cell-strong">${esc(p.product_name)}</span> ${testBadge(p.is_test_data)}
            <span class="cell-sub">${esc(fmtDateLong(p.appointment_starts_at))}, ${fmtTime(p.appointment_starts_at)}</span>
            <span class="cell-sub">Compra em ${fmtDateTime(p.purchase_date)}</span></td>
          <td data-label="Valor" class="num">${fmtMoney(p.amount)}<span class="cell-sub">${esc(KIND_LABELS[p.kind] || '')}</span>
            ${Number(p.refund_amount) > 0 && ['refunded', 'refund_pending'].includes(p.status) ? `<span class="cell-sub">estorno ${fmtMoney(p.refund_amount)}</span>` : ''}</td>
          <td data-label="Status">${paymentBadge(p.status)}</td>
          <td data-label="Pagamento">${esc(paymentMethodLabel(p))}${p.mercadopago_payment_id ? `<span class="cell-sub">Transação nº ${esc(p.mercadopago_payment_id)}</span>` : ''}</td>
          <td data-label="Acesso">${access(p)}</td>
          <td class="actions-cell">${canRetry(p) ? `<button class="btn btn--sm" data-pay="${p.id}">${icon('lock')} Pagar</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => withLoading(b, async () => {
      const { startCheckout, checkoutErrorMessage } = await import('./pagamentos.js');
      try { await startCheckout(b.dataset.pay); } catch (err) { toast({ type: 'error', message: checkoutErrorMessage(err) }); }
    }, 'Preparando pagamento seguro…')));
  } catch (err) {
    el.innerHTML = errorHTML(errorMessage(err), 'retry-purchases');
    document.getElementById('retry-purchases')?.addEventListener('click', initPurchases);
  }
}

/* ------------------------------------------------------------------ perfil */
async function initProfile() {
  const form = document.getElementById('profile-form');
  const avatar = document.getElementById('avatar-preview');
  const paintAvatar = (src) => {
    avatar.innerHTML = src ? `<img src="${esc(src)}" alt="Sua foto">` : esc(initials(profile.full_name));
  };
  form.full_name.value = profile.full_name || '';
  form.phone.value = profile.phone || '';
  form.birth_date.value = profile.birth_date || '';
  document.getElementById('current-email').textContent = profile.auth_email || profile.email;
  paintAvatar(profile.avatar_url);
  maskPhone(form.phone);
  bindPasswordToggles();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate(form, {
      full_name: (v) => (v.length < 3 ? 'Informe seu nome completo.' : ''),
      phone: (v) => (v && !isValidPhone(v) ? 'Informe um celular com DDD.' : ''),
      birth_date: (v) => (v && (new Date(v) > new Date() || v < '1900-01-01') ? 'Data inválida.' : ''),
    })) return;
    await withLoading(form.querySelector('[type="submit"]'), async () => {
      const { error } = await supabase.from('profiles').update({
        full_name: form.full_name.value.trim(), phone: form.phone.value.trim() || null, birth_date: form.birth_date.value || null,
      }).eq('id', profile.id);
      if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
      clearProfileCache();
      profile = await getProfile(true);
      toast({ type: 'success', message: 'Dados atualizados.' });
    }, 'Salvando…');
  });

  // foto (opcional)
  document.getElementById('avatar-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const publicUrl = await uploadMedia(file, `avatars/${profile.id}`);
      const { error } = await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', profile.id);
      if (error) throw error;
      paintAvatar(publicUrl);
      toast({ type: 'success', message: 'Foto atualizada.' });
    } catch (err) {
      toast({ type: 'error', message: errorMessage(err, 'Não foi possível enviar a foto.') });
    } finally { e.target.value = ''; }
  });
  document.getElementById('avatar-remove').addEventListener('click', async () => {
    const { error } = await supabase.from('profiles').update({ avatar_url: null }).eq('id', profile.id);
    if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
    paintAvatar(null);
    toast({ type: 'success', message: 'Foto removida.' });
  });

  // troca de e-mail: fluxo seguro do Supabase (confirmação por link)
  const emailForm = document.getElementById('email-form');
  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate(emailForm, {
      new_email: (v) => (!isValidEmail(v) ? 'Informe um e-mail válido.' : v.toLowerCase() === (profile.auth_email || '').toLowerCase() ? 'Este já é o seu e-mail.' : ''),
    })) return;
    await withLoading(emailForm.querySelector('[type="submit"]'), async () => {
      const { error } = await supabase.auth.updateUser(
        { email: emailForm.new_email.value.trim().toLowerCase() },
        { emailRedirectTo: url('cliente/perfil.html?email=confirmado') },
      );
      if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
      emailForm.reset();
      toast({ type: 'success', title: 'Confirme nos dois e-mails', message: 'Enviamos um link para o seu e-mail atual e outro para o novo. A troca só acontece depois que você clicar nos dois.', timeout: 12000 });
      await showEmailStatus();
    }, 'Enviando…');
  });

  // situação real da troca (consultada no servidor de autenticação, não na URL)
  async function showEmailStatus() {
    const box = document.getElementById('email-pending');
    const { data } = await supabase.auth.getUser();
    const user = data?.user;
    if (!user) return null;
    document.getElementById('current-email').textContent = user.email;
    if (user.new_email) {
      box.className = 'alert alert--warning';
      box.innerHTML = `${icon('mail')}<p>Troca para <strong>${esc(user.new_email)}</strong> aguardando confirmação. Abra o link enviado para <strong>${esc(user.email)}</strong> e o enviado para <strong>${esc(user.new_email)}</strong>. Se não encontrar, confira o spam ou peça de novo.</p>`;
      box.hidden = false;
    } else {
      box.hidden = true;
    }
    return user;
  }
  const emailUser = await showEmailStatus();
  if (getParam('email') === 'confirmado' && emailUser) {
    if (emailUser.new_email) toast({ type: 'info', title: 'Falta uma confirmação', message: 'Recebemos a primeira confirmação. Agora abra o link enviado para o outro e-mail.', timeout: 12000 });
    else toast({ type: 'success', message: `E-mail atualizado para ${emailUser.email}.` });
  }

  // troca de senha: confirma a senha atual antes
  const pwForm = document.getElementById('password-form');
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate(pwForm, {
      current_password: (v) => (!v ? 'Informe sua senha atual.' : ''),
      new_password: (v) => (v.length < 8 ? 'Use pelo menos 8 caracteres.' : ''),
      confirm_password: (v, f) => (v !== f.new_password.value ? 'As senhas não conferem.' : ''),
    })) return;
    await withLoading(pwForm.querySelector('[type="submit"]'), async () => {
      try {
        await signIn(profile.auth_email, pwForm.current_password.value);
      } catch {
        toast({ type: 'error', message: 'Senha atual incorreta.' });
        return;
      }
      const { error } = await supabase.auth.updateUser({ password: pwForm.new_password.value });
      if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
      pwForm.reset();
      toast({ type: 'success', message: 'Senha alterada.' });
    }, 'Salvando…');
  });
}

/* ------------------------------------------------------------------ init */
(async () => {
  try {
    profile = await requireRole(['client', 'admin', 'employee']);
  } catch { return; }
  renderAppShell(profile, 'client', page);
  getSettings().catch(() => {});
  ({ dashboard: initDashboard, agendamentos: initAppointments, perfil: initProfile, compras: initPurchases })[page]?.();
})();

