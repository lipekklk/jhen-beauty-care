/**
 * Telas de login, cadastro, recuperação e redefinição de senha.
 */
import { supabase, supabaseReady } from './supabase.js';
import {
  signIn, signUp, sendPasswordReset, updatePassword, getSession, getProfile, dashboardUrl, safeNext, resendConfirmation,
} from './auth.js';
import { isValidEmail, isValidPhone, maskPhone, passwordStrength, errorMessage, getParam, url, esc } from './utils.js';
import { toast, validate, withLoading, bindPasswordToggles, setFieldError } from './ui.js';

const page = document.body.dataset.page;
const alertBox = document.getElementById('form-alert');

/** Mostra um aviso no topo do formulário. actionsHTML: botões/links extras (já escapados). */
function showAlert(type, message, actionsHTML = '') {
  if (!alertBox) return toast({ type, message });
  alertBox.className = `alert alert--${type}`;
  alertBox.innerHTML = `<div><p>${esc(message)}</p>${actionsHTML ? `<p style="margin-top:var(--space-2)">${actionsHTML}</p>` : ''}</div>`;
  alertBox.hidden = false;
  alertBox.setAttribute('role', type === 'error' ? 'alert' : 'status');
  return alertBox;
}

/** Aviso com botão "Reenviar e-mail de confirmação" para o endereço informado. */
function showResend(type, message, email) {
  const box = showAlert(type, message, '<button type="button" class="link-btn" data-resend>Reenviar e-mail de confirmação</button>');
  box.querySelector('[data-resend]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const target = email || document.getElementById('email')?.value || '';
    if (!isValidEmail(target)) { showAlert('error', 'Informe seu e-mail no campo acima para reenviar a confirmação.'); return; }
    await withLoading(btn, async () => {
      try {
        await resendConfirmation(target);
        showAlert('success', `Enviamos um novo link de confirmação para ${target}. Verifique também a caixa de spam. O link vale por 24 horas.`);
      } catch (err) {
        showAlert('error', errorMessage(err, 'Não foi possível reenviar agora. Aguarde alguns minutos e tente de novo.'));
      }
    }, 'Enviando…');
  });
}

/** Erros que o Supabase devolve no #hash do link de e-mail (ex.: link expirado ou já usado). */
function linkErrorFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const code = h.get('error_code') || h.get('error');
  if (!code) return null;
  history.replaceState(null, '', location.pathname + location.search.replace(/[?&]confirmado=1/, ''));
  return code;
}

const passwordRule = (v) => (v.length < 8 ? 'Use pelo menos 8 caracteres.' : '');

function bindStrengthMeter(input) {
  const meter = document.querySelector('.password-meter span');
  const label = document.getElementById('password-strength');
  if (!meter) return;
  const colors = ['#B03A3E', '#B03A3E', '#9A6A1E', '#4E7A5B', '#4E7A5B'];
  const names = ['muito fraca', 'fraca', 'razoável', 'boa', 'forte'];
  input.addEventListener('input', () => {
    const s = passwordStrength(input.value);
    meter.style.width = `${(s + 1) * 20}%`;
    meter.style.background = colors[s];
    if (label) label.textContent = input.value ? `Senha ${names[s]}` : '';
  });
}

async function redirectIfLogged() {
  if (!supabaseReady) return;
  const session = await getSession();
  if (!session) return;
  const profile = await getProfile().catch(() => null);
  if (profile) location.replace(safeNext(getParam('next')) || dashboardUrl(profile.role));
}

