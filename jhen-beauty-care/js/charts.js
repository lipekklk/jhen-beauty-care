/**
 * Gráficos simples em SVG, sem bibliotecas. Série única na cor da marca,
 * tooltip ao passar o mouse/foco e tabela equivalente para leitores de tela.
 */
import { esc } from './utils.js';

let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}
function showTip(text, x, y) { const t = tooltip(); t.textContent = text; t.style.left = `${x}px`; t.style.top = `${y}px`; t.hidden = false; }
const hideTip = () => { if (tip) tip.hidden = true; };

/** Arredonda o topo da barra (4px) mantendo a base reta no eixo. */
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
}

/**
 * Barras verticais. data = [{ label, value, title }]
 * format: função para os valores (ex.: moeda).
 */
export function barChart(container, data, { format = String, caption = '', height = 220 } = {}) {
  const W = 640; const H = height; const pad = { t: 18, r: 8, b: 26, l: 52 };
  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
  const slot = iw / Math.max(data.length, 1);
  const bw = Math.max(4, Math.min(28, slot - 2)); // 2px de respiro entre barras
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const every = Math.ceil(data.length / 10); // evita rótulos sobrepostos

  const bars = data.map((d, i) => {
    const h = (d.value / max) * ih;
    const x = pad.l + i * slot + (slot - bw) / 2;
    const y = pad.t + ih - h;
    return `
      <g class="bar-g" tabindex="0" role="img" aria-label="${esc(`${d.title || d.label}: ${format(d.value)}`)}" data-tip="${esc(`${d.title || d.label}: ${format(d.value)}`)}">
        <rect x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${ih}" fill="transparent"/>
        ${d.value > 0 ? `<path class="bar" d="${barPath(x, y, bw, h)}"/>` : `<rect class="bar--zero" x="${x}" y="${pad.t + ih - 1}" width="${bw}" height="1"/>`}
        ${i % every === 0 ? `<text class="axis-label" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>` : ''}
      </g>`;
  }).join('');

  container.innerHTML = `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="false" role="group" aria-label="${esc(caption)}">
        ${ticks.map((t) => {
          const y = pad.t + ih - (t / max) * ih;
          return `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text class="axis-label" x="${pad.l - 8}" y="${y + 4}" text-anchor="end">${esc(format(t))}</text>`;
        }).join('')}
        ${bars}
      </svg>
      <table class="sr-only"><caption>${esc(caption)}</caption><tbody>${data.map((d) => `<tr><th>${esc(d.title || d.label)}</th><td>${esc(format(d.value))}</td></tr>`).join('')}</tbody></table>
    </div>`;

  container.querySelectorAll('.bar-g').forEach((g) => {
    const show = (e) => {
      const r = g.getBoundingClientRect();
      showTip(g.dataset.tip, e?.clientX ?? r.left + r.width / 2, (e?.clientY ?? r.top) - 6);
    };
    g.addEventListener('mousemove', show);
    g.addEventListener('focus', () => show());
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('blur', hideTip);
  });
}

/** Barras horizontais (ranking). data = [{ label, value }] */
export function hBars(container, data, { format = String } = {}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  container.innerHTML = `<div class="hbars" role="list">${data.map((d) => `
    <div class="hbar__row" role="listitem">
      <span>${esc(d.label)}</span>
      <span class="hbar__track" aria-hidden="true"><span class="hbar__fill" style="width:${(d.value / max) * 100}%"></span></span>
      <span class="hbar__value">${esc(format(d.value))}</span>
    </div>`).join('')}</div>`;
}
