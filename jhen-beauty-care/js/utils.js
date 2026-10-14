/**
 * Utilitários compartilhados: caminhos, formatação, datas no fuso do negócio,
 * rótulos de status, validação e tradução de erros.
 */
import { DEFAULT_TIMEZONE } from './config.js';

/* ------------------------------------------------------------------ caminhos */
/** Raiz do site, calculada a partir deste arquivo (funciona em qualquer subpasta). */
export const ROOT = new URL('../', import.meta.url);
export const url = (path = '') => new URL(path, ROOT).href;

/* ------------------------------------------------------------------ DOM */
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
export const getParam = (name) => new URLSearchParams(location.search).get(name);

/** Escapa texto para uso seguro em innerHTML. Use SEMPRE em dados vindos do banco. */
export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function debounce(fn, wait = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

export function initials(name = '') {
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase() || 'J';
}
export const firstName = (name = '') => name.replace(/\(.*?\)/g, '').trim().split(/\s+/)[0] || '';

/* ------------------------------------------------------------------ fuso e datas */
let TZ = DEFAULT_TIMEZONE;
export const setTimezone = (tz) => { if (tz) TZ = tz; };
export const getTimezone = () => TZ;

const dtf = (opts) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts });

/** 'YYYY-MM-DD' de um instante, no fuso do negócio. */
export function dateKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export const todayKey = () => dateKey(new Date());

/** Soma dias a uma chave 'YYYY-MM-DD' (aritmética de calendário, sem fuso). */
export function addDaysKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
/** Dia da semana (0=domingo) de uma chave 'YYYY-MM-DD'. */
export function weekdayOfKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
/** Date "neutra" (meio-dia UTC) para formatar uma chave de data sem deslocamento de fuso. */
export function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
/** Converte data local do negócio + hora ('HH:MM') em ISO UTC. */
export function localToISO(key, hhmm) {
  // descobre o offset do fuso naquele dia
  const guess = new Date(`${key}T${hhmm}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(guess);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const offset = asLocal - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

export const fmtTime = (iso) => dtf({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export const fmtDate = (iso) => dtf({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
export const fmtDateShort = (iso) => dtf({ day: '2-digit', month: 'short' }).format(new Date(iso)).replace('.', '');
export const fmtDateLong = (iso) => dtf({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
export const fmtDateTime = (iso) => `${fmtDate(iso)} às ${fmtTime(iso)}`;
export const fmtWeekdayShort = (iso) => dtf({ weekday: 'short' }).format(new Date(iso)).replace('.', '');
export const fmtMonthShort = (iso) => dtf({ month: 'short' }).format(new Date(iso)).replace('.', '');
export const fmtDayNum = (iso) => dtf({ day: 'numeric' }).format(new Date(iso));
export const capFirst = (t = '') => t.charAt(0).toUpperCase() + t.slice(1);
export const fmtKeyLong = (key) =>
  capFirst(new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(keyToDate(key)));
export const fmtKeyShort = (key) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }).format(keyToDate(key));
export const fmtRelative = (iso) => {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
};

export const fmtMoney = (value) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
export function fmtDuration(minutes) {
  const m = Number(minutes || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`;
}

/* ------------------------------------------------------------------ rótulos */
export const STATUS_LABELS = {
  pending_payment: 'Aguardando pagamento',
  scheduled: 'Agendado',
  confirmed: 'Confirmado',
  arrived: 'Cliente chegou',
  in_progress: 'Em atendimento',
  completed: 'Concluído',
  cancelled: 'Cancelado',
  no_show: 'Não compareceu',
};
export const PAYMENT_STATUS_LABELS = {
  pending: 'Pendente',
  in_process: 'Em análise',
  approved: 'Aprovado',
  rejected: 'Recusado',
  cancelled: 'Cancelado',
  refund_pending: 'Estorno pendente',
  refunded: 'Estornado',
  charged_back: 'Contestado',
  in_mediation: 'Em disputa',
};
export const METHOD_LABELS = { online: 'Mercado Pago', pix: 'PIX', card: 'Cartão', on_site: 'No local' };
/** Meio usado dentro do Mercado Pago (payment_type_id oficial). */
export const PAYMENT_TYPE_LABELS = {
  credit_card: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  prepaid_card: 'Cartão pré-pago',
  bank_transfer: 'Pix',
  account_money: 'Saldo Mercado Pago',
  digital_currency: 'Mercado Crédito',
  digital_wallet: 'Carteira digital',
  ticket: 'Boleto',
};
/** "Cartão de crédito · Visa final 1234" — só dados mascarados devolvidos pelo Mercado Pago. */
export function paymentMethodLabel(p = {}) {
  if (p.method === 'on_site' || p.payment_method === 'on_site') return 'No estúdio';
  const type = p.payment_type ? (PAYMENT_TYPE_LABELS[p.payment_type] || 'Mercado Pago') : null;
  if (!type) return METHOD_LABELS[p.method || p.payment_method] || 'Mercado Pago';
  const brand = p.payment_method_id && !['pix', 'account_money'].includes(p.payment_method_id)
    ? ` · ${p.payment_method_id.charAt(0).toUpperCase()}${p.payment_method_id.slice(1)}` : '';
  const last4 = p.card_last_four ? ` final ${p.card_last_four}` : '';
  return `${type}${brand}${last4}`;
}
export const KIND_LABELS = { full: 'Valor integral', deposit: 'Sinal', on_site: 'Pagamento no local' };
export const ROLE_LABELS = { client: 'Cliente', employee: 'Funcionária', admin: 'Administradora' };
export const WEEKDAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
export const BLOCK_TYPE_LABELS = { day_off: 'Folga', vacation: 'Férias', block: 'Bloqueio' };

export const statusBadge = (s) => `<span class="badge status--${esc(s)}">${esc(STATUS_LABELS[s] || s)}</span>`;
export const paymentBadge = (s) => `<span class="badge status--${esc(s)}">${esc(PAYMENT_STATUS_LABELS[s] || s)}</span>`;
export const testBadge = (flag) => (flag ? '<span class="badge badge--test" title="Dado fictício para testes">teste</span>' : '');

/** Resumo do pagamento de um agendamento a partir da lista de payments. */
export function paymentSummary(payments = []) {
  const approved = payments.filter((p) => ['approved', 'refund_pending'].includes(p.status)
    || (p.status === 'refunded' && Number(p.refund_amount) < Number(p.amount)));
  const paid = approved.reduce((s, p) => s + Number(p.amount), 0);
  const main = payments.slice().sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
  let label = 'Pendente';
  let status = 'pending';
  if (approved.some((p) => p.kind === 'full')) { label = 'Pago'; status = 'approved'; }
  else if (approved.some((p) => p.kind === 'deposit')) { label = 'Sinal pago'; status = 'approved'; }
  else if (main?.method === 'on_site') { label = 'Pagar no local'; status = 'pending'; }
  else if (main?.status === 'rejected') { label = 'Recusado'; status = 'rejected'; }
  else if (main?.status === 'in_process') { label = 'Em análise'; status = 'in_process'; }
  if (payments.some((p) => p.status === 'refund_pending')) { label = 'Estorno pendente'; status = 'refund_pending'; }
  if (payments.some((p) => p.status === 'refunded')) { label = 'Estornado'; status = 'refunded'; }
  if (payments.some((p) => p.status === 'in_mediation')) { label = 'Em disputa'; status = 'in_mediation'; }
  if (payments.some((p) => p.status === 'charged_back')) { label = 'Contestado'; status = 'charged_back'; }
  return { paid, label, status, main };
}

/* ------------------------------------------------------------------ validação */
export const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim());
export const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
export const isValidPhone = (v) => { const d = onlyDigits(v); return d.length >= 10 && d.length <= 13; };

