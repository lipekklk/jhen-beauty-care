/**
 * Autenticação e controle de acesso por papel (role).
 * A verificação aqui é de EXPERIÊNCIA (redirecionar para a área certa);
 * a segurança real está nas policies RLS e nas funções do banco.
 */
import { supabase, supabaseReady } from './supabase.js';
import { url, errorMessage } from './utils.js';
import { toast } from './ui.js';

let profileCache = null;

export const DASHBOARD_BY_ROLE = {
  client: 'cliente/dashboard.html',
  employee: 'funcionario/dashboard.html',
  admin: 'admin/dashboard.html',
};

export async function getSession() {
  if (!supabaseReady) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** Perfil do usuário logado (com cache por página). Retorna null se não logado. */
export async function getProfile(force = false) {
  if (profileCache && !force) return profileCache;
  const session = await getSession();
  if (!session) return null;
  let { data, error } = await supabase
    .from('profiles')
    .select('id, role, full_name, email, phone, birth_date, avatar_url, is_blocked, is_test_data')
    .eq('id', session.user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // Conta existe no Auth mas está sem perfil (criada antes do trigger ou perfil apagado):
    // recria a partir dos dados do cadastro em vez de bloquear o login.
    console.warn('[auth] perfil ausente para', session.user.id, '— recriando via ensure_profile()');
    ({ data, error } = await supabase.rpc('ensure_profile'));
    if (error) throw error;
    if (!data?.id) throw new Error('PROFILE_NOT_FOUND');
  }
  // id do registro de profissional (admin também pode atender)
  const { data: empId } = await supabase.rpc('current_employee_id');
  profileCache = { ...data, employee_id: empId || null, auth_email: session.user.email };
  return profileCache;
}
export const clearProfileCache = () => { profileCache = null; };

export function dashboardUrl(role) {
  return url(DASHBOARD_BY_ROLE[role] || DASHBOARD_BY_ROLE.client);
}

/** Destino seguro pós-login: só aceita caminhos do próprio site. */
export function safeNext(next) {
  if (!next) return null;
  try {
    const target = new URL(next, location.href);
    return target.origin === location.origin ? target.href : null;
  } catch { return null; }
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) throw error;
  clearProfileCache();
  return data;
}

export async function signUp({ fullName, email, phone, password }) {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      data: { full_name: fullName.trim(), phone: phone.trim() },
      emailRedirectTo: url('login.html?confirmado=1'),
    },
  });
  if (error) throw error;
  // Com "Confirm email" ligado, o Supabase NÃO retorna erro para e-mail já cadastrado:
  // devolve um usuário "falso" sem identidades (proteção contra descoberta de e-mails),
  // não cria nada e não envia e-mail. Detectamos para avisar a pessoa corretamente.
  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error('USER_ALREADY_REGISTERED');
  }
  return data; // data.session é null quando a confirmação de e-mail está ativa
}

/** Reenvia o e-mail de confirmação de cadastro. */
export async function resendConfirmation(email) {
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: url('login.html?confirmado=1') },
  });
  if (error) throw error;
}

let signingOut = false;

export async function signOut({ redirect = true } = {}) {
  signingOut = true; // evita que o watchSession trate o logout como "sessão expirada"
  await supabase.auth.signOut().catch(() => {});
  clearProfileCache();
  if (redirect) location.href = url('login.html?saiu=1');
}

export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: url('redefinir-senha.html'),
  });
  if (error) throw error;
}

export async function updatePassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

/**
 * Protege uma página. roles: lista de papéis aceitos. 'employee' aceita também
 * admins que possuem cadastro de profissional.
 * Retorna o perfil ou redireciona.
 */
export async function requireRole(roles) {
  if (!supabaseReady) {
    document.body.innerHTML = `<main class="container section"><div class="alert alert--warning"><p>${errorMessage({ message: 'CONFIG_MISSING' })}</p></div></main>`;
    throw new Error('CONFIG_MISSING');
  }
  const session = await getSession();
  if (!session) {
    location.replace(url(`login.html?next=${encodeURIComponent(location.pathname + location.search)}`));
    throw new Error('NOT_AUTHENTICATED');
  }
  let profile;
  try {
    profile = await getProfile();
  } catch (err) {
    toast({ type: 'error', message: errorMessage(err) });
    throw err;
  }
  if (profile.is_blocked && profile.role === 'client') {
    // cliente bloqueado ainda pode ver seus dados, mas recebe aviso
    toast({ type: 'warning', message: 'Sua conta está bloqueada para novos agendamentos. Fale com o estúdio.', timeout: 9000 });
  }
  const allowed = roles.includes(profile.role) || (roles.includes('employee') && profile.employee_id);
  if (!allowed) {
    location.replace(dashboardUrl(profile.role));
    throw new Error('FORBIDDEN');
  }
  watchSession();
  return profile;
}

/** Sessão expirada / logout em outra aba → volta para o login com aviso. */
let watching = false;
export function watchSession() {
  if (watching) return;
  watching = true;
  supabase.auth.onAuthStateChange((event, session) => {
    if (signingOut) return;
    if (event === 'SIGNED_OUT' || (event === 'TOKEN_REFRESHED' && !session)) {
      clearProfileCache();
      location.replace(url(`login.html?expirada=1&next=${encodeURIComponent(location.pathname)}`));
    }
  });
}
