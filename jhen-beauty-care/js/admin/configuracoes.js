/**
 * Admin → Configurações: horário de funcionamento, horários especiais, feriados,
 * folgas/férias/bloqueios, políticas, pagamentos, contato/notificações e site (galeria, depoimentos).
 */
import { supabase, uploadMedia } from '../supabase.js';
import { initAdminPage, fieldHTML, readForm } from './admin.js';
import { invalidate } from '../data.js';
import {
  esc, fmtDate, errorMessage, unwrap, WEEKDAYS, BLOCK_TYPE_LABELS, todayKey, keyToDate, testBadge, onlyDigits,
} from '../utils.js';
import { toast, withLoading, confirmDialog, bindTabs, errorHTML, emptyHTML } from '../ui.js';
import { icon } from '../icons.js';

let settings;
let employees = [];
const fmtKey = (k) => fmtDate(keyToDate(k).toISOString());
const t5 = (v) => (v ? v.slice(0, 5) : '');

/* ------------------------------------------------------------------ util: formulário de settings */
function settingsForm(container, fields, { submitText = 'Salvar', transform, after } = {}) {
  container.innerHTML = `<form class="form panel" novalidate><div class="form-row">${fields.map((f) => fieldHTML(f, settings[f.name])).join('')}</div>
    <div><button class="btn" type="submit">${esc(submitText)}</button></div></form>`;
  const form = container.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let values = readForm(form, fields);
    if (transform) values = transform(values, form);
    if (!values) return;
    await withLoading(form.querySelector('[type="submit"]'), async () => {
      const { data, error } = await supabase.from('settings').update(values).eq('id', 1).select().single();
      if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
      settings = data;
      invalidate('settings');
      toast({ type: 'success', message: 'Configurações salvas.' });
      after?.();
    }, 'Salvando…');
  });
  return form;
}

/* ------------------------------------------------------------------ funcionamento */
async function renderBusinessHours() {
  const el = document.getElementById('tp-horarios');
  const hours = unwrap(await supabase.from('business_hours').select('*').order('weekday'));
  const by = Object.fromEntries(hours.map((h) => [h.weekday, h]));
  el.innerHTML = `
    <div class="panel">
      <div class="panel__head"><h2>Horário de funcionamento</h2></div>
      <div class="hours-head"><span>Dia</span><span>Aberto</span><span>Abre</span><span>Fecha</span><span>Intervalo início</span><span>Intervalo fim</span></div>
      <form class="hours-editor" id="bh-form">${[1, 2, 3, 4, 5, 6, 0].map((d) => {
        const h = by[d] || {};
        return `<div class="hours-row ${h.is_open ? '' : 'is-closed'}" data-day="${d}">
          <span class="hours-row__day">${WEEKDAYS[d]}</span>
          <label class="switch"><input type="checkbox" data-k="is_open" ${h.is_open ? 'checked' : ''} aria-label="${WEEKDAYS[d]} aberto"><span class="switch__track"></span></label>
          <div class="hours-row__fields">
            ${[['open_time', 'Abre', 'abre'], ['close_time', 'Fecha', 'fecha'], ['break_start', 'Intervalo início', 'início do intervalo'], ['break_end', 'Intervalo fim', 'fim do intervalo']].map(([k, label, aria]) => `
            <label class="hours-field"><span class="hours-field__label" aria-hidden="true">${label}</span>
              <input class="input" type="time" data-k="${k}" value="${t5(h[k])}" aria-label="${WEEKDAYS[d]}: ${aria}"></label>`).join('')}
          </div></div>`;
      }).join('')}
        <div style="margin-top:var(--space-4)"><button class="btn" type="submit">Salvar horários</button></div>
      </form>
      <p class="hint" style="margin-top:var(--space-3)">Mudanças valem para novos agendamentos. Os já marcados não são alterados.</p>
    </div>`;
  const form = el.querySelector('#bh-form');
  form.querySelectorAll('[data-k="is_open"]').forEach((c) => c.addEventListener('change', () => c.closest('.hours-row').classList.toggle('is-closed', !c.checked)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = [...form.querySelectorAll('.hours-row')].map((r) => {
      const v = (k) => r.querySelector(`[data-k="${k}"]`).value || null;
      const open = r.querySelector('[data-k="is_open"]').checked;
      return { weekday: Number(r.dataset.day), is_open: open, open_time: v('open_time'), close_time: v('close_time'), break_start: v('break_start'), break_end: v('break_end') };
    });
    for (const r of rows) {
      if (r.is_open && (!r.open_time || !r.close_time || r.close_time <= r.open_time)) { toast({ type: 'error', message: `${WEEKDAYS[r.weekday]}: informe abertura e fechamento.` }); return; }
      if (Boolean(r.break_start) !== Boolean(r.break_end) || (r.break_start && r.break_end <= r.break_start)) { toast({ type: 'error', message: `${WEEKDAYS[r.weekday]}: intervalo incompleto ou inválido.` }); return; }
    }
    await withLoading(form.querySelector('[type="submit"]'), async () => {
      const { error } = await supabase.from('business_hours').upsert(rows, { onConflict: 'weekday' });
      if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
      invalidate('business_hours');
      toast({ type: 'success', message: 'Horários salvos.' });
    }, 'Salvando…');
  });
}

