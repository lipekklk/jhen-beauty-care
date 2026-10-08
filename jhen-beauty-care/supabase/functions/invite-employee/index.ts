// =============================================================================
// Edge Function: invite-employee (opcional)
// Convida por e-mail uma profissional que ainda não tem conta e já a cadastra na equipe.
// Somente administradoras podem chamar. Usa a service_role APENAS no servidor.
// Secrets: SITE_URL
// =============================================================================
import { adminClient, callerUser, corsHeaders, env, json } from '../_shared/utils.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  try {
    const caller = await callerUser(req);
    if (!caller) return json(req, { message: 'NOT_AUTHENTICATED' }, 401);
    const { data: isAdmin } = await caller.client.rpc('is_admin');
    if (!isAdmin) return json(req, { message: 'FORBIDDEN' }, 403);

    const { email, display_name, title } = await req.json().catch(() => ({}));
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(req, { message: 'E-mail inválido' }, 400);

    const db = adminClient();
    const { data, error } = await db.auth.admin.inviteUserByEmail(String(email).toLowerCase(), {
      data: { full_name: display_name ?? '' },
      redirectTo: `${env('SITE_URL')}/redefinir-senha.html`,
    });
    if (error || !data.user) return json(req, { message: error?.message ?? 'Falha ao convidar' }, 400);

    // perfil é criado pelo trigger handle_new_user; promove e cadastra na equipe
    await db.from('profiles').update({ role: 'employee' }).eq('id', data.user.id);
    await db.from('employees').upsert({
      profile_id: data.user.id,
      display_name: display_name || email.split('@')[0],
      title: title || 'Designer de sobrancelhas',
      is_active: true,
    }, { onConflict: 'profile_id' });

    return json(req, { ok: true, user_id: data.user.id });
  } catch (err) {
    console.error(err);
    return json(req, { message: 'Erro interno' }, 500);
  }
});
