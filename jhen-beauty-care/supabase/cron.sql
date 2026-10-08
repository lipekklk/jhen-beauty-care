-- =============================================================================
--  cron.sql — tarefas agendadas (OPCIONAL, recomendado em produção)
--  Pré-requisito: Supabase → Database → Extensions → habilite "pg_cron" e "pg_net".
--  Substitua <PROJECT_REF> e <CRON_SECRET> antes de executar.
-- =============================================================================

-- 1) Libera reservas cujo pagamento online expirou (a cada 5 min).
--    O sistema já faz isso sob demanda ao consultar horários; o cron mantém o painel limpo.
select cron.schedule('jhen-expire-holds', '*/5 * * * *', $$ select public.expire_pending_appointments(); $$);

-- 2) Cria lembretes ~24h antes do atendimento (a cada 30 min).
select cron.schedule('jhen-reminders', '*/30 * * * *', $$ select public.enqueue_reminders(); $$);

-- 3) Envia a fila de notificações externas (e-mail/WhatsApp/SMS) a cada 5 min
--    chamando a Edge Function send-notifications.
select cron.schedule('jhen-send-notifications', '*/5 * * * *', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body    := '{}'::jsonb
  );
$$);

-- Conferir:   select * from cron.job;
-- Remover:    select cron.unschedule('jhen-reminders');