/* ------------------------------------------------------------------ lista + formulário genéricos */
async function crudSection(el, { title, table, order, fields, row, toRecord, empty, hint }) {
  const render = async () => {
    let list;
    try { list = unwrap(await supabase.from(table).select('*').order(order)); } catch (err) { el.innerHTML = errorHTML(errorMessage(err)); return; }
    el.innerHTML = `
      <div class="panel">
        <div class="panel__head"><h2>${esc(title)}</h2></div>
        ${hint ? `<p class="muted">${esc(hint)}</p>` : ''}
        <form class="form" novalidate style="margin-bottom:var(--space-5)"><div class="form-row">${fields.map((f) => fieldHTML(f)).join('')}</div>
          <div><button class="btn btn--outline" type="submit">${icon('plus')} Adicionar</button></div></form>
        ${list.length ? `<div class="table-wrap"><table class="table table--stack"><tbody>${list.map((r) => `
          <tr>${row(r)}<td class="actions-cell"><button class="icon-btn icon-btn--danger" data-del="${r[table === 'special_hours' ? 'date' : 'id']}" aria-label="Remover">${icon('trash')}</button></td></tr>`).join('')}</tbody></table></div>`
          : `<p class="muted">${esc(empty)}</p>`}
      </div>`;
    const form = el.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rec = toRecord(readForm(form, fields));
      if (rec.error) { toast({ type: 'error', message: rec.error }); return; }
      await withLoading(form.querySelector('[type="submit"]'), async () => {
        const { error } = await supabase.from(table).insert(rec);
        if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
        toast({ type: 'success', message: 'Adicionado.' });
        render();
      }, 'Salvando…');
    });
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Remover?', message: 'Este item será removido e os horários voltam a ficar disponíveis.', confirmText: 'Remover', danger: true })) return;
      const key = table === 'special_hours' ? 'date' : 'id';
      const { error } = await supabase.from(table).delete().eq(key, b.dataset.del);
      if (error) { toast({ type: 'error', message: errorMessage(error) }); return; }
      toast({ type: 'success', message: 'Removido.' });
      render();
    }));
  };
  await render();
}

const empOptions = () => [{ value: '', label: 'Todas as profissionais' }, ...employees.map((e) => ({ value: e.id, label: e.display_name }))];
const empName = (id) => (id ? employees.find((e) => e.id === id)?.display_name || '—' : 'Todas');