/** Máscara (11) 91234-5678 aplicada enquanto digita. */
export function maskPhone(input) {
  input.addEventListener('input', () => {
    const d = onlyDigits(input.value).slice(0, 11);
    let out = d;
    if (d.length > 2) out = `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length > 7) out = `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
    input.value = out;
  });
}

export function passwordStrength(pw = '') {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(score, 4); // 0..4
}

export const waLink = (number, text = '') =>
  `https://wa.me/${onlyDigits(number)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

/** Link do perfil do Instagram a partir do usuário (com ou sem @). */
export const igLink = (user = '') =>
  `https://www.instagram.com/${encodeURIComponent(String(user).trim().replace(/^@/, ''))}/`;

/* ------------------------------------------------------------------ erros */
export const ERROR_MESSAGES = {
  NOT_AUTHENTICATED: 'Sua sessão expirou. Entre novamente para continuar.',
  PROFILE_NOT_FOUND: 'Não encontramos seu cadastro. Saia e entre novamente.',
  ACCOUNT_BLOCKED: 'Sua conta está bloqueada para novos agendamentos. Fale com o estúdio.',
  SERVICE_NOT_FOUND: 'Este procedimento não está mais disponível.',
  EMPLOYEE_NOT_ENABLED: 'Esta profissional não realiza o procedimento escolhido.',
  SLOT_UNAVAILABLE: 'Este horário não está mais disponível. Escolha outro horário.',
  SLOT_TAKEN: 'Este horário acabou de ser reservado por outro cliente. Escolha outro horário.',
  CLIENT_CONFLICT: 'Você já tem um atendimento neste horário.',
  PAYMENT_METHOD_NOT_ALLOWED: 'Esta forma de pagamento não está disponível para o procedimento.',
  APPOINTMENT_NOT_FOUND: 'Agendamento não encontrado.',
  FORBIDDEN: 'Você não tem permissão para esta ação.',
  INVALID_STATUS: 'Esta ação não é possível no status atual do agendamento.',
  CANCELLATION_NOT_ALLOWED: 'O prazo para cancelamento online já passou. Fale com o estúdio pelo WhatsApp.',
  RESCHEDULE_NOT_ALLOWED: 'O prazo para remarcar online já passou. Fale com o estúdio pelo WhatsApp.',
  RESCHEDULE_LIMIT: 'Você atingiu o limite de remarcações deste agendamento.',
  TOO_EARLY_FOR_STATUS: 'Este status só pode ser usado no dia do atendimento.',
  PAYMENT_EXPIRED: 'O prazo para pagar esta reserva acabou e o horário foi liberado. Faça um novo agendamento.',
  ONLINE_PAYMENT_UNAVAILABLE: 'O pagamento online está indisponível no momento. Escolha pagar no estúdio ou fale com a gente.',
  ALREADY_PAID: 'Este agendamento já está pago.',
  PAYMENT_IN_PROCESS: 'Seu pagamento está em análise pelo Mercado Pago. Aguarde a confirmação antes de tentar de novo.',
  NOT_ONLINE_PAYMENT: 'Este agendamento é pago no estúdio.',
  GATEWAY_UNAVAILABLE: 'Não foi possível conectar ao Mercado Pago agora. Tente novamente em instantes.',
  REFUND_FAILED: 'O Mercado Pago não aceitou o estorno agora. Tente novamente ou faça pelo painel do Mercado Pago.',
  NOTHING_TO_REFUND: 'Não há valor a estornar.',
  TOO_MANY_REQUESTS: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.',
  PAYMENT_STATUS_LOCKED: 'Pagamentos online só mudam de status pela confirmação do Mercado Pago.',
  ORIGIN_NOT_ALLOWED: 'Este endereço do site não está autorizado a processar pagamentos. Verifique a configuração.',
  INVALID_REQUEST: 'Requisição inválida.',
  NOT_FOUND: 'Registro não encontrado.',
  INTERNAL_ERROR: 'Algo deu errado do nosso lado. Tente novamente.',
  USER_NOT_FOUND: 'Nenhuma conta com este e-mail. Peça para a pessoa se cadastrar primeiro ou envie um convite.',
  CANNOT_DEMOTE_SELF: 'Você não pode remover seu próprio acesso de administradora.',
  INVALID_IMAGE_TYPE: 'Envie uma imagem JPG, PNG ou WebP.',
  IMAGE_TOO_LARGE: 'A imagem deve ter no máximo 5 MB.',
  CONFIG_MISSING: 'O site ainda não foi conectado ao Supabase. Configure js/config.js.',
  USER_ALREADY_REGISTERED: 'Já existe uma conta com este e-mail. Entre ou recupere a senha.',
  'Invalid login credentials': 'E-mail ou senha incorretos.',
  'Email not confirmed': 'Seu e-mail ainda não foi confirmado. Clique no link que enviamos no cadastro.',
  'User already registered': 'Já existe uma conta com este e-mail. Tente entrar ou recuperar a senha.',
  'Signups not allowed for this instance': 'Novos cadastros estão desativados no momento. Fale com o estúdio.',
  'Password should be at least 6 characters': 'A senha precisa ter pelo menos 8 caracteres.',
  'New password should be different from the old password.': 'A nova senha precisa ser diferente da atual.',
  'Email rate limit exceeded': 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
};

