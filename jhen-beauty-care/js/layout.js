/**
 * Estrutura compartilhada: cabeçalho e rodapé públicos, e o "shell" das áreas logadas
 * (sidebar + topbar). Mantém um único lugar para links e identidade visual.
 */
import { icon } from './icons.js';
import { url, esc, waLink, WEEKDAYS, initials, ROLE_LABELS, todayKey, weekdayOfKey } from './utils.js';
import { getSession, getProfile, signOut, dashboardUrl } from './auth.js';
import { getSettings, getBusinessHours } from './data.js';
import { supabaseReady } from './supabase.js';

const PUBLIC_LINKS = [
  { href: 'index.html', label: 'Início', key: 'home' },
  { href: 'procedimentos.html', label: 'Procedimentos', key: 'procedimentos' },
  { href: 'index.html#sobre', label: 'Sobre', key: 'sobre' },
  { href: 'contato.html', label: 'Contato', key: 'contato' },
];

/* ------------------------------------------------------------------ público */
export async function renderPublicHeader(active) {
  const host = document.querySelector('[data-component="header"]');
  if (!host) return;
  host.outerHTML = `
  ${supabaseReady ? '' : `<div class="config-banner"><div class="container">Modo de configuração: preencha <code>js/config.js</code> com a URL e a chave pública do seu projeto Supabase.</div></div>`}
  <header class="site-header" id="site-header">
    <div class="container site-header__inner">
      <a class="brand" href="${url('index.html')}" aria-label="JHEN beauty care — página inicial">
        <img src="${url('assets/logo/logo-jhen-vinho.png')}" alt="JHEN beauty care" width="104" height="44">
      </a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="Abrir menu">
        <span class="nav-toggle__bars" aria-hidden="true"></span>
      </button>
      <nav class="nav" id="site-nav" aria-label="Principal">
        <ul class="nav__list">
          ${PUBLIC_LINKS.map((l) => `<li><a class="nav__link" href="${url(l.href)}" ${l.key === active ? 'aria-current="page"' : ''}>${l.label}</a></li>`).join('')}
        </ul>
        <div class="nav__actions">
          <a class="btn btn--ghost" href="${url('login.html')}" data-auth-link>Entrar</a>
          <a class="btn" href="${url('agendamento.html')}">Agendar agora</a>
        </div>
      </nav>
    </div>
  </header>`;

  const header = document.getElementById('site-header');
  const toggle = header.querySelector('.nav-toggle');
  const nav = header.querySelector('.nav');
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
    nav.classList.toggle('is-open', open);
    document.body.classList.toggle('nav-open', open);
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Usuário logado: "Entrar" vira "Minha área"
  try {
    if (await getSession()) {
      const profile = await getProfile();
      const link = header.querySelector('[data-auth-link]');
      link.textContent = 'Minha área';
      link.href = dashboardUrl(profile.role);
    }
  } catch { /* segue como visitante */ }
}