async function renderDates() {
  const el = document.getElementById('tp-datas');
  el.innerHTML = '<div id="sec-holidays"></div><div id="sec-special" style="margin-top:var(--space-5)"></div>';
  await crudSection(el.querySelector('#sec-holidays'), {
    title: 'Feriados', table: 'holidays', order: 'date', empty: 'Nenhum feriado cadastrado.',
    hint: 'Em feriados o estúdio fica fechado o dia todo.',
    fields: [{ name: 'date', label: 'Data', type: 'date', required: true, min: todayKey() }, { name: 'name', label: 'Nome', required: true, maxlength: 80 }],
    toRecord: (v) => (!v.date || !v.name ? { error: 'Informe data e nome.' } : v),
    row: (r) => `<td data-label="Data">${fmtKey(r.date)}</td><td data-label="Feriado">${esc(r.name)}</td>`,
  });
  await crudSection(el.querySelector('#sec-special'), {
    title: 'Horários especiais', table: 'special_hours', order: 'date', empty: 'Nenhum horário especial.',
    hint: 'Substitui o horário normal em uma data (ex.: véspera de feriado, sábado estendido).',
    fields: [
      { name: 'date', label: 'Data', type: 'date', required: true, min: todayKey() },
      { name: 'is_open', label: 'Aberto nesta data', type: 'checkbox', default: true, full: false },
      { name: 'open_time', label: 'Abre', type: 'time' }, { name: 'close_time', label: 'Fecha', type: 'time' },
      { name: 'break_start', label: 'Intervalo início', type: 'time' }, { name: 'break_end', label: 'Intervalo fim', type: 'time' },
      { name: 'note', label: 'Observação', maxlength: 120 },
    ],
    toRecord: (v) => {
      if (!v.date) return { error: 'Informe a data.' };
      if (v.is_open && (!v.open_time || !v.close_time || v.close_time <= v.open_time)) return { error: 'Informe abertura e fechamento.' };
      if (Boolean(v.break_start) !== Boolean(v.break_end)) return { error: 'Intervalo incompleto.' };
      return v.is_open ? v : { date: v.date, is_open: false, note: v.note };
    },
    row: (r) => `<td data-label="Data">${fmtKey(r.date)}</td><td data-label="Horário">${r.is_open ? `${t5(r.open_time)}–${t5(r.close_time)}${r.break_start ? ` (pausa ${t5(r.break_start)}–${t5(r.break_end)})` : ''}` : 'Fechado'}</td><td data-label="Obs.">${esc(r.note || '')}</td>`,
  });
}

async function renderBlocks() {
  const el = document.getElementById('tp-bloqueios');
  el.innerHTML = '<div id="sec-bdates"></div><div id="sec-btimes" style="margin-top:var(--space-5)"></div>';
  await crudSection(el.querySelector('#sec-bdates'), {
    title: 'Folgas, férias e bloqueios de dias', table: 'blocked_dates', order: 'start_date', empty: 'Nenhum bloqueio de dias.',
    fields: [
      { name: 'employee_id', label: 'Profissional', type: 'select', options: empOptions() },
      { name: 'type', label: 'Tipo', type: 'select', options: Object.entries(BLOCK_TYPE_LABELS).map(([value, label]) => ({ value, label })) },
      { name: 'start_date', label: 'De', type: 'date', required: true }, { name: 'end_date', label: 'Até', type: 'date', required: true },
      { name: 'reason', label: 'Motivo', maxlength: 120 },
    ],
    toRecord: (v) => (!v.start_date || !v.end_date || v.end_date < v.start_date ? { error: 'Informe um período válido.' } : v),
    row: (r) => `<td data-label="Período">${fmtKey(r.start_date)}${r.end_date !== r.start_date ? ` a ${fmtKey(r.end_date)}` : ''}</td><td data-label="Tipo">${BLOCK_TYPE_LABELS[r.type]}</td><td data-label="Quem">${esc(empName(r.employee_id))}</td><td data-label="Motivo">${esc(r.reason || '')}</td>`,
  });
  await crudSection(el.querySelector('#sec-btimes'), {
    title: 'Bloqueios de horário', table: 'blocked_times', order: 'date', empty: 'Nenhum horário bloqueado.',
    hint: 'Bloqueia uma faixa de horário em um dia (ex.: curso, consulta médica, manutenção).',
    fields: [
      { name: 'employee_id', label: 'Profissional', type: 'select', options: empOptions() },
      { name: 'date', label: 'Data', type: 'date', required: true },
      { name: 'start_time', label: 'Início', type: 'time', required: true }, { name: 'end_time', label: 'Fim', type: 'time', required: true },
      { name: 'reason', label: 'Motivo', maxlength: 120 },
    ],
    toRecord: (v) => (!v.date || !v.start_time || !v.end_time || v.end_time <= v.start_time ? { error: 'Informe data, início e fim.' } : v),
    row: (r) => `<td data-label="Data">${fmtKey(r.date)}</td><td data-label="Horário">${t5(r.start_time)}–${t5(r.end_time)}</td><td data-label="Quem">${esc(empName(r.employee_id))}</td><td data-label="Motivo">${esc(r.reason || '')}</td>`,
  });
}

