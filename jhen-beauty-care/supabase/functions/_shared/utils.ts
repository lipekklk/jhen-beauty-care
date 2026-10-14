// Utilitários compartilhados pelas Edge Functions (Deno).
// Regras: nunca registrar tokens, corpo de requisições ou dados pessoais nos logs;
// nunca devolver segredos nas respostas.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new ConfigError(name);
  return v;
}

/** Variável ausente: a função responde 503 sem revelar qual segredo falta. */
export class ConfigError extends Error {
  constructor(public variable: string) {
    super(`config_missing:${variable}`);
  }
}

/** Origens autorizadas a chamar as funções pelo navegador (CORS). */
function allowedOrigins(): string[] {
  const list = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const site = Deno.env.get('SITE_URL');
  if (site) {
    try {
      list.push(new URL(site).origin);
    } catch { /* SITE_URL inválida: ignorada */ }
  }
  return list;
}

export function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // chamadas servidor-servidor (sem navegador) — a autenticação continua obrigatória
  return allowedOrigins().includes(origin);
}

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') ?? '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  if (origin && allowedOrigins().includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Resposta de erro padronizada: só um código, sem detalhes internos. */
export const fail = (req: Request, status: number, code: string) => json(req, { error: code }, status);

/** Cliente com service_role: ignora RLS. Usado só aqui no servidor. */
export function adminClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Valida o JWT de quem chamou (sessão do Supabase Auth) e devolve o usuário. */
export async function callerUser(req: Request) {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return { user: data.user, client };
}

export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Lê o corpo JSON com limite de tamanho (protege contra payloads gigantes/malformados). */
export async function readJson(req: Request, maxBytes = 16_384): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Limite de requisições (janela fixa) guardado no banco. true = pode seguir. */
export async function rateLimit(db: SupabaseClient, bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await db.rpc('rate_limit_hit', { p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) {
    console.error('rate_limit_hit falhou', error.code);
    return true; // falha no limitador não derruba o pagamento
  }
  return data === true;
}

/** Log estruturado e enxuto (sem dados pessoais nem segredos). */
export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

/** Código curto de um erro para log (nunca a mensagem completa de terceiros, que pode conter dados). */
export function errCode(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 80);
  if (err && typeof err === 'object' && 'code' in err) return `db_${String((err as { code: unknown }).code).slice(0, 20)}`;
  return 'error';
}
