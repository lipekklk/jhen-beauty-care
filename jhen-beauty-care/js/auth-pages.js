/**
 * Telas de login, cadastro, recuperação e redefinição de senha.
 */
import { supabase, supabaseReady } from './supabase.js';
import { signIn, signUp, sendPasswordReset, updatePassword, getSession, getProfile, dashboardUrl, safeNext } from './auth.js';
import { isValidEmail, isValidPhone, maskPhone, passwordStrength, errorMessage, getParam, url, esc } from './utils.js';
import { toast, validate, withLoading, bindPasswordToggles, setFieldError } from './ui.js';

const page = document.body.dataset.page;
const alertBox = document.getElementById('form-alert');

function showAlert(type, message) {
  if (!alertBox) return toast({ type, message });
  alertBox.className = `alert alert--${type}`;
  alertBox.innerHTML = `<p>${esc(message)}</p>`;
  alertBox.hidden = false;
  alertBox.setAttribute('role', type === 'error' ? 'alert' : 'status');
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
  redirectIfLogged();
  if (getParam('expirada')) showAlert('warning', 'Sua sessão expirou. Entre novamente para continuar.');
  if (getParam('saiu')) showAlert('info', 'Você saiu da sua conta.');
  if (getParam('confirmado')) showAlert('success', 'E-mail confirmado. Agora é só entrar.');
  if (getParam('cadastro')) showAlert('success', 'Conta criada! Confirme seu e-mail pelo link que enviamos e depois entre aqui.');
  if (getParam('next')?.includes('agendamento')) showAlert('info', 'Entre ou crie sua conta para concluir o agendamento.');

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
        const profile = await getProfile(true);
        location.href = safeNext(getParam('next')) || dashboardUrl(profile.role);
      } catch (err) {
        showAlert('error', errorMessage(err, 'Não foi possível entrar. Tente novamente.'));
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
          toast({ type: 'success', message: 'Conta criada! Bem-vinda.' });
          location.href = next || dashboardUrl('client');
        } else {
          location.href = url(`login.html?cadastro=1${next ? `&next=${encodeURIComponent(getParam('next'))}` : ''}`);
        }
      } catch (err) {
        if (/already registered/i.test(err.message)) setFieldError(form.email, 'Este e-mail já tem cadastro.');
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