/* ------------------------------------------------------------------ políticas, pagamentos, contato */
function renderPolicies() {
  settingsForm(document.getElementById('tp-politicas'), [
    { name: 'h1', type: 'html', full: true, html: '<h2 style="margin:0">Cancelamento e remarcação</h2>' },
    { name: 'cancellation_min_hours', label: 'Cancelamento gratuito até (horas antes)', type: 'number', min: 0, required: true },
    { name: 'reschedule_min_hours', label: 'Remarcação online até (horas antes)', type: 'number', min: 0, required: true },
    { name: 'max_reschedules', label: 'Limite de remarcações por agendamento', type: 'number', min: 0, required: true },
    { name: 'late_cancellation_fee_percent', label: 'Taxa de cancelamento tardio (%)', type: 'number', min: 0, max: 100, step: '0.5', required: true },
    { name: 'allow_late_cancellation', label: 'Permitir cancelamento online fora do prazo (com taxa/perda do sinal)', type: 'checkbox' },
    { name: 'forfeit_deposit_on_late_cancel', label: 'Cliente perde o sinal ao cancelar fora do prazo', type: 'checkbox' },
    { name: 'refund_on_time_cancel', label: 'Reembolsar valor pago em cancelamentos dentro do prazo', type: 'checkbox' },
    { name: 'cancellation_policy_text', label: 'Texto da política (exibido para a cliente)', type: 'textarea', full: true, required: true, maxlength: 500 },
    { name: 'h2', type: 'html', full: true, html: '<h2 style="margin:var(--space-4) 0 0">Agenda online</h2>' },
    { name: 'slot_interval_minutes', label: 'Intervalo entre horários (min)', type: 'number', min: 5, max: 120, step: 5, required: true },
    { name: 'min_advance_minutes', label: 'Antecedência mínima (min)', type: 'number', min: 0, required: true },
    { name: 'max_advance_days', label: 'Agendar com até (dias)', type: 'number', min: 1, max: 365, required: true },
  ]);
}

function renderPayments() {
  const el = document.getElementById('tp-pagamentos');
  settingsForm(el, [
    { name: 'payment_provider', label: 'Pagamento online', type: 'select', full: true, required: true, options: [
      { value: 'disabled', label: 'Desligado (somente pagamento no estúdio)' }, { value: 'mercadopago', label: 'Mercado Pago (Checkout Pro)' }] },
    { name: 'warn', type: 'html', full: true, html: `<div class="alert alert--warning">${icon('alert')}<div><p>Antes de ligar o Mercado Pago: publique as Edge Functions de pagamento, cadastre as credenciais nos <strong>Secrets</strong> do Supabase e configure o Webhook no painel do Mercado Pago (guia em <code>docs/PAGAMENTOS-MERCADO-PAGO.md</code>).</p><p>As credenciais nunca ficam no site. O ambiente (teste ou produção) é definido pela variável <code>MERCADOPAGO_ENV</code>.</p></div></div>` },
    { name: 'on_site_payment_enabled', label: 'Aceitar pagamento no estúdio (quando o procedimento permitir)', type: 'checkbox' },
    { name: 'payment_hold_minutes', label: 'Tempo para concluir o pagamento online (min)', type: 'number', min: 5, max: 120, required: true, hint: 'Depois disso a reserva expira e o horário volta a ficar livre.' },
  ]);
}

