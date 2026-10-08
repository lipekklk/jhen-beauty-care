/**
 * Configuração pública do front-end.
 *
 * ⚠️ Coloque aqui SOMENTE a URL do projeto e a chave pública "anon"/"publishable".
 *    Elas são feitas para ficar no navegador: a segurança vem das policies RLS do banco.
 *    NUNCA coloque a service_role key, tokens de gateway de pagamento ou senhas neste arquivo.
 *
 * Onde encontrar: Supabase → Project Settings → API (Project URL e anon/public key).
 */
 export const SUPABASE_URL = 'https://wkdiguedkhiubmdlwpce.supabase.co';
 export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrZGlndWVka2hpdWJtZGx3cGNlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MTA3MzEsImV4cCI6MjEwNjk4NjczMX0.QaMB6_tnY459EZIP1u1vPjmr4bjfoLLkmVpMtZB7DI4';

/** Fuso horário padrão do negócio (o valor oficial fica em settings.timezone no banco). */
export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
