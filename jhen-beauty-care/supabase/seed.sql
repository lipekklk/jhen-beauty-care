-- =============================================================================
--  seed.sql — DADOS DE TESTE / DEMONSTRAÇÃO
--  ⚠️  Tudo aqui é FICTÍCIO e marcado com is_test_data = true, nomes com "(teste)"
--      e e-mails @example.com. Execute DEPOIS do schema.sql.
--      Para remover tudo: supabase/seed_cleanup.sql
--
--  Usuários criados (senha de todos: Teste@1234)
--    Funcionárias: ana.teste@example.com · bianca.teste@example.com
--    Clientes:     carla.teste@example.com · daniela.teste@example.com · elaine.teste@example.com
--  O administrador NÃO é criado aqui (veja README → "Criar o primeiro administrador").
-- =============================================================================

-- Helper temporário: cria usuário no Supabase Auth com senha (bcrypt) e identidade de e-mail
create or replace function pg_temp.seed_user(p_email text, p_name text, p_phone text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where email = p_email;
  if v_id is not null then return v_id; end if;
  v_id := gen_random_uuid();
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email,
    extensions.crypt('Teste@1234', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', p_name, 'phone', p_phone),
    now(), now(), '', '', '', '', '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (v_id::text, v_id, jsonb_build_object('sub', v_id::text, 'email', p_email, 'email_verified', true),
          'email', now(), now(), now());
  update public.profiles set is_test_data = true where id = v_id;
  return v_id;
end $$;

do $$
declare
  tz       text := public.app_tz();
  u_ana    uuid := pg_temp.seed_user('ana.teste@example.com',     'Ana Ribeiro (teste)',   '(11) 90000-0001');
  u_bianca uuid := pg_temp.seed_user('bianca.teste@example.com',  'Bianca Lima (teste)',   '(11) 90000-0002');
  u_carla  uuid := pg_temp.seed_user('carla.teste@example.com',   'Carla Mendes (teste)',  '(11) 90000-0003');
  u_dani   uuid := pg_temp.seed_user('daniela.teste@example.com', 'Daniela Rocha (teste)', '(11) 90000-0004');
  u_elaine uuid := pg_temp.seed_user('elaine.teste@example.com',  'Elaine Souza (teste)',  '(11) 90000-0005');
  e_ana uuid; e_bianca uuid;
  s_design uuid; s_henna uuid; s_lamination uuid; s_micro uuid; s_manut uuid;
  d date; a_id uuid; i int;
  open_days date[] := '{}';
begin
  -- Funcionárias -----------------------------------------------------------
  update public.profiles set role = 'employee' where id in (u_ana, u_bianca);
  insert into public.employees (profile_id, display_name, title, bio, is_test_data) values
    (u_ana,    'Ana (teste)',    'Designer de sobrancelhas sênior', 'Profissional fictícia para testes.', true),
    (u_bianca, 'Bianca (teste)', 'Designer de sobrancelhas',        'Profissional fictícia para testes.', true)
  on conflict (profile_id) do nothing;
  select id into e_ana    from public.employees where profile_id = u_ana;
  select id into e_bianca from public.employees where profile_id = u_bianca;

  -- Procedimentos ------------------------------------------------------------
  insert into public.services (name, description, price, duration_minutes, payment_mode, deposit_amount, allow_on_site, sort_order, is_test_data) values
    ('Design de Sobrancelhas', 'Mapeamento facial e design personalizado com pinça e linha, respeitando o formato natural do seu rosto.', 40, 40, 'full', null, true, 1, true),
    ('Design + Henna', 'Design personalizado com aplicação de henna para preencher falhas e realçar o olhar por mais tempo.', 60, 60, 'full', null, true, 2, true),
    ('Brow Lamination', 'Alinhamento e fixação dos fios para um efeito penteado, volumoso e natural que dura semanas.', 120, 90, 'deposit', 40, false, 3, true),
    ('Micropigmentação', 'Técnica fio a fio para sobrancelhas definidas e naturais. Inclui avaliação prévia.', 450, 120, 'deposit', 100, false, 4, true),
    ('Manutenção', 'Manutenção do design para quem já é cliente, mantendo o formato desenhado.', 30, 30, 'on_site', null, true, 5, true);

  select id into s_design     from public.services where name = 'Design de Sobrancelhas' and is_test_data limit 1;
  select id into s_henna      from public.services where name = 'Design + Henna'          and is_test_data limit 1;
  select id into s_lamination from public.services where name = 'Brow Lamination'         and is_test_data limit 1;
  select id into s_micro      from public.services where name = 'Micropigmentação'        and is_test_data limit 1;
  select id into s_manut      from public.services where name = 'Manutenção'              and is_test_data limit 1;

  insert into public.employee_services (employee_id, service_id) values
    (e_ana, s_design), (e_ana, s_henna), (e_ana, s_lamination), (e_ana, s_micro), (e_ana, s_manut),
    (e_bianca, s_design), (e_bianca, s_henna), (e_bianca, s_manut)
  on conflict do nothing;

  -- Bianca não trabalha às terças; aos sábados só até 13h
  insert into public.employee_hours (employee_id, weekday, is_working, start_time, end_time) values
    (e_bianca, 2, false, null, null),
    (e_bianca, 6, true, '09:00', '13:00')
  on conflict (employee_id, weekday) do nothing;

  -- Feriados nacionais (exemplos) -------------------------------------------
  insert into public.holidays (date, name) values
    ('2026-11-02', 'Finados'), ('2026-11-15', 'Proclamação da República'),
    ('2026-11-20', 'Dia da Consciência Negra'), ('2026-12-25', 'Natal'), ('2027-01-01', 'Confraternização Universal')
  on conflict (date) do nothing;

  -- Contato de exemplo (edite em Admin → Configurações)
  update public.settings set
    whatsapp = '5511900000000', instagram = 'jhenbeautycare', email = 'contato@example.com',
    phone = '(11) 90000-0000', address = 'Endereço de exemplo, 123 — Sua cidade/UF',
    maps_url = 'https://www.google.com/maps'
  where id = 1;

  -- Agendamentos de exemplo --------------------------------------------------
  -- Histórico: 6 atendimentos concluídos nas últimas semanas (com pagamento aprovado)
  for i in 1..6 loop
    d := (now() at time zone tz)::date - (i * 4);
    insert into public.appointments (client_id, employee_id, service_id, starts_at, ends_at, status, price, is_test_data)
    values (case i % 3 when 0 then u_carla when 1 then u_dani else u_elaine end,
            case i % 2 when 0 then e_ana else e_bianca end,
            case i % 3 when 0 then s_design when 1 then s_henna else s_design end,
            (d + time '10:00') at time zone tz, (d + time '10:00' + interval '60 min') at time zone tz,
            'completed', case i % 3 when 1 then 60 else 40 end, true)
    returning id into a_id;
    insert into public.payments (appointment_id, client_id, amount, kind, method, status, provider, provider_payment_id, paid_at, is_test_data)
    select a_id, client_id, price, 'full', case i % 2 when 0 then 'pix' else 'card' end::public.payment_method,
           'approved', 'sandbox', 'sbx_seed_' || i, starts_at - interval '2 days', true
      from public.appointments where id = a_id;
  end loop;

  -- 1 cancelamento e 1 não comparecimento (para os indicadores)
  d := (now() at time zone tz)::date - 9;
  insert into public.appointments (client_id, employee_id, service_id, starts_at, ends_at, status, price, is_test_data, cancelled_at, cancel_reason)
  values (u_elaine, e_ana, s_lamination, (d + time '15:00') at time zone tz, (d + time '16:30') at time zone tz,
          'cancelled', 120, true, now() - interval '10 days', 'Exemplo de cancelamento (teste)');
  insert into public.appointments (client_id, employee_id, service_id, starts_at, ends_at, status, price, is_test_data)
  values (u_dani, e_bianca, s_design, (d + time '17:00') at time zone tz, (d + time '17:40') at time zone tz,
          'no_show', 40, true);

  -- Próximos atendimentos: nos próximos dias úteis abertos
  select array_agg(x::date order by x) into open_days
    from generate_series((now() at time zone tz)::date + 1, (now() at time zone tz)::date + 14, interval '1 day') x
    join public.business_hours bh on bh.weekday = extract(dow from x) and bh.is_open
   where not exists (select 1 from public.holidays h where h.date = x::date);

  if array_length(open_days, 1) >= 3 then
    insert into public.appointments (client_id, employee_id, service_id, starts_at, ends_at, status, price, is_test_data) values
      (u_carla,  e_ana,    s_lamination, (open_days[1] + time '14:00') at time zone tz, (open_days[1] + time '15:30') at time zone tz, 'scheduled', 120, true),
      (u_dani,   e_ana,    s_design,     (open_days[1] + time '16:00') at time zone tz, (open_days[1] + time '16:40') at time zone tz, 'confirmed', 40,  true),
      (u_elaine, e_ana,    s_henna,      (open_days[2] + time '10:00') at time zone tz, (open_days[2] + time '11:00') at time zone tz, 'scheduled', 60,  true),
      (u_carla,  e_ana,    s_design,     (open_days[3] + time '09:00') at time zone tz, (open_days[3] + time '09:40') at time zone tz, 'scheduled', 40,  true);
    insert into public.payments (appointment_id, client_id, amount, kind, method, status, provider, provider_payment_id, paid_at, is_test_data)
    select a.id, a.client_id,
           case when a.service_id = s_lamination then 40 else a.price end,
           case when a.service_id = s_lamination then 'deposit' else 'full' end::public.payment_mode,
           'pix', 'approved', 'sandbox', 'sbx_seed_f_' || left(a.id::text, 8), now() - interval '1 day', true
      from public.appointments a
     where a.is_test_data and a.status in ('scheduled', 'confirmed');
  end if;

  -- Depoimentos de exemplo (aparecem no site com o selo "exemplo") -------------
  insert into public.reviews (client_id, appointment_id, rating, comment, is_published, is_test_data)
  select a.client_id, a.id, 5,
         case row_number() over () when 1 then '(Depoimento de teste) Atendimento cuidadoso e resultado super natural.'
                                   when 2 then '(Depoimento de teste) Ambiente acolhedor e pontualidade impecável.'
                                   else        '(Depoimento de teste) Amei o design, valorizou muito o meu olhar.' end,
         true, true
    from public.appointments a
   where a.is_test_data and a.status = 'completed'
   limit 3
  on conflict (appointment_id) do nothing;
end $$;
