/**
 * Páginas públicas: início (index.html), procedimentos.html e contato.html.
 * Conteúdo dinâmico vem do Supabase (procedimentos, galeria, depoimentos, contato).
 */
import { supabase } from './supabase.js';
import { renderPublicHeader, renderPublicFooter, hoursTableHTML } from './layout.js';
import { getActiveServices, getSettings, getBusinessHours } from './data.js';
import { esc, url, fmtMoney, fmtDuration, waLink, unwrap, errorMessage, testBadge } from './utils.js';
import { emptyHTML, errorHTML, skeletonHTML } from './ui.js';
import { icon } from './icons.js';

const page = document.body.dataset.page;

/* ------------------------------------------------------------------ procedimentos */
function paymentNote(s) {
  if (s.payment_mode === 'deposit') return `Sinal de ${fmtMoney(s.deposit_amount)} para reservar`;
  if (s.payment_mode === 'on_site') return 'Pagamento no estúdio';
  return s.allow_on_site ? 'PIX, cartão ou no estúdio' : 'PIX ou cartão';
}

function serviceItemHTML(s) {
  const img = s.image_url
    ? `<div class="menu-item__img"><img src="${esc(s.image_url)}" alt="${esc(s.name)}" loading="lazy" width="112" height="140"></div>`
    : '<div class="menu-item__img menu-item__img--pattern" aria-hidden="true"></div>';
  return `
    <li class="menu-item">
      ${img}
      <div>
        <div class="menu-item__head">
          <h3 class="menu-item__name">${esc(s.name)}</h3>
          <span class="menu-item__leader" aria-hidden="true"></span>
          <span class="menu-item__price">${fmtMoney(s.price)}</span>
        </div>
        <p class="menu-item__desc">${esc(s.description)}</p>
        <div class="menu-item__meta">
          <span class="badge badge--plain">${icon('clock')} ${fmtDuration(s.duration_minutes)}</span>
          <span class="badge badge--plain">${esc(paymentNote(s))}</span>
          ${testBadge(s.is_test_data)}
        </div>
      </div>
      <div class="menu-item__cta"><a class="btn btn--outline btn--sm" href="${url(`agendamento.html?servico=${s.id}`)}" aria-label="Agendar ${esc(s.name)}">Agendar</a></div>
    </li>`;
}

async function renderServices(container, limit) {
  container.innerHTML = skeletonHTML(4);
  try {
    let services = await getActiveServices();
    const total = services.length;
    if (limit) services = services.slice(0, limit);
    container.innerHTML = services.length
      ? `<ul class="menu-list">${services.map(serviceItemHTML).join('')}</ul>`
      : emptyHTML({ title: 'Procedimentos em breve', text: 'Estamos preparando a lista de procedimentos. Fale com a gente pelo WhatsApp.' });
    const more = document.getElementById('services-more');
    if (more) more.hidden = !(limit && total > limit);
  } catch (err) {
    container.innerHTML = errorHTML(errorMessage(err, 'Não foi possível carregar os procedimentos.'), 'retry-services');
    document.getElementById('retry-services')?.addEventListener('click', () => renderServices(container, limit));
  }
}

/* ------------------------------------------------------------------ galeria */
async function renderGallery(container) {
  try {
    const items = unwrap(await supabase.from('gallery_items').select('id, image_url, caption, alt_text').eq('is_active', true).order('sort_order').limit(8));
    if (!items.length) {
      const s = await getSettings().catch(() => ({}));
      container.innerHTML = `
        <div class="gallery-empty">
          <img src="${url('assets/images/marca/libelula-640.webp')}" alt="" width="120" height="120" loading="lazy">
          <div>
            <h3>Resultados reais, em breve aqui</h3>
            <p class="muted">As fotos de antes e depois das nossas clientes serão publicadas nesta galeria.${s.instagram ? ' Enquanto isso, acompanhe o dia a dia do estúdio no Instagram.' : ''}</p>
            ${s.instagram ? `<a class="btn btn--outline btn--sm" href="https://instagram.com/${encodeURIComponent(s.instagram)}" target="_blank" rel="noopener">${icon('instagram')} @${esc(s.instagram)}</a>` : ''}
          </div>
        </div>`;
      return;
    }
    container.innerHTML = `<div class="gallery">${items.map((g) => `
      <figure class="gallery__item">
        <img src="${esc(g.image_url)}" alt="${esc(g.alt_text)}" loading="lazy" width="400" height="500">
        ${g.caption ? `<figcaption>${esc(g.caption)}</figcaption>` : ''}
      </figure>`).join('')}</div>`;
  } catch {
    container.innerHTML = '';
  }
}