async function renderContact() {
  const el = document.getElementById('tp-contato');
  const channels = settings.notify_channels || [];
  const form = settingsForm(el, [
    { name: 'business_name', label: 'Nome do negócio', required: true },
    { name: 'phone', label: 'Telefone exibido' },
    { name: 'whatsapp', label: 'WhatsApp (com DDI e DDD, só números)', placeholder: '5511960978246' },
    { name: 'instagram', label: 'Instagram (sem @)' },
    { name: 'email', label: 'E-mail de contato', type: 'email' },
    { name: 'maps_url', label: 'Link do Google Maps', type: 'url' },
    { name: 'address', label: 'Endereço', full: true },
    { name: 'ch', type: 'html', full: true, html: `<span class="field-label">Enviar notificações também por</span>
      <div class="chip-list">${[['email', 'E-mail'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS']].map(([v, l]) => `<label class="chip"><input type="checkbox" name="channels" value="${v}" ${channels.includes(v) ? 'checked' : ''}>${l}</label>`).join('')}</div>
      <p class="hint">As mensagens ficam na fila (tabela notifications, status "pending") para um serviço de envio. Veja "Notificações" no README.</p>` },
  ], {
    transform: (v, f) => ({
      ...v,
      whatsapp: v.whatsapp ? onlyDigits(v.whatsapp) : null,
      instagram: v.instagram ? v.instagram.replace(/^@/, '') : null,
      notify_channels: [...f.querySelectorAll('input[name="channels"]:checked')].map((i) => i.value),
    }),
  });
  const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).neq('channel', 'in_app').eq('status', 'pending');
  form.insertAdjacentHTML('beforeend', `<p class="hint">${count || 0} notificação(ões) externas aguardando envio.</p>`);
}