/* ------------------------------------------------------------------ login */
function initLogin() {
  const linkError = linkErrorFromHash();
  const registeredEmail = getParam('email') || '';
  const emailInput = document.getElementById('email');
  if (registeredEmail && emailInput) emailInput.value = registeredEmail;

  if (linkError) {
    showResend('error', linkError === 'otp_expired'
      ? 'O link de confirmação expirou ou já foi usado. Peça um novo abaixo.'
      : 'Não foi possível confirmar seu e-mail por este link. Peça um novo abaixo.', registeredEmail);
  } else {
    redirectIfLogged(); // link de confirmação válido já cria a sessão: vai direto para a área
    if (getParam('expirada')) showAlert('warning', 'Sua sessão expirou. Entre novamente para continuar.');
    if (getParam('saiu')) showAlert('info', 'Você saiu da sua conta.');
    if (getParam('confirmado')) showAlert('success', 'E-mail confirmado. Agora é só entrar.');
    if (getParam('cadastro')) {
      showResend('success', `Conta criada! Enviamos um link de confirmação para ${registeredEmail || 'o seu e-mail'}. Clique nele e depois entre aqui. Não chegou em alguns minutos? Veja o spam ou reenvie.`, registeredEmail);
    }
    if (getParam('next')?.includes('agendamento') && !getParam('cadastro')) showAlert('info', 'Entre ou crie sua conta para concluir o agendamento.');
  }

  const signupLink = document.getElementById('signup-link');
  if (signupLink && getParam('next')) signupLink.href = url(`cadastro.html?next=${encodeURIComponent(getParam('next'))}`);

  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = validate(form, {
      email: (v) => (!isValidEmail(v) ? 'Informe um e-mail válido.' : ''),
      password: (v) => (!v ? 'Informe sua senha.' : ''),
    });
    if (!ok) return;
    await withLoading(form.querySelector('[type="submit"]'), async () => {
      try {
        await signIn(form.email.value, form.password.value);
      } catch (err) {
        console.error('[login] signInWithPassword', err);
        if (/email not confirmed/i.test(err.message) || err.code === 'email_not_confirmed') {
          showResend('warning', 'Seu e-mail ainda não foi confirmado. Clique no link que enviamos no cadastro ou peça um novo.', form.email.value);
        } else {
          showAlert('error', errorMessage(err, 'Não foi possível entrar. Tente novamente.'),
            /invalid login credentials/i.test(err.message) ? `<a href="${url('recuperar-senha.html')}">Esqueci minha senha</a>` : '');
        }
        return;
      }
      try {
        const profile = await getProfile(true);
        location.href = safeNext(getParam('next')) || dashboardUrl(profile.role);
      } catch (err) {
        // login no Auth funcionou, mas o perfil não pôde ser lido/criado
        console.error('[login] perfil', err);
        showAlert('error', errorMessage(err, 'Você entrou, mas não conseguimos carregar seu cadastro. Tente novamente em instantes.'));
      }
    }, 'Entrando…');
  });
}