export async function renderPublicFooter() {
  const host = document.querySelector('[data-component="footer"]');
  if (!host) return;
  let s = {};
  let hours = [];
  try { [s, hours] = await Promise.all([getSettings(), getBusinessHours()]); } catch { /* rodapé sem dados dinâmicos */ }
  const ig = s.instagram ? `https://instagram.com/${encodeURIComponent(s.instagram)}` : '';
  const hoursList = hours.length ? summarizeHours(hours) : [];
  host.outerHTML = `
  <footer class="site-footer">
    <div class="container">
      <div class="footer__grid">
        <div class="footer__brand">
          <img src="${url('assets/logo/logo-jhen-creme.png')}" alt="JHEN beauty care" width="170" height="72" loading="lazy">
          <p>Design de sobrancelhas com atendimento individual e horário marcado.</p>
          <div class="social">
            ${ig ? `<a href="${ig}" target="_blank" rel="noopener" aria-label="Instagram">${icon('instagram')}</a>` : ''}
            ${s.whatsapp ? `<a href="${waLink(s.whatsapp)}" target="_blank" rel="noopener" aria-label="WhatsApp">${icon('whatsapp')}</a>` : ''}
            ${s.email ? `<a href="mailto:${esc(s.email)}" aria-label="E-mail">${icon('mail')}</a>` : ''}
          </div>
        </div>
        <div>
          <h2 class="footer__title">navegue</h2>
          <ul class="footer__list">
            <li><a href="${url('procedimentos.html')}">Procedimentos e preços</a></li>
            <li><a href="${url('agendamento.html')}">Agendar horário</a></li>
            <li><a href="${url('login.html')}">Minha área</a></li>
            <li><a href="${url('contato.html')}">Contato</a></li>
          </ul>
        </div>
        <div>
          <h2 class="footer__title">horários</h2>
          <ul class="footer__list">${hoursList.map((h) => `<li>${esc(h)}</li>`).join('') || '<li>Consulte pelo WhatsApp</li>'}</ul>
        </div>
        <div>
          <h2 class="footer__title">visite</h2>
          <ul class="footer__list">
            ${s.address ? `<li>${esc(s.address)}</li>` : ''}
            ${s.maps_url ? `<li><a href="${esc(s.maps_url)}" target="_blank" rel="noopener">Ver no mapa</a></li>` : ''}
            ${s.phone ? `<li><a href="tel:${esc(s.phone.replace(/\D/g, ''))}">${esc(s.phone)}</a></li>` : ''}
          </ul>
        </div>
      </div>
      <div class="footer__bottom">
        <span>© ${new Date().getFullYear()} ${esc(s.business_name || 'JHEN beauty care')}</span>
        <span>Pagamentos processados por gateway seguro. Não armazenamos dados de cartão.</span>
      </div>
    </div>
  </footer>
  ${s.whatsapp ? `<a class="wa-float" href="${waLink(s.whatsapp, 'Olá! Gostaria de tirar uma dúvida sobre os procedimentos.')}" target="_blank" rel="noopener" aria-label="Conversar no WhatsApp">${icon('whatsapp')}</a>` : ''}`;
}

/** Agrupa dias com o mesmo horário: "Ter a Sex · 09:00–19:00" */
export function summarizeHours(hours) {
  const short = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const label = (h) => (h?.is_open ? `${h.open_time.slice(0, 5)}–${h.close_time.slice(0, 5)}` : 'Fechado');
  const byDay = Object.fromEntries(hours.map((h) => [h.weekday, h]));
  const groups = [];
  for (const d of order) {
    const l = label(byDay[d]);
    const last = groups.at(-1);
    if (last && last.label === l) last.days.push(d); else groups.push({ label: l, days: [d] });
  }
  return groups.map((g) => {
    const days = g.days.length > 2 ? `${short[g.days[0]]} a ${short[g.days.at(-1)]}` : g.days.map((d) => short[d]).join(' e ');
    return `${days}: ${g.label}`;
  });
}

/** Tabela completa de horários (página de contato). */
export function hoursTableHTML(hours) {
  const today = weekdayOfKey(todayKey());
  const order = [1, 2, 3, 4, 5, 6, 0];
  const byDay = Object.fromEntries(hours.map((h) => [h.weekday, h]));
  return `<table class="hours-table"><caption class="sr-only">Horário de funcionamento</caption><tbody>${order.map((d) => {
    const h = byDay[d];
    const v = h?.is_open
      ? `${h.open_time.slice(0, 5)} – ${h.close_time.slice(0, 5)}${h.break_start ? ` (pausa ${h.break_start.slice(0, 5)}–${h.break_end.slice(0, 5)})` : ''}`
      : 'Fechado';
    return `<tr class="${d === today ? 'is-today' : ''}"><th scope="row">${WEEKDAYS[d]}${d === today ? ' (hoje)' : ''}</th><td>${v}</td></tr>`;
  }).join('')}</tbody></table>`;
}