/** Converte qualquer erro (Supabase, rede, código de negócio) numa frase clara em português. */
export function errorMessage(err, fallback = 'Algo deu errado. Tente novamente.') {
  if (!err) return fallback;
  const msg = String(err.message || err.error_description || err || '');
  for (const [key, text] of Object.entries(ERROR_MESSAGES)) {
    if (msg === key || msg.startsWith(key) || msg.includes(`${key}`) && key === key.toUpperCase()) return text;
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'Sem conexão com o servidor. Verifique sua internet e tente novamente.';
  if (/jwt expired|invalid jwt|refresh token/i.test(msg)) return ERROR_MESSAGES.NOT_AUTHENTICATED;
  if (err.code === '42501' || /row-level security|permission denied/i.test(msg)) return ERROR_MESSAGES.FORBIDDEN;
  if (err.code === '23505') return 'Já existe um registro com estes dados.';
  if (err.code === '23503') return 'Este registro está em uso e não pode ser removido. Desative-o em vez de excluir.';
  if (err.code === '23514' || err.code === '22P02') return 'Verifique os dados informados.';
  if (/rate limit|over_email_send_rate_limit|too many requests/i.test(msg) || err.status === 429) return ERROR_MESSAGES['Email rate limit exceeded'];
  if (/for security purposes, you can only request this after/i.test(msg)) return 'Aguarde alguns segundos antes de pedir outro e-mail.';
  if (/email address .* is invalid|invalid email|unable to validate email/i.test(msg)) return 'Este e-mail não foi aceito. Confira se está correto e use um endereço real.';
  if (err.code === 'PGRST116') return ERROR_MESSAGES.PROFILE_NOT_FOUND;
  if (/error sending (confirmation|recovery) email/i.test(msg)) return 'O servidor de e-mail recusou o envio. Tente de novo em alguns minutos.';
  return fallback;
}

/** Lança o erro de uma resposta do Supabase, ou retorna os dados. */
export function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}