/* ------------------------------------------------------------------ depoimentos */
async function renderReviews(container) {
  try {
    const reviews = unwrap(await supabase.rpc('get_public_reviews', { p_limit: 6 }));
    const section = container.closest('section');
    if (!reviews.length) { section.hidden = true; return; }
    container.innerHTML = `<div class="testimonials">${reviews.slice(0, 3).map((r) => `
      <figure class="testimonial">
        <span class="stars" aria-label="${r.rating} de 5 estrelas">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
        <blockquote>${esc(r.comment)}</blockquote>
        <figcaption><span>${esc(r.client_first_name)}</span>${r.is_test_data ? '<span class="badge badge--test">exemplo</span>' : ''}</figcaption>
      </figure>`).join('')}</div>`;
  } catch {
    container.closest('section').hidden = true;
  }
}

/* ------------------------------------------------------------------ contato */
async function renderContact(listEl, hoursEl) {
  try {
    const [s, hours] = await Promise.all([getSettings(), getBusinessHours()]);
    const items = [];
    if (s.whatsapp) items.push(['whatsapp', 'WhatsApp', `<a href="${waLink(s.whatsapp, 'Olá! Gostaria de agendar um horário.')}" target="_blank" rel="noopener">${esc(s.phone || s.whatsapp)}</a>`]);
    if (s.instagram) items.push(['instagram', 'Instagram', `<a href="https://www.instagram.com/jhen.beautycare/${encodeURIComponent(s.instagram)}" target="_blank" rel="noopener">@${esc(s.instagram)}</a>`]);
    if (s.address) items.push(['pin', 'Endereço', `${esc(s.address)}${s.maps_url ? `<br><a href="${esc(s.maps_url)}" target="_blank" rel="noopener">Abrir no mapa</a>` : ''}`]);
    if (s.email) items.push(['mail', 'E-mail', `<a href="mailto:jhenbeautycare@gmail.com">jhenbeautycare@gmail.com</a>`]);
    listEl.innerHTML = items.length
      ? `<ul class="contact-list">${items.map(([ic, label, value]) => `
          <li><span class="icon-circle">${icon(ic)}</span><div><span class="muted" style="font-size:var(--fs-sm)">${label}</span><br>${value}</div></li>`).join('')}</ul>`
      : '<p class="muted">Informações de contato em breve.</p>';
    if (hoursEl) hoursEl.innerHTML = hoursTableHTML(hours);
    const policy = document.getElementById('policy-text');
    if (policy) policy.textContent = s.cancellation_policy_text;
  } catch (err) {
    listEl.innerHTML = errorHTML(errorMessage(err, 'Não foi possível carregar o contato.'));
  }
}

/* ------------------------------------------------------------------ init */
renderPublicHeader(page === 'home' ? 'home' : page);
renderPublicFooter();

if (page === 'home') {
  renderServices(document.getElementById('services'), 4);
  renderGallery(document.getElementById('gallery'));
  renderReviews(document.getElementById('reviews'));
  renderContact(document.getElementById('contact-list'), document.getElementById('hours'));
} else if (page === 'procedimentos') {
  renderServices(document.getElementById('services'));
  getSettings().then((s) => {
    const el = document.getElementById('policy-text');
    if (el) el.textContent = s.cancellation_policy_text;
  }).catch(() => {});
} else if (page === 'contato') {
  renderContact(document.getElementById('contact-list'), document.getElementById('hours'));
}

