-- =============================================================================
--  seed_cleanup.sql — remove TODOS os dados de teste criados pelo seed.sql
--  Execute antes de colocar o sistema em produção.
-- =============================================================================
begin;
  delete from public.reviews        where is_test_data;
  delete from public.payments       where is_test_data or appointment_id in (select id from public.appointments where is_test_data);
  delete from public.notifications  where appointment_id in (select id from public.appointments where is_test_data);
  -- agendamentos criados durante os testes com usuários de teste também são removidos
  delete from public.payments       where client_id in (select id from public.profiles where is_test_data);
  delete from public.appointments   where is_test_data
                                       or client_id in (select id from public.profiles where is_test_data)
                                       or employee_id in (select id from public.employees where is_test_data);
  delete from public.employees      where is_test_data;
  delete from public.services       where is_test_data
                                       and id not in (select service_id from public.appointments);
  delete from auth.users            where id in (select id from public.profiles where is_test_data);
commit;