/* ------------------------------------------------------------------ áreas logadas */
const APP_NAV = {
  client: [
    { href: 'cliente/dashboard.html', label: 'Início', icon: 'home', key: 'dashboard' },
    { href: 'cliente/agendamentos.html', label: 'Meus agendamentos', icon: 'calendar', key: 'agendamentos' },
    { href: 'agendamento.html', label: 'Novo agendamento', icon: 'plus', key: 'novo' },
    { href: 'cliente/perfil.html', label: 'Meus dados', icon: 'user', key: 'perfil' },
  ],
  employee: [
    { href: 'funcionario/dashboard.html', label: 'Hoje', icon: 'home', key: 'dashboard' },
    { href: 'funcionario/agenda.html', label: 'Minha agenda', icon: 'calendar', key: 'agenda' },
  ],
  admin: [
    { href: 'admin/dashboard.html', label: 'Painel', icon: 'chart', key: 'dashboard' },
    { href: 'admin/agendamentos.html', label: 'Agendamentos', icon: 'calendar', key: 'agendamentos' },
    { href: 'admin/clientes.html', label: 'Clientes', icon: 'users', key: 'clientes' },
    { href: 'admin/funcionarios.html', label: 'Equipe', icon: 'user', key: 'funcionarios' },
    { href: 'admin/procedimentos.html', label: 'Procedimentos', icon: 'sparkle', key: 'procedimentos' },
    { href: 'admin/pagamentos.html', label: 'Pagamentos', icon: 'money', key: 'pagamentos' },
    { href: 'admin/configuracoes.html', label: 'Configurações', icon: 'settings', key: 'configuracoes' },
  ],
};

/**
 * Preenche a sidebar (#sidebar) conforme o papel e liga o menu mobile.
 * area: 'client' | 'employee' | 'admin' (a área da página atual)
 */
export function renderAppShell(profile, area, active) {
  const sidebar = document.getElementById('sidebar');
  const links = APP_NAV[area];
  // atalhos entre áreas para quem tem mais de um papel
  const extra = [];
  if (area !== 'admin' && profile.role === 'admin') extra.push({ href: 'admin/dashboard.html', label: 'Painel administrativo', icon: 'shield' });
  if (area !== 'employee' && profile.employee_id) extra.push({ href: 'funcionario/dashboard.html', label: 'Minha agenda de atendimentos', icon: 'clock' });

  sidebar.innerHTML = `
    <a class="sidebar__brand" href="${url('index.html')}" aria-label="Ir para o site">
      <img src="${url('assets/logo/logo-jhen-creme.png')}" alt="JHEN beauty care" width="136" height="58">
      <span class="sidebar__role">${area === 'admin' ? 'administração' : area === 'employee' ? 'área da profissional' : 'área da cliente'}</span>
    </a>
    <nav aria-label="Menu da área">
      <ul class="sidebar__nav">
        ${links.map((l) => `<li><a class="sidebar__link" href="${url(l.href)}" ${l.key === active ? 'aria-current="page"' : ''}>${icon(l.icon)}<span>${l.label}</span></a></li>`).join('')}
      </ul>
      ${extra.length ? `<p class="sidebar__section">outras áreas</p><ul class="sidebar__nav">${extra.map((l) => `<li><a class="sidebar__link" href="${url(l.href)}">${icon(l.icon)}<span>${l.label}</span></a></li>`).join('')}</ul>` : ''}
    </nav>
    <div class="sidebar__foot">
      <div class="sidebar__user">
        <span class="avatar">${profile.avatar_url ? `<img src="${esc(profile.avatar_url)}" alt="">` : esc(initials(profile.full_name))}</span>
        <div><strong>${esc(profile.full_name || profile.email)}</strong><span>${ROLE_LABELS[profile.role]}</span></div>
      </div>
      <a class="btn btn--ghost btn--sm" href="${url('index.html')}">${icon('home')} Ver o site</a>
      <button class="btn btn--ghost btn--sm" type="button" id="logout-btn">${icon('logout')} Sair</button>
    </div>`;

  document.getElementById('logout-btn').addEventListener('click', () => signOut());

  // menu mobile (gaveta)
  const backdrop = document.createElement('div');
  backdrop.className = 'sidebar-backdrop';
  document.body.appendChild(backdrop);
  const menuBtn = document.querySelector('.topbar__menu');
  const setOpen = (open) => {
    sidebar.classList.toggle('is-open', open);
    backdrop.classList.toggle('is-open', open);
    menuBtn?.setAttribute('aria-expanded', String(open));
    if (open) sidebar.querySelector('a, button')?.focus();
  };
  menuBtn?.addEventListener('click', () => setOpen(!sidebar.classList.contains('is-open')));
  backdrop.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
}