/* ------------------------------------------------------------------ site: galeria e depoimentos */
async function renderSite() {
  const el = document.getElementById('tp-site');
  const [gallery, reviews] = await Promise.all([
    supabase.from('gallery_items').select('*').order('sort_order').then(unwrap),
    supabase.from('reviews').select('*, client:profiles(full_name)').order('created_at', { ascending: false }).then(unwrap),
  ]).catch((err) => { el.innerHTML = errorHTML(errorMessage(err)); return [null, null]; });
  if (!gallery) return;
  el.innerHTML = `
    <div class="panel">
      <div class="panel__head"><h2>Galeria de resultados</h2>
        <label class="btn btn--outline btn--sm">${icon('image')} Adicionar fotos<input type="file" id="gal-input" accept="image/jpeg,image/png,image/webp" multiple class="sr-only"></label></div>
      <p class="muted">Use fotos reais de clientes (com autorização). Elas aparecem na página inicial.</p>
      ${gallery.length ? `<div class="media-grid">${gallery.map((g) => `
        <div class="media-tile ${g.is_active ? '' : 'is-inactive'}"><img src="${esc(g.image_url)}" alt="${esc(g.alt_text)}" loading="lazy">
          <button class="icon-btn icon-btn--danger" data-gdel="${g.id}" aria-label="Remover foto">${icon('trash')}</button>
          <label class="switch" style="position:absolute;left:8px;bottom:8px;background:rgba(255,255,255,.9);padding:4px 8px;border-radius:999px;font-size:12px"><input type="checkbox" data-gtoggle="${g.id}" ${g.is_active ? 'checked' : ''}><span class="switch__track"></span><span>visível</span></label>
        </div>`).join('')}</div>` : emptyHTML({ title: 'Galeria vazia', text: 'Adicione as primeiras fotos de resultados.' })}
    </div>
    <div class="panel" style="margin-top:var(--space-5)">
      <div class="panel__head"><h2>Depoimentos</h2></div>
      <p class="muted">Avaliações enviadas pelas clientes após o atendimento. Só aparecem no site depois de publicadas.</p>
      ${reviews.length ? `<div class="table-wrap"><table class="table table--stack"><tbody>${reviews.map((r) => `
        <tr><td data-label="Cliente"><span class="cell-strong">${esc(r.client?.full_name || '')}</span> ${testBadge(r.is_test_data)}<span class="cell-sub">${fmtDate(r.created_at)}</span></td>
        <td data-label="Nota"><span class="stars">${'★'.repeat(r.rating)}</span></td>
        <td data-label="Comentário">${esc(r.comment)}</td>
        <td data-label="Publicado"><label class="switch"><input type="checkbox" data-rpub="${r.id}" ${r.is_published ? 'checked' : ''} aria-label="Publicar depoimento"><span class="switch__track"></span></label></td>
        <td class="actions-cell"><button class="icon-btn icon-btn--danger" data-rdel="${r.id}" aria-label="Excluir depoimento">${icon('trash')}</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Nenhuma avaliação ainda.</p>'}
    </div>`;

  el.querySelector('#gal-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    toast({ type: 'info', message: `Enviando ${files.length} foto(s)…` });
    let ok = 0;
    for (const [i, file] of files.entries()) {
      try {
        const urlImg = await uploadMedia(file, 'gallery');
        unwrap(await supabase.from('gallery_items').insert({ image_url: urlImg, sort_order: gallery.length + i }));
        ok++;
      } catch (err) { toast({ type: 'error', message: `${file.name}: ${errorMessage(err)}` }); }
    }
    if (ok) toast({ type: 'success', message: `${ok} foto(s) adicionada(s).` });
    renderSite();
  });
  el.querySelectorAll('[data-gdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Remover foto?', message: 'A foto sai da galeria do site.', confirmText: 'Remover', danger: true })) return;
    const { error } = await supabase.from('gallery_items').delete().eq('id', b.dataset.gdel);
    if (error) toast({ type: 'error', message: errorMessage(error) }); else renderSite();
  }));
  el.querySelectorAll('[data-gtoggle]').forEach((c) => c.addEventListener('change', async () => {
    const { error } = await supabase.from('gallery_items').update({ is_active: c.checked }).eq('id', c.dataset.gtoggle);
    if (error) { c.checked = !c.checked; toast({ type: 'error', message: errorMessage(error) }); }
    c.closest('.media-tile').classList.toggle('is-inactive', !c.checked);
  }));
  el.querySelectorAll('[data-rpub]').forEach((c) => c.addEventListener('change', async () => {
    const { error } = await supabase.from('reviews').update({ is_published: c.checked }).eq('id', c.dataset.rpub);
    if (error) { c.checked = !c.checked; toast({ type: 'error', message: errorMessage(error) }); return; }
    toast({ type: 'success', message: c.checked ? 'Depoimento publicado no site.' : 'Depoimento removido do site.' });
  }));
  el.querySelectorAll('[data-rdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Excluir depoimento?', message: 'Esta ação não pode ser desfeita.', confirmText: 'Excluir', danger: true })) return;
    const { error } = await supabase.from('reviews').delete().eq('id', b.dataset.rdel);
    if (error) toast({ type: 'error', message: errorMessage(error) }); else renderSite();
  }));
}

/* ------------------------------------------------------------------ init */
(async () => {
  try { await initAdminPage('configuracoes'); } catch { return; }
  try {
    [settings, employees] = await Promise.all([
      supabase.from('settings').select('*').eq('id', 1).single().then(unwrap),
      supabase.from('employees').select('id, display_name').order('display_name').then(unwrap),
    ]);
  } catch (err) {
    document.getElementById('settings-root').innerHTML = errorHTML(errorMessage(err));
    return;
  }
  const loaders = {
    horarios: renderBusinessHours, datas: renderDates, bloqueios: renderBlocks, politicas: renderPolicies,
    pagamentos: renderPayments, contato: renderContact, site: renderSite,
  };
  const loaded = new Set();
  const open = (name) => {
    if (loaded.has(name)) return;
    loaded.add(name);
    Promise.resolve(loaders[name]?.()).catch((err) => { document.getElementById(`tp-${name}`).innerHTML = errorHTML(errorMessage(err)); });
  };
  const tabs = bindTabs(document.getElementById('settings-tabs'), open);
  tabs.select(location.hash.slice(1) || 'horarios');
})();