/* ------------------------------------------------------------------ cadastro */
function initSignup() {
  redirectIfLogged();
  const form = document.getElementById('signup-form');
  maskPhone(form.phone);
  bindStrengthMeter(form.password);
  const loginLink = document.getElementById('login-link');
  if (loginLink && getParam('next')) loginLink.href = url(`login.html?next=${encodeURIComponent(getParam('next'))}`);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = validate(form, {
      full_name: (v) => (v.length < 3 ? 'Informe seu nome completo.' : ''),
      email: (v) => (!isValidEmail(v) ? 'Informe um e-mail válido.' : ''),
      phone: (v) => (!isValidPhone(v) ? 'Informe um celular com DDD.' : ''),
      password: passwordRule,
      password_confirm: (v, f) => (v !== f.password.value ? 'As senhas não conferem.' : ''),
      terms: (v) => (!v ? 'É preciso aceitar para continuar.' : ''),
    });
    if (!ok) return;
    await withLoading(form.querySelector('[type="submit"]'), async () => {
      try {
        const data = await signUp({
          fullName: form.full_name.value, email: form.email.value, phone: form.phone.value, password: form.password.value,
        });
        const next = safeNext(getParam('next'));
        if (data.session) {
          // confirmação de e-mail desligada no Supabase: a conta já entra logada
          toast({ type: 'success', message: 'Conta criada! Bem-vinda.' });
          location.href = next || dashboardUrl('client');
        } else {
          const email = form.email.value.trim().toLowerCase();
          location.href = url(`login.html?cadastro=1&email=${encodeURIComponent(email)}${next ? `&next=${encodeURIComponent(getParam('next'))}` : ''}`);
        }
      } catch (err) {
        console.error('[cadastro] signUp', err);
        if (/USER_ALREADY_REGISTERED|already registered/i.test(err.message)) {
          setFieldError(form.email, 'Este e-mail já tem cadastro.');
          const email = encodeURIComponent(form.email.value.trim().toLowerCase());
          showAlert('warning', 'Já existe uma conta com este e-mail, por isso não criamos outra nem enviamos e-mail.',
            `<a href="${url(`login.html?email=${email}`)}">Entrar</a> · <a href="${url('recuperar-senha.html')}">Recuperar senha</a> · <button type="button" class="link-btn" data-resend-existing>Reenviar confirmação</button>`);
          alertBox.querySelector('[data-resend-existing]')?.addEventListener('click', () => showResend('info', 'Se a conta ainda não foi confirmada, enviaremos um novo link.', form.email.value));
          return;
        }
        showAlert('error', errorMessage(err, 'Não foi possível criar sua conta.'));
      }
    }, 'Criando conta…');
  });
}

/* ------------------------------------------------------------------ recuperar senha */
function initRecover() {
  const form = document.getElementById('recover-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate(form, { email: (v) => (!isValidEmail(v) ? 'Informe um e-mail válido.' : '') })) return;
    await withLoading(form.querySelector('[type="submit"]'), async () => {
      try {
        await sendPasswordReset(form.email.value);
      } catch (err) {
        // rate limit é o único erro que vale mostrar; não revelamos se o e-mail existe
        if (/rate limit/i.test(err.message)) { showAlert('error', errorMessage(err)); return; }
      }
      showAlert('success', 'Se este e-mail tiver cadastro, você vai receber um link para criar uma nova senha em alguns minutos.');
      form.reset();
    }, 'Enviando…');
  });
}

/* ------------------------------------------------------------------ redefinir senha */
function initReset() {
  const form = document.getElementById('reset-form');
  bindStrengthMeter(form.password);
  const submit = form.querySelector('[type="submit"]');
  let ready = false;

  const enable = () => { ready = true; submit.disabled = false; alertBox.hidden = true; };
  supabase.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') enable(); });
  getSession().then((s) => {
    if (s) enable();
    else setTimeout(() => {
      if (!ready) showAlert('warning', 'Este link expirou ou já foi usado. Peça um novo link de recuperação.');
    }, 2500);
  });
  const errDesc = new URLSearchParams(location.hash.slice(1)).get('error_description');
  if (errDesc) showAlert('error', 'Este link expirou ou já foi usado. Peça um novo link de recuperação.');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate(form, {
      password: passwordRule,
      password_confirm: (v, f) => (v !== f.password.value ? 'As senhas não conferem.' : ''),
    })) return;
    await withLoading(submit, async () => {
      try {
        await updatePassword(form.password.value);
        const profile = await getProfile(true);
        toast({ type: 'success', message: 'Senha alterada com sucesso.' });
        setTimeout(() => { location.href = dashboardUrl(profile?.role); }, 900);
      } catch (err) {
        showAlert('error', errorMessage(err, 'Não foi possível alterar a senha.'));
      }
    }, 'Salvando…');
  });
}

/* ------------------------------------------------------------------ init */
bindPasswordToggles();
if (!supabaseReady) showAlert('warning', errorMessage({ message: 'CONFIG_MISSING' }));
({ login: initLogin, cadastro: initSignup, recuperar: initRecover, redefinir: initReset })[page]?.();
