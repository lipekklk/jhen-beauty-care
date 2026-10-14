-- =============================================================================
--  JHEN beauty care — Plataforma de agendamento
--  schema.sql  ·  Execute no SQL Editor do Supabase (uma única vez, projeto novo)
--
--  Conteúdo:
--    1. Extensões e tipos
--    2. Tabelas (com constraints, FKs e índices)
--    3. Funções utilitárias e triggers (updated_at, perfil automático, proteção de colunas)
--    4. Regras de negócio (disponibilidade, agendamento, cancelamento, remarcação, status)
--    5. Pagamentos e notificações (triggers + funções para Edge Functions)
--    6. Relatórios do admin
--    7. Row Level Security (RLS) + policies
--    8. Grants
--    9. Storage (bucket de mídia)
--
--  Convenções:
--    - Erros de negócio são lançados com mensagens-código (ex.: 'SLOT_TAKEN'),
--      traduzidas para português no front-end (js/utils.js -> ERROR_MESSAGES).
--    - Horários de funcionamento são "hora local" no fuso definido em settings.timezone.
--      Agendamentos são armazenados como timestamptz (UTC).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. EXTENSÕES E TIPOS
-- -----------------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;  -- exclusion constraint com uuid
create extension if not exists pgcrypto  with schema extensions;   -- gen_random_uuid / crypt (seed)

do $$ begin
  create type public.user_role as enum ('client', 'employee', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.appointment_status as enum (
    'pending_payment', -- reservado aguardando pagamento online (expira em settings.payment_hold_minutes)
    'scheduled',       -- Agendado
    'confirmed',       -- Confirmado
    'arrived',         -- Cliente chegou
    'in_progress',     -- Em atendimento
    'completed',       -- Concluído
    'cancelled',       -- Cancelado
    'no_show'          -- Não compareceu
  );
exception when duplicate_object then null; end $$;

do $$ begin
  -- online = Checkout Pro do Mercado Pago (a cliente escolhe cartão, Pix etc. dentro do checkout)
  -- pix / card = valores antigos, mantidos só para o histórico
  create type public.payment_method as enum ('pix', 'card', 'on_site', 'online');
exception when duplicate_object then null; end $$;

do $$ begin
  -- full = valor integral online · deposit = sinal online · on_site = pagamento presencial
  create type public.payment_mode as enum ('full', 'deposit', 'on_site');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_status as enum
    ('pending', 'approved', 'rejected', 'cancelled', 'refund_pending', 'refunded',
     'in_process', 'charged_back', 'in_mediation');
exception when duplicate_object then null; end $$;

-- Bancos criados com versões anteriores: acrescenta os valores novos.
alter type public.payment_method add value if not exists 'online';
alter type public.payment_status add value if not exists 'in_process';    -- em análise / autorizado
alter type public.payment_status add value if not exists 'charged_back';  -- contestação (chargeback)
alter type public.payment_status add value if not exists 'in_mediation';  -- disputa em andamento
-- Valores novos de enum só podem ser usados depois de confirmados (commit).
-- No SQL Editor do Supabase o script roda numa transação implícita; o COMMIT abaixo a encerra.
commit;

do $$ begin
  create type public.block_type as enum ('day_off', 'vacation', 'block');  -- folga, férias, bloqueio
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_channel as enum ('in_app', 'email', 'whatsapp', 'sms');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_status as enum ('pending', 'sent', 'failed', 'read');
exception when duplicate_object then null; end $$;


-- -----------------------------------------------------------------------------
-- 2. TABELAS
-- -----------------------------------------------------------------------------

-- Configurações gerais do negócio (linha única, id = 1). Não contém segredos:
-- chaves de gateway ficam nos "Secrets" das Edge Functions.
create table if not exists public.settings (
  id                          smallint primary key default 1 check (id = 1),
  business_name               text not null default 'JHEN beauty care',
  timezone                    text not null default 'America/Sao_Paulo',
  phone                       text,
  whatsapp                    text,          -- somente dígitos com DDI (55) + DDD, ex.: 5511960978246
  instagram                   text,          -- usuário sem @
  email                       text,
  address                     text,
  maps_url                    text,
  -- agenda
  slot_interval_minutes       int  not null default 30  check (slot_interval_minutes between 5 and 120),
  min_advance_minutes         int  not null default 120 check (min_advance_minutes >= 0),
  max_advance_days            int  not null default 60  check (max_advance_days between 1 and 365),
  -- política de cancelamento / remarcação
  cancellation_min_hours      int  not null default 24  check (cancellation_min_hours >= 0),
  allow_late_cancellation     boolean not null default true,  -- se false, bloqueia cancelamento tardio
  late_cancellation_fee_percent numeric(5,2) not null default 0 check (late_cancellation_fee_percent between 0 and 100),
  forfeit_deposit_on_late_cancel boolean not null default true, -- perda do sinal
  refund_on_time_cancel       boolean not null default true,  -- reembolso integral dentro do prazo
  reschedule_min_hours        int  not null default 12  check (reschedule_min_hours >= 0),
  max_reschedules             int  not null default 2   check (max_reschedules >= 0),
  cancellation_policy_text    text not null default 'Cancelamentos e remarcações gratuitos até 24 horas antes do atendimento.',
  -- pagamentos
  on_site_payment_enabled     boolean not null default true,
  payment_hold_minutes        int  not null default 15  check (payment_hold_minutes between 5 and 120),
  -- disabled = só pagamento no estúdio · mercadopago = Checkout Pro (credenciais nos Secrets das Edge Functions)
  payment_provider            text not null default 'disabled' check (payment_provider in ('disabled', 'mercadopago')),
  -- canais externos que devem receber cópia das notificações (outbox)
  notify_channels             public.notification_channel[] not null default '{}',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Perfil de todo usuário autenticado (cliente, funcionário ou admin).
-- Clientes = perfis com role 'client' (evita duplicar dados numa tabela "clients").
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  role          public.user_role not null default 'client',
  full_name     text not null default '' check (char_length(full_name) <= 120),
  email         text,                       -- espelho de auth.users.email (somente leitura p/ usuário)
  phone         text check (phone is null or phone ~ '^[0-9+() -]{8,20}$'),
  birth_date    date check (birth_date is null or birth_date > '1900-01-01'),
  avatar_url    text,
  is_blocked    boolean not null default false,
  is_test_data  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_name_idx on public.profiles (lower(full_name));

-- Profissionais. display_name/bio/foto são informações PÚBLICAS (aparecem no agendamento).
create table if not exists public.employees (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null unique references public.profiles (id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 2 and 80),
  title         text not null default 'Designer de sobrancelhas',   -- cargo
  bio           text,
  photo_url     text,
  is_active     boolean not null default true,
  is_test_data  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Procedimentos
create table if not exists public.services (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(name) between 2 and 80),
  description      text not null default '',
  price            numeric(10,2) not null check (price >= 0),
  duration_minutes int not null check (duration_minutes between 5 and 600),
  image_url        text,
  is_active        boolean not null default true,
  payment_mode     public.payment_mode not null default 'full',
  deposit_amount   numeric(10,2) check (deposit_amount is null or deposit_amount >= 0),
  allow_on_site    boolean not null default true,  -- cliente pode optar por pagar no local
  sort_order       int not null default 0,
  is_test_data     boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint deposit_required check (payment_mode <> 'deposit' or (deposit_amount is not null and deposit_amount > 0)),
  constraint deposit_lte_price check (deposit_amount is null or deposit_amount <= price)
);
create index if not exists services_active_idx on public.services (is_active, sort_order);

-- Quais profissionais realizam quais procedimentos (N:N)
create table if not exists public.employee_services (
  employee_id uuid not null references public.employees (id) on delete cascade,
  service_id  uuid not null references public.services  (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (employee_id, service_id)
);
create index if not exists employee_services_service_idx on public.employee_services (service_id);

-- Horário de funcionamento do estabelecimento (0 = domingo … 6 = sábado)
create table if not exists public.business_hours (
  weekday     smallint primary key check (weekday between 0 and 6),
  is_open     boolean not null default false,
  open_time   time,
  close_time  time,
  break_start time,
  break_end   time,
  updated_at  timestamptz not null default now(),
  constraint bh_times check (not is_open or (open_time is not null and close_time is not null and close_time > open_time)),
  constraint bh_break check ((break_start is null) = (break_end is null) and (break_start is null or break_end > break_start))
);

-- Horários especiais (sobrepõem business_hours numa data específica)
create table if not exists public.special_hours (
  date        date primary key,
  is_open     boolean not null default true,
  open_time   time,
  close_time  time,
  break_start time,
  break_end   time,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint sh_times check (not is_open or (open_time is not null and close_time is not null and close_time > open_time)),
  constraint sh_break check ((break_start is null) = (break_end is null) and (break_start is null or break_end > break_start))
);

-- Jornada de cada profissional. Sem linha para o dia = segue o horário do estabelecimento.
create table if not exists public.employee_hours (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  is_working  boolean not null default true,
  start_time  time,
  end_time    time,
  break_start time,
  break_end   time,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (employee_id, weekday),
  constraint eh_times check (not is_working or start_time is null or (end_time is not null and end_time > start_time)),
  constraint eh_break check ((break_start is null) = (break_end is null) and (break_start is null or break_end > break_start))
);

-- Feriados (fechado o dia todo)
create table if not exists public.holidays (
  id         uuid primary key default gen_random_uuid(),
  date       date not null unique,
  name       text not null,
  created_at timestamptz not null default now()
);

-- Folgas, férias e bloqueios de dias inteiros (employee_id nulo = todos)
create table if not exists public.blocked_dates (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees (id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  type        public.block_type not null default 'block',
  reason      text,
  created_at  timestamptz not null default now(),
  constraint bd_range check (end_date >= start_date)
);
create index if not exists blocked_dates_range_idx on public.blocked_dates (start_date, end_date);

-- Bloqueio de faixas de horário em uma data (employee_id nulo = todos)
create table if not exists public.blocked_times (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees (id) on delete cascade,
  date        date not null,
  start_time  time not null,
  end_time    time not null,
  reason      text,
  created_at  timestamptz not null default now(),
  constraint bt_range check (end_time > start_time)
);
create index if not exists blocked_times_date_idx on public.blocked_times (date);

-- Agendamentos
create table if not exists public.appointments (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.profiles (id) on delete restrict,
  employee_id        uuid not null references public.employees (id) on delete restrict,
  service_id         uuid not null references public.services (id) on delete restrict,
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  status             public.appointment_status not null default 'scheduled',
  price              numeric(10,2) not null check (price >= 0),  -- preço praticado (histórico)
  notes              text check (notes is null or char_length(notes) <= 500),
  reschedule_count   int not null default 0,
  cancelled_at       timestamptz,
  cancelled_by       uuid references public.profiles (id) on delete set null,
  cancel_reason      text,
  cancellation_fee   numeric(10,2) not null default 0,
  is_test_data       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint appt_range check (ends_at > starts_at),
  -- >>> GARANTIA ANTI-CONFLITO NO BANCO: um profissional não pode ter dois
  -- atendimentos ativos que se sobreponham. Resolve condições de corrida.
  constraint appointments_no_overlap exclude using gist (
    employee_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status not in ('cancelled', 'no_show'))
);
create index if not exists appointments_client_idx   on public.appointments (client_id, starts_at desc);
create index if not exists appointments_employee_idx on public.appointments (employee_id, starts_at);
create index if not exists appointments_starts_idx   on public.appointments (starts_at);
create index if not exists appointments_status_idx   on public.appointments (status);

-- Pagamentos — NUNCA armazena número de cartão, CVV ou dados sensíveis.
create table if not exists public.payments (
  id                      uuid primary key default gen_random_uuid(),
  appointment_id          uuid not null references public.appointments (id) on delete cascade,
  client_id               uuid not null references public.profiles (id) on delete restrict,
  amount                  numeric(10,2) not null check (amount >= 0),
  kind                    public.payment_mode not null,         -- integral, sinal ou presencial
  method                  public.payment_method not null,
  status                  public.payment_status not null default 'pending',
  provider                text not null default 'mercadopago',  -- mercadopago | manual (no estúdio)
  provider_payment_id     text,                                 -- ID do pagamento no Mercado Pago
  provider_transaction_id text,                                 -- ID de transação / autorização
  refund_amount           numeric(10,2) not null default 0,
  paid_at                 timestamptz,                          -- data de aprovação
  is_test_data            boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists payments_appointment_idx on public.payments (appointment_id);
create index if not exists payments_client_idx      on public.payments (client_id, created_at desc);
create index if not exists payments_status_idx      on public.payments (status, created_at);
create unique index if not exists payments_provider_uidx
  on public.payments (provider, provider_payment_id) where provider_payment_id is not null;

-- Notificações (in-app + outbox para WhatsApp/e-mail/SMS)
create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete cascade,
  type           text not null check (type in (
                   'appointment_confirmed', 'appointment_pending_payment', 'payment_approved', 'payment_failed',
                   'appointment_reminder', 'appointment_cancelled', 'appointment_rescheduled',
                   'change_request', 'refund_required', 'payment_refunded', 'payment_dispute', 'generic')),
  channel        public.notification_channel not null default 'in_app',
  title          text not null,
  message        text not null,
  status         public.notification_status not null default 'pending',
  read_at        timestamptz,
  sent_at        timestamptz,
  error          text,
  created_at     timestamptz not null default now()
);
create index if not exists notifications_user_idx   on public.notifications (user_id, created_at desc);
create index if not exists notifications_outbox_idx on public.notifications (channel, status) where channel <> 'in_app';
create unique index if not exists notifications_reminder_uidx
  on public.notifications (appointment_id, channel) where type = 'appointment_reminder';

-- ---- Pagamentos online (Mercado Pago): colunas adicionais -------------------------
-- Guardamos SOMENTE identificadores e status do gateway. Nunca número de cartão, CVV,
-- dados bancários ou tokens. card_last_four é o dado mascarado devolvido pelo próprio MP.
alter table public.payments alter column provider set default 'mercadopago';
alter table public.payments add column if not exists provider_preference_id text;          -- preferência do Checkout Pro
alter table public.payments add column if not exists checkout_url           text;          -- link do checkout (público, sem segredo)
alter table public.payments add column if not exists checkout_expires_at    timestamptz;   -- fim da reserva do horário
alter table public.payments add column if not exists provider_status        text;          -- status exato do MP (approved, in_process...)
alter table public.payments add column if not exists provider_status_detail text;          -- motivo (accredited, cc_rejected_...)
alter table public.payments add column if not exists payment_type           text;          -- credit_card, debit_card, bank_transfer (Pix)...
alter table public.payments add column if not exists payment_method_id      text;          -- visa, master, pix...
alter table public.payments add column if not exists card_last_four         text;
alter table public.payments add column if not exists currency               text not null default 'BRL';
alter table public.payments add column if not exists live_mode              boolean;
alter table public.payments add column if not exists provider_updated_at    timestamptz;   -- date_last_updated do MP (ordem dos eventos)
alter table public.payments add column if not exists refund_requested_at    timestamptz;
alter table public.payments add column if not exists refunded_at            timestamptz;
alter table public.payments add column if not exists charged_back_at        timestamptz;
alter table public.payments add column if not exists last_synced_at         timestamptz;
do $$ begin
  alter table public.payments add constraint payments_card_last_four_chk check (card_last_four is null or card_last_four ~ '^[0-9]{4}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.payments add constraint payments_currency_chk check (currency ~ '^[A-Z]{3}$');
exception when duplicate_object then null; end $$;
create index if not exists payments_preference_idx on public.payments (provider_preference_id) where provider_preference_id is not null;

-- settings.payment_provider: o simulador ('sandbox') foi removido por segurança.
alter table public.settings drop constraint if exists settings_payment_provider_check;
update public.settings set payment_provider = 'disabled' where payment_provider not in ('disabled', 'mercadopago');
alter table public.settings add constraint settings_payment_provider_check check (payment_provider in ('disabled', 'mercadopago'));
alter table public.settings alter column payment_provider set default 'disabled';

-- notifications.type: tipos novos (estorno e contestação)
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'appointment_confirmed', 'appointment_pending_payment', 'payment_approved', 'payment_failed',
  'appointment_reminder', 'appointment_cancelled', 'appointment_rescheduled',
  'change_request', 'refund_required', 'payment_refunded', 'payment_dispute', 'generic'));

-- Registro de eventos de pagamento (webhooks, sincronizações, estornos).
-- Serve para idempotência (x-request-id) e auditoria. Sem dados pessoais ou de cartão.
create table if not exists public.payment_events (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null default 'mercadopago',
  source              text not null check (source in ('webhook', 'sync', 'refund', 'checkout')),
  request_id          text,
  notification_id     text,
  action              text,
  provider_payment_id text,
  payment_id          uuid references public.payments (id) on delete set null,
  outcome             text not null,
  detail              text,
  created_at          timestamptz not null default now()
);
create unique index if not exists payment_events_request_uidx
  on public.payment_events (provider, request_id) where source = 'webhook' and request_id is not null;
create index if not exists payment_events_payment_idx on public.payment_events (payment_id, created_at desc);
create index if not exists payment_events_created_idx on public.payment_events (created_at desc);

-- Limite de requisições por usuário/IP para as Edge Functions de pagamento.
create table if not exists public.api_rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (bucket, window_start)
);

-- Avaliações / depoimentos (só aparecem no site após aprovação do admin)
create table if not exists public.reviews (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.profiles (id) on delete cascade,
  appointment_id uuid unique references public.appointments (id) on delete set null,
  rating         smallint not null check (rating between 1 and 5),
  comment        text not null check (char_length(comment) between 3 and 600),
  is_published   boolean not null default false,
  is_test_data   boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists reviews_published_idx on public.reviews (is_published, created_at desc);

-- Galeria de resultados (fotos enviadas pelo admin para o Storage)
create table if not exists public.gallery_items (
  id          uuid primary key default gen_random_uuid(),
  image_url   text not null,
  caption     text,
  alt_text    text not null default 'Resultado de procedimento JHEN beauty care',
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- 3. FUNÇÕES UTILITÁRIAS E TRIGGERS
-- -----------------------------------------------------------------------------

-- updated_at automático
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['settings','profiles','employees','services','business_hours','special_hours',
                           'employee_hours','appointments','payments','reviews','gallery_items']
  loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- Papel do usuário logado (security definer evita recursão de RLS em profiles)
create or replace function public.auth_role()
returns public.user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

-- id do registro de funcionário do usuário logado (admin também pode ser profissional)
create or replace function public.current_employee_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.employees where profile_id = auth.uid() and is_active
$$;

create or replace function public.app_tz()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select timezone from public.settings where id = 1), 'America/Sao_Paulo')
$$;

-- Cria o perfil automaticamente no cadastro. NUNCA confia em role vinda do cliente:
-- todo novo usuário nasce como 'client'.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, phone)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    new.email,
    nullif(regexp_replace(coalesce(new.raw_user_meta_data ->> 'phone', ''), '[^0-9+() -]', '', 'g'), '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Garante que o usuário logado tenha perfil. Cobre contas criadas antes do trigger existir
-- ou cujo perfil foi apagado manualmente (ex.: limpeza pelo Table Editor). Sem isso o login
-- funciona no Auth, mas o site não sabe o papel da pessoa e bloqueia o acesso.
create or replace function public.ensure_profile()
returns public.profiles language plpgsql volatile security definer set search_path = public as $$
declare v public.profiles;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  insert into public.profiles (id, full_name, email, phone)
  select u.id,
         left(coalesce(u.raw_user_meta_data ->> 'full_name', ''), 120),
         u.email,
         nullif(regexp_replace(coalesce(u.raw_user_meta_data ->> 'phone', ''), '[^0-9+() -]', '', 'g'), '')
    from auth.users u where u.id = auth.uid()
  on conflict (id) do nothing;
  select * into v from public.profiles where id = auth.uid();
  return v;
end $$;

-- Backfill (idempotente): cria perfil para qualquer conta do Auth que esteja sem.
insert into public.profiles (id, full_name, email, phone)
select u.id,
       left(coalesce(u.raw_user_meta_data ->> 'full_name', ''), 120),
       u.email,
       nullif(regexp_replace(coalesce(u.raw_user_meta_data ->> 'phone', ''), '[^0-9+() -]', '', 'g'), '')
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

-- Mantém profiles.email sincronizado quando o usuário confirma a troca de e-mail
create or replace function public.handle_user_email_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- Impede que um usuário comum altere o próprio papel, bloqueio ou e-mail
create or replace function public.protect_profile_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- chamadas internas (service_role / SQL editor) não têm auth.uid()
  if auth.uid() is null then return new; end if;
  if not public.is_admin() then
    new.role         := old.role;
    new.is_blocked   := old.is_blocked;
    new.is_test_data := old.is_test_data;
    new.email        := old.email;
  elsif new.id = auth.uid() and new.role <> 'admin' then
    raise exception 'CANNOT_DEMOTE_SELF';
  end if;
  return new;
end $$;

drop trigger if exists trg_profiles_protect on public.profiles;
create trigger trg_profiles_protect
  before update on public.profiles
  for each row execute function public.protect_profile_columns();


-- -----------------------------------------------------------------------------
-- 4. REGRAS DE NEGÓCIO
-- -----------------------------------------------------------------------------

-- Libera reservas cujo pagamento online não foi concluído no prazo.
create or replace function public.expire_pending_appointments()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_hold int;
  v_count int;
begin
  select payment_hold_minutes into v_hold from public.settings where id = 1;
  with expired as (
    update public.appointments
       set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Pagamento não concluído no prazo'
     where status = 'pending_payment'
       and created_at < now() - make_interval(mins => coalesce(v_hold, 15))
    returning id
  ), pays as (
    update public.payments p set status = 'cancelled'
      from expired e where p.appointment_id = e.id and p.status in ('pending', 'in_process', 'rejected')
    returning p.id
  )
  select count(*) into v_count from expired;
  return v_count;
end $$;

-- Horários disponíveis para um procedimento numa data.
--   p_employee_id nulo  => considera todos os profissionais habilitados
--   p_ignore_appointment => ignora um agendamento (usado na remarcação)
-- Considera: duração, horário do estabelecimento, horários especiais, intervalo,
-- jornada e intervalo do profissional, feriados, folgas/férias/bloqueios de dia,
-- bloqueios de horário, agendamentos existentes, antecedência mínima e máxima.
create or replace function public.get_available_slots(
  p_service_id uuid,
  p_date date,
  p_employee_id uuid default null,
  p_ignore_appointment uuid default null
)
returns table (slot_start timestamptz, slot_end timestamptz, employee_id uuid, employee_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  s          record;
  v_duration int;
  v_today    date;
  v_dow      smallint := extract(dow from p_date);
  v_open     time; v_close time; v_bstart time; v_bend time;
  v_found    boolean := false;
  emp        record;
  eh         record;
  v_from     time; v_to time;
begin
  select * into s from public.settings where id = 1;
  select duration_minutes into v_duration from public.services where id = p_service_id and is_active;
  if v_duration is null then return; end if;

  v_today := (now() at time zone s.timezone)::date;
  if p_date < v_today or p_date > v_today + s.max_advance_days then return; end if;
  if exists (select 1 from public.holidays h where h.date = p_date) then return; end if;

  -- janela do dia: horário especial > horário padrão
  select sh.is_open, sh.open_time, sh.close_time, sh.break_start, sh.break_end
    into v_found, v_open, v_close, v_bstart, v_bend
    from public.special_hours sh where sh.date = p_date;
  if not found then
    select bh.is_open, bh.open_time, bh.close_time, bh.break_start, bh.break_end
      into v_found, v_open, v_close, v_bstart, v_bend
      from public.business_hours bh where bh.weekday = v_dow;
  end if;
  if not coalesce(v_found, false) then return; end if;

  for emp in
    select e.id, e.display_name
      from public.employees e
      join public.employee_services es on es.employee_id = e.id and es.service_id = p_service_id
     where e.is_active and (p_employee_id is null or e.id = p_employee_id)
  loop
    -- folga / férias / bloqueio do dia inteiro
    continue when exists (
      select 1 from public.blocked_dates bd
       where (bd.employee_id is null or bd.employee_id = emp.id)
         and p_date between bd.start_date and bd.end_date);

    select * into eh from public.employee_hours x where x.employee_id = emp.id and x.weekday = v_dow;
    if found and not eh.is_working then continue; end if;

    v_from := greatest(v_open,  coalesce(eh.start_time, v_open));
    v_to   := least   (v_close, coalesce(eh.end_time,  v_close));
    continue when v_to <= v_from;

    return query
    with slots as (
      select ts, ts + make_interval(mins => v_duration) as te
        from generate_series(
               (p_date + v_from) at time zone s.timezone,
               ((p_date + v_to) at time zone s.timezone) - make_interval(mins => v_duration),
               make_interval(mins => s.slot_interval_minutes)) ts
    )
    select sl.ts, sl.te, emp.id, emp.display_name
      from slots sl
     where sl.ts >= now() + make_interval(mins => s.min_advance_minutes)
       -- intervalo do estabelecimento
       and (v_bstart is null or not tstzrange(sl.ts, sl.te, '[)') &&
            tstzrange((p_date + v_bstart) at time zone s.timezone, (p_date + v_bend) at time zone s.timezone, '[)'))
       -- intervalo do profissional
       and (eh.break_start is null or not tstzrange(sl.ts, sl.te, '[)') &&
            tstzrange((p_date + eh.break_start) at time zone s.timezone, (p_date + eh.break_end) at time zone s.timezone, '[)'))
       -- bloqueios de horário
       and not exists (
             select 1 from public.blocked_times bt
              where bt.date = p_date and (bt.employee_id is null or bt.employee_id = emp.id)
                and tstzrange(sl.ts, sl.te, '[)') &&
                    tstzrange((p_date + bt.start_time) at time zone s.timezone,
                              (p_date + bt.end_time)   at time zone s.timezone, '[)'))
       -- agendamentos existentes (reservas aguardando pagamento só contam dentro do prazo)
       and not exists (
             select 1 from public.appointments a
              where a.employee_id = emp.id
                and a.id is distinct from p_ignore_appointment
                and a.status not in ('cancelled', 'no_show')
                and (a.status <> 'pending_payment'
                     or a.created_at >= now() - make_interval(mins => s.payment_hold_minutes))
                and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(sl.ts, sl.te, '[)'));
  end loop;
end $$;

-- Resumo do mês para o calendário: quantos horários livres em cada dia.
create or replace function public.get_month_availability(
  p_service_id uuid,
  p_month date,              -- qualquer dia do mês desejado
  p_employee_id uuid default null
)
returns table (day date, available_slots int)
language sql stable security definer set search_path = public as $$
  select d::date,
         (select count(distinct g.slot_start)::int
            from public.get_available_slots(p_service_id, d::date, p_employee_id) g)
    from generate_series(date_trunc('month', p_month)::date,
                         (date_trunc('month', p_month) + interval '1 month - 1 day')::date,
                         interval '1 day') d
$$;

-- Cria um agendamento com TODAS as validações no servidor.
-- Retorna JSON com ids, status e valor a pagar online.
create or replace function public.book_appointment(
  p_service_id     uuid,
  p_starts_at      timestamptz,
  p_employee_id    uuid default null,
  p_payment_method public.payment_method default 'online',
  p_notes          text default null,
  p_client_id      uuid default null    -- somente admin pode agendar para outra pessoa
)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid       uuid := auth.uid();
  v_client    uuid;
  v_profile   public.profiles;
  v_service   public.services;
  s           public.settings;
  v_emp       uuid;
  v_date      date;
  v_method    public.payment_method := p_payment_method;
  v_kind      public.payment_mode;
  v_amount    numeric(10,2);
  v_status    public.appointment_status;
  v_appt_id   uuid;
  v_pay_id    uuid;
  v_ends      timestamptz;
begin
  -- 1. autenticado
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;

  v_client := case when p_client_id is not null and public.is_admin() then p_client_id else v_uid end;
  select * into v_profile from public.profiles where id = v_client;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  if v_profile.is_blocked then raise exception 'ACCOUNT_BLOCKED'; end if;

  -- 2. procedimento existe e está ativo
  select * into v_service from public.services where id = p_service_id and is_active;
  if not found then raise exception 'SERVICE_NOT_FOUND'; end if;

  -- 3. profissional habilitado (se escolhido)
  if p_employee_id is not null and not exists (
       select 1 from public.employee_services es join public.employees e on e.id = es.employee_id
        where es.employee_id = p_employee_id and es.service_id = p_service_id and e.is_active) then
    raise exception 'EMPLOYEE_NOT_ENABLED';
  end if;

  select * into s from public.settings where id = 1;

  -- forma de pagamento permitida
  if v_service.payment_mode = 'on_site' then
    v_method := 'on_site';
  elsif v_method in ('pix', 'card') then
    v_method := 'online';            -- compatibilidade: a escolha do meio acontece no Checkout Pro
  end if;
  if v_method = 'on_site' and v_service.payment_mode <> 'on_site'
     and not (v_service.allow_on_site and s.on_site_payment_enabled) then
    raise exception 'PAYMENT_METHOD_NOT_ALLOWED';
  end if;
  if v_method = 'online' and s.payment_provider <> 'mercadopago' then
    raise exception 'ONLINE_PAYMENT_UNAVAILABLE';
  end if;

  -- libera reservas expiradas antes de checar conflitos
  perform public.expire_pending_appointments();

  -- 4 a 7. data disponível, horário de funcionamento, bloqueios e conflitos:
  -- o horário pedido precisa estar exatamente na lista de horários livres.
  v_date := (p_starts_at at time zone s.timezone)::date;
  select g.employee_id into v_emp
    from public.get_available_slots(p_service_id, v_date, p_employee_id) g
   where g.slot_start = p_starts_at
   order by random()                -- "qualquer profissional": distribui a agenda
   limit 1;
  if v_emp is null then raise exception 'SLOT_UNAVAILABLE'; end if;

  v_ends := p_starts_at + make_interval(mins => v_service.duration_minutes);

  -- cliente não pode ter dois atendimentos sobrepostos
  if exists (select 1 from public.appointments a
              where a.client_id = v_client and a.status not in ('cancelled', 'no_show')
                and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_starts_at, v_ends, '[)')) then
    raise exception 'CLIENT_CONFLICT';
  end if;

  -- valor e tipo de cobrança
  if v_method = 'on_site' then
    v_kind := 'on_site'; v_amount := v_service.price; v_status := 'scheduled';
  elsif v_service.payment_mode = 'deposit' then
    v_kind := 'deposit'; v_amount := v_service.deposit_amount; v_status := 'pending_payment';
  else
    v_kind := 'full'; v_amount := v_service.price; v_status := 'pending_payment';
  end if;

  -- 8. cria o agendamento (a exclusion constraint impede corrida entre dois clientes)
  begin
    insert into public.appointments (client_id, employee_id, service_id, starts_at, ends_at, status, price, notes)
    values (v_client, v_emp, p_service_id, p_starts_at, v_ends, v_status, v_service.price, nullif(trim(p_notes), ''))
    returning id into v_appt_id;
  exception when exclusion_violation then
    raise exception 'SLOT_TAKEN';
  end;

  -- 9. registra o pagamento. O valor vem do banco; o status só muda pelo servidor
  --    depois da confirmação do Mercado Pago (webhook validado).
  insert into public.payments (appointment_id, client_id, amount, kind, method, status, provider, checkout_expires_at)
  values (v_appt_id, v_client, v_amount, v_kind, v_method, 'pending',
          case when v_method = 'on_site' then 'manual' else 'mercadopago' end,
          case when v_status = 'pending_payment' then now() + make_interval(mins => s.payment_hold_minutes) end)
  returning id into v_pay_id;

  -- 10. status atualizado e confirmação
  return jsonb_build_object(
    'appointment_id', v_appt_id,
    'payment_id',     v_pay_id,
    'employee_id',    v_emp,
    'status',         v_status,
    'amount',         v_amount,
    'kind',           v_kind,
    'method',         v_method,
    'provider',       case when v_method = 'on_site' then 'manual' else 'mercadopago' end,
    'expires_at',     case when v_status = 'pending_payment'
                           then now() + make_interval(mins => s.payment_hold_minutes) end
  );
end $$;

-- Prévia da política de cancelamento (usada para exibir o aviso antes de cancelar).
create or replace function public.cancellation_quote(p_appointment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  a        public.appointments;
  s        public.settings;
  v_paid   numeric(10,2);
  v_hours  numeric;
  v_late   boolean;
  v_fee    numeric(10,2) := 0;
  v_refund numeric(10,2) := 0;
  v_staff  boolean;
  v_dep    boolean;
begin
  select * into a from public.appointments where id = p_appointment_id;
  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  -- coalesce: para clientes current_employee_id() é NULL e a comparação viraria NULL,
  -- o que faria o IF abaixo ser ignorado (lógica de três valores do SQL).
  v_staff := public.is_admin() or coalesce(a.employee_id = public.current_employee_id(), false);
  if a.client_id is distinct from auth.uid() and not v_staff then raise exception 'FORBIDDEN'; end if;

  select * into s from public.settings where id = 1;
  select coalesce(sum(amount), 0) into v_paid from public.payments
   where appointment_id = a.id and status = 'approved';
  v_dep   := exists (select 1 from public.payments where appointment_id = a.id and status = 'approved' and kind = 'deposit');
  v_hours := round(extract(epoch from (a.starts_at - now())) / 3600.0, 1);
  v_late  := v_hours < s.cancellation_min_hours;

  if v_staff then
    v_refund := v_paid;                                  -- cancelamento pelo salão: devolve tudo
  elsif not v_late then
    v_refund := case when s.refund_on_time_cancel then v_paid else 0 end;
  else
    v_fee := round(a.price * s.late_cancellation_fee_percent / 100, 2);
    v_refund := case when v_dep and s.forfeit_deposit_on_late_cancel then 0
                     else greatest(v_paid - v_fee, 0) end;
  end if;

  return jsonb_build_object(
    'can_cancel',      a.status in ('pending_payment', 'scheduled', 'confirmed')
                       and (v_staff or not v_late or s.allow_late_cancellation),
    'is_late',         v_late and not v_staff,
    'hours_before',    v_hours,
    'min_hours',       s.cancellation_min_hours,
    'paid_amount',     v_paid,
    'fee_amount',      v_fee,
    'refund_amount',   v_refund,
    'forfeits_deposit', v_late and not v_staff and v_dep and s.forfeit_deposit_on_late_cancel,
    'policy_text',     s.cancellation_policy_text
  );
end $$;

create or replace function public.cancel_appointment(p_appointment_id uuid, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  a public.appointments;
  q jsonb;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into a from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  if a.status not in ('pending_payment', 'scheduled', 'confirmed') then raise exception 'INVALID_STATUS'; end if;

  q := public.cancellation_quote(p_appointment_id);   -- também valida a permissão
  if not (q ->> 'can_cancel')::boolean then raise exception 'CANCELLATION_NOT_ALLOWED'; end if;

  update public.appointments
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = nullif(trim(p_reason), ''), cancellation_fee = (q ->> 'fee_amount')::numeric
   where id = p_appointment_id;

  -- pendentes são cancelados; aprovados ficam aguardando estorno no gateway
  update public.payments set status = 'cancelled'
   where appointment_id = p_appointment_id and status in ('pending', 'in_process', 'rejected');
  if (q ->> 'refund_amount')::numeric > 0 then
    update public.payments set status = 'refund_pending', refund_amount = (q ->> 'refund_amount')::numeric
     where id = (select id from public.payments
                  where appointment_id = p_appointment_id and status = 'approved'
                  order by amount desc limit 1);
  end if;
  return q;
end $$;

create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_new_start      timestamptz,
  p_employee_id    uuid default null
)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  a        public.appointments;
  s        public.settings;
  v_staff  boolean;
  v_emp    uuid;
  v_dur    int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into a from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  v_staff := public.is_admin();
  if a.client_id is distinct from auth.uid() and not v_staff then raise exception 'FORBIDDEN'; end if;
  if a.status not in ('scheduled', 'confirmed') then raise exception 'INVALID_STATUS'; end if;

  select * into s from public.settings where id = 1;
  if not v_staff then
    if a.starts_at - now() < make_interval(hours => s.reschedule_min_hours) then
      raise exception 'RESCHEDULE_NOT_ALLOWED';
    end if;
    if a.reschedule_count >= s.max_reschedules then raise exception 'RESCHEDULE_LIMIT'; end if;
  end if;

  perform public.expire_pending_appointments();

  select g.employee_id into v_emp
    from public.get_available_slots(a.service_id, (p_new_start at time zone s.timezone)::date,
                                    coalesce(p_employee_id, a.employee_id), a.id) g
   where g.slot_start = p_new_start limit 1;
  if v_emp is null then raise exception 'SLOT_UNAVAILABLE'; end if;

  select duration_minutes into v_dur from public.services where id = a.service_id;
  begin
    update public.appointments
       set starts_at = p_new_start, ends_at = p_new_start + make_interval(mins => v_dur),
           employee_id = v_emp, reschedule_count = reschedule_count + 1,
           status = 'scheduled'
     where id = p_appointment_id;
  exception when exclusion_violation then
    raise exception 'SLOT_TAKEN';
  end;
  return jsonb_build_object('appointment_id', p_appointment_id, 'starts_at', p_new_start, 'employee_id', v_emp);
end $$;

-- Alteração de status pelo funcionário (somente os próprios) ou admin.
create or replace function public.update_appointment_status(p_appointment_id uuid, p_status public.appointment_status)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  a       public.appointments;
  v_admin boolean := public.is_admin();
  v_today date := (now() at time zone public.app_tz())::date;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into a from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  if not v_admin and a.employee_id is distinct from public.current_employee_id() then raise exception 'FORBIDDEN'; end if;

  if p_status = 'cancelled' then
    perform public.cancel_appointment(p_appointment_id, 'Cancelado pela equipe');
    return;
  end if;
  if p_status = 'pending_payment' then raise exception 'INVALID_STATUS'; end if;
  if not v_admin then
    if a.status in ('cancelled', 'completed', 'no_show', 'pending_payment') then raise exception 'INVALID_STATUS'; end if;
    if p_status in ('arrived', 'in_progress', 'completed', 'no_show')
       and (a.starts_at at time zone public.app_tz())::date > v_today then
      raise exception 'TOO_EARLY_FOR_STATUS';
    end if;
  end if;

  begin
    update public.appointments set status = p_status where id = p_appointment_id;
  exception when exclusion_violation then
    raise exception 'SLOT_TAKEN';   -- ex.: admin reativando um horário já ocupado
  end;
end $$;

-- Funcionário pede alteração de um atendimento: notifica os administradores.
create or replace function public.request_appointment_change(p_appointment_id uuid, p_message text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare a public.appointments;
begin
  select * into a from public.appointments where id = p_appointment_id;
  if not found then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  if a.employee_id is distinct from public.current_employee_id() and not public.is_admin() then
    raise exception 'FORBIDDEN';
  end if;
  insert into public.notifications (user_id, appointment_id, type, channel, title, message, status)
  select p.id, a.id, 'change_request', 'in_app', 'Solicitação de alteração',
         left(coalesce(nullif(trim(p_message), ''), 'Alteração solicitada pela profissional.'), 500), 'sent'
    from public.profiles p where p.role = 'admin';
end $$;

-- Agenda do profissional com apenas os dados necessários do cliente.
create or replace function public.get_employee_agenda(
  p_from timestamptz,
  p_to   timestamptz,
  p_employee_id uuid default null       -- admin pode consultar outro profissional
)
returns table (
  id uuid, starts_at timestamptz, ends_at timestamptz, status public.appointment_status,
  service_name text, duration_minutes int, client_name text, client_phone text,
  notes text, payment_status text, employee_id uuid, employee_name text, is_test_data boolean
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_emp uuid;
begin
  if public.is_admin() then
    v_emp := p_employee_id;              -- nulo = todos
  else
    v_emp := public.current_employee_id();
    if v_emp is null then raise exception 'FORBIDDEN'; end if;
  end if;

  return query
  select a.id, a.starts_at, a.ends_at, a.status,
         sv.name, sv.duration_minutes, pr.full_name, pr.phone, a.notes,
         case
           when bool_or(py.status = 'approved' and py.kind = 'full') then 'Pago'
           when bool_or(py.status = 'approved' and py.kind = 'deposit') then 'Sinal pago'
           when bool_or(py.method = 'on_site') then 'Pagar no local'
           else 'Pendente'
         end,
         e.id, e.display_name, a.is_test_data
    from public.appointments a
    join public.services sv  on sv.id = a.service_id
    join public.profiles pr  on pr.id = a.client_id
    join public.employees e  on e.id = a.employee_id
    left join public.payments py on py.appointment_id = a.id
   where a.starts_at >= p_from and a.starts_at < p_to
     and (v_emp is null or a.employee_id = v_emp)
   group by a.id, sv.name, sv.duration_minutes, pr.full_name, pr.phone, e.id, e.display_name
   order by a.starts_at;
end $$;


-- -----------------------------------------------------------------------------
-- 5. PAGAMENTOS E NOTIFICAÇÕES
-- -----------------------------------------------------------------------------

-- Cria notificação in-app + cópias "pending" para os canais externos configurados (outbox).
create or replace function public.notify(
  p_user uuid, p_appointment uuid, p_type text, p_title text, p_message text
)
returns void language plpgsql security definer set search_path = public as $$
declare ch public.notification_channel;
begin
  insert into public.notifications (user_id, appointment_id, type, channel, title, message, status)
  values (p_user, p_appointment, p_type, 'in_app', p_title, p_message, 'sent');
  foreach ch in array coalesce((select notify_channels from public.settings where id = 1), '{}') loop
    if ch <> 'in_app' then
      insert into public.notifications (user_id, appointment_id, type, channel, title, message, status)
      values (p_user, p_appointment, p_type, ch, p_title, p_message, 'pending');
    end if;
  end loop;
end $$;

create or replace function public.fmt_appt(p_appointment uuid)
returns text language sql stable security definer set search_path = public as $$
  select sv.name || ' em ' || to_char(a.starts_at at time zone public.app_tz(), 'DD/MM/YYYY "às" HH24:MI')
    from public.appointments a join public.services sv on sv.id = a.service_id
   where a.id = p_appointment
$$;

-- Notificações automáticas a partir de mudanças em agendamentos
create or replace function public.appointments_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'scheduled' then
      perform public.notify(new.client_id, new.id, 'appointment_confirmed', 'Agendamento confirmado',
                            'Seu agendamento de ' || public.fmt_appt(new.id) || ' está confirmado.');
    elsif new.status = 'pending_payment' then
      perform public.notify(new.client_id, new.id, 'appointment_pending_payment', 'Horário reservado',
                            'Reservamos ' || public.fmt_appt(new.id) || '. Conclua o pagamento para confirmar.');
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if old.status = 'pending_payment' and new.status = 'scheduled' then
      perform public.notify(new.client_id, new.id, 'appointment_confirmed', 'Agendamento confirmado',
                            'Seu agendamento de ' || public.fmt_appt(new.id) || ' está confirmado.');
    elsif new.status = 'cancelled' and old.status <> 'pending_payment' then
      perform public.notify(new.client_id, new.id, 'appointment_cancelled', 'Agendamento cancelado',
                            'O agendamento de ' || public.fmt_appt(new.id) || ' foi cancelado.');
    end if;
  end if;
  if new.starts_at is distinct from old.starts_at and new.status <> 'cancelled' then
    perform public.notify(new.client_id, new.id, 'appointment_rescheduled', 'Agendamento remarcado',
                          'Novo horário: ' || public.fmt_appt(new.id) || '.');
  end if;
  return new;
end $$;

drop trigger if exists trg_appointments_notify on public.appointments;
create trigger trg_appointments_notify
  after insert or update on public.appointments
  for each row execute function public.appointments_notify();

-- Avisa todas as administradoras (notificação in-app).
create or replace function public.notify_admins(p_appointment uuid, p_type text, p_title text, p_message text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, appointment_id, type, channel, title, message, status)
  select p.id, p_appointment, p_type, 'in_app', p_title, left(p_message, 500), 'sent'
    from public.profiles p where p.role = 'admin';
end $$;

-- Efeitos de mudança no status do pagamento (webhook, sincronização ou baixa manual no estúdio).
-- Aqui é o ÚNICO lugar onde pagamento aprovado libera (confirma) o horário.
create or replace function public.payments_after_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a public.appointments;
  v_valor text;
begin
  if new.status is not distinct from old.status then return new; end if;
  select * into a from public.appointments where id = new.appointment_id;
  v_valor := 'R$ ' || to_char(new.amount, 'FM999G990D00');

  if new.status = 'approved' then
    if new.paid_at is null then
      update public.payments set paid_at = now() where id = new.id;
    end if;
    perform public.notify(new.client_id, new.appointment_id, 'payment_approved', 'Pagamento aprovado',
                          'Recebemos seu pagamento de ' || v_valor || '.');
    if a.status = 'pending_payment' then
      update public.appointments set status = 'scheduled' where id = a.id;
    elsif a.status = 'cancelled' and a.cancel_reason = 'Pagamento não concluído no prazo' and a.starts_at > now() then
      -- pagamento chegou depois que a reserva expirou: reativa se o horário ainda estiver livre
      begin
        update public.appointments set status = 'scheduled', cancelled_at = null, cancel_reason = null where id = a.id;
      exception when exclusion_violation then
        perform public.notify_admins(a.id, 'refund_required', 'Estorno automático',
          'Pagamento aprovado depois que o horário foi ocupado. O valor será devolvido automaticamente pelo Mercado Pago.');
      end;
    end if;

  elsif new.status = 'rejected' and a.status = 'pending_payment' then
    perform public.notify(new.client_id, new.appointment_id, 'payment_failed', 'Pagamento não aprovado',
                          'Não foi possível confirmar o pagamento. Você pode tentar novamente em "Minhas compras".');

  elsif new.status in ('refunded', 'charged_back') then
    -- estorno total ou contestação: o horário deixa de estar garantido
    if a.status in ('pending_payment', 'scheduled', 'confirmed') and a.starts_at > now()
       and (new.status = 'charged_back' or new.refund_amount >= new.amount) then
      update public.appointments
         set status = 'cancelled', cancelled_at = now(),
             cancel_reason = case when new.status = 'charged_back' then 'Pagamento contestado (chargeback)'
                                  else 'Pagamento estornado' end
       where id = a.id;
    end if;
    if new.status = 'refunded' then
      perform public.notify(new.client_id, new.appointment_id, 'payment_refunded', 'Estorno realizado',
        'Devolvemos R$ ' || to_char(greatest(new.refund_amount, 0), 'FM999G990D00')
        || ' pela mesma forma de pagamento. O prazo para aparecer depende do banco ou cartão.');
    else
      perform public.notify_admins(a.id, 'payment_dispute', 'Contestação de pagamento (chargeback)',
        'A cliente contestou o pagamento de ' || v_valor || ' junto ao banco. O agendamento foi bloqueado. Responda pelo painel do Mercado Pago.');
    end if;

  elsif new.status = 'in_mediation' then
    perform public.notify_admins(a.id, 'payment_dispute', 'Pagamento em disputa',
      'O pagamento de ' || v_valor || ' está em mediação no Mercado Pago. Acompanhe pelo painel do Mercado Pago.');
  end if;
  return new;
end $$;

drop trigger if exists trg_payments_after_update on public.payments;
create trigger trg_payments_after_update
  after update of status on public.payments
  for each row execute function public.payments_after_update();

-- Bloqueia alterações indevidas feitas DIRETAMENTE pela API (anon/authenticated).
-- Funções do servidor e a service_role (Edge Functions) não passam por esta regra.
-- Resultado: status de pagamento ONLINE só muda via webhook/sincronização validados no Mercado Pago;
-- a administradora só altera manualmente pagamentos feitos no estúdio.
create or replace function public.guard_payment_changes()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if tg_op = 'INSERT' then
    if new.method <> 'on_site' or new.status <> 'pending' or new.provider_payment_id is not null then
      raise exception 'PAYMENT_STATUS_LOCKED';
    end if;
    return new;
  end if;
  if new.amount <> old.amount or new.client_id <> old.client_id or new.appointment_id <> old.appointment_id
     or new.method <> old.method or new.kind <> old.kind or new.currency <> old.currency
     or new.provider is distinct from old.provider
     or new.provider_payment_id is distinct from old.provider_payment_id
     or new.provider_preference_id is distinct from old.provider_preference_id
     or new.provider_status is distinct from old.provider_status
     or new.live_mode is distinct from old.live_mode then
    raise exception 'PAYMENT_STATUS_LOCKED';
  end if;
  if new.status is distinct from old.status then
    if old.method <> 'on_site' then raise exception 'PAYMENT_STATUS_LOCKED'; end if;
    if not ((old.status = 'pending'        and new.status in ('approved', 'cancelled'))
         or (old.status = 'approved'       and new.status = 'refunded')
         or (old.status = 'refund_pending' and new.status = 'refunded')) then
      raise exception 'INVALID_STATUS';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_payments_guard on public.payments;
create trigger trg_payments_guard
  before insert or update on public.payments
  for each row execute function public.guard_payment_changes();

-- Aplica o estado de um pagamento CONSULTADO NA API do Mercado Pago.
-- Chamada SOMENTE pelas Edge Functions (service_role), depois de buscar o pagamento
-- em GET /v1/payments/{id}. Nunca recebe dados do navegador.
-- Idempotente: reaplicar o mesmo estado não duplica nada; eventos antigos são ignorados.
create or replace function public.apply_gateway_payment(
  p_payment_id          uuid,
  p_provider            text,
  p_provider_payment_id text,
  p_status              text,
  p_status_detail       text,
  p_amount              numeric,
  p_currency            text,
  p_payment_type        text,
  p_payment_method_id   text,
  p_last_four           text,
  p_live_mode           boolean,
  p_updated_at          timestamptz,
  p_approved_at         timestamptz,
  p_refunded_amount     numeric default 0,
  p_require_live        boolean default false
)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  p          public.payments;
  a          public.appointments;
  v_new      public.payment_status;
  v_refunded numeric(10,2) := greatest(coalesce(p_refunded_amount, 0), 0);
  v_refund   boolean := false;
begin
  if p_provider_payment_id is null or p_provider_payment_id !~ '^[0-9A-Za-z_-]{1,64}$' then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into p from public.payments where id = p_payment_id for update;   -- trava contra eventos simultâneos
  if not found then return jsonb_build_object('outcome', 'unknown_reference'); end if;
  if p.method = 'on_site' then return jsonb_build_object('outcome', 'not_online', 'payment_id', p.id); end if;

  -- mapeia o status oficial do Mercado Pago para o ciclo de vida interno
  v_new := case p_status
    when 'approved'     then 'approved'
    when 'authorized'   then 'in_process'     -- autorizado, ainda não capturado: NÃO libera o horário
    when 'in_process'   then 'in_process'
    when 'pending'      then 'pending'
    when 'in_mediation' then 'in_mediation'
    when 'rejected'     then 'rejected'
    when 'cancelled'    then 'cancelled'
    when 'refunded'     then 'refunded'
    when 'charged_back' then 'charged_back'
    else null end;
  if v_new is null then return jsonb_build_object('outcome', 'unknown_status', 'payment_id', p.id); end if;

  -- Outra tentativa (outro ID no Mercado Pago) para o mesmo agendamento
  if p.provider_payment_id is not null and p.provider_payment_id <> p_provider_payment_id then
    if p.status in ('approved', 'refund_pending', 'refunded', 'charged_back', 'in_mediation') then
      if v_new = 'approved' then
        -- pagamento em DUPLICIDADE: o horário já está pago; devolve integralmente o segundo
        perform public.notify_admins(p.appointment_id, 'refund_required', 'Pagamento em duplicidade',
          'A cliente pagou duas vezes o mesmo agendamento. O segundo pagamento será estornado automaticamente.');
        return jsonb_build_object('outcome', 'duplicate_payment', 'payment_id', p.id, 'refund_required', true,
                                  'refund_amount', p_amount, 'refund_provider_payment_id', p_provider_payment_id);
      end if;
      return jsonb_build_object('outcome', 'ignored_other_attempt', 'payment_id', p.id);
    end if;
    -- recusa/cancelamento de uma tentativa ANTERIOR não substitui a tentativa atual
    if v_new in ('rejected', 'cancelled') and p.status in ('pending', 'in_process', 'rejected', 'cancelled') then
      return jsonb_build_object('outcome', 'ignored_other_attempt', 'payment_id', p.id);
    end if;
  end if;

  -- Estorno/contestação de uma tentativa que nunca foi aceita aqui (ex.: valor divergente já devolvido):
  -- não mexe no pagamento atual nem no horário
  if p.provider_payment_id is distinct from p_provider_payment_id and v_new in ('refunded', 'charged_back', 'in_mediation') then
    return jsonb_build_object('outcome', 'ignored_other_attempt', 'payment_id', p.id);
  end if;

  if p.provider_payment_id = p_provider_payment_id and p.provider_updated_at is not null
        and p_updated_at is not null and p_updated_at < p.provider_updated_at then
    return jsonb_build_object('outcome', 'stale', 'payment_id', p.id);   -- notificação antiga chegando atrasada
  end if;

  -- Regras para considerar um pagamento APROVADO
  if v_new = 'approved' and v_refunded = 0 then
    if p_require_live and p_live_mode is distinct from true then
      perform public.notify_admins(p.appointment_id, 'refund_required', 'Pagamento de teste em produção',
        'Um pagamento de TESTE foi recebido com o sistema em produção e foi ignorado. Verifique as credenciais.');
      return jsonb_build_object('outcome', 'not_live', 'payment_id', p.id);
    end if;
    if upper(coalesce(p_currency, '')) <> upper(p.currency) or coalesce(p_amount, 0) + 0.005 < p.amount then
      -- não grava o ID desta tentativa: ela não vale para o horário (fica registrada em payment_events)
      update public.payments set last_synced_at = now() where id = p.id;
      perform public.notify_admins(p.appointment_id, 'refund_required', 'Valor de pagamento divergente',
        'Um pagamento chegou com valor ou moeda diferente do cobrado e NÃO confirmou o horário. Ele será estornado.');
      return jsonb_build_object('outcome', 'amount_mismatch', 'payment_id', p.id, 'refund_required', true,
                                'refund_amount', p_amount, 'refund_provider_payment_id', p_provider_payment_id);
    end if;
  end if;

  -- Estorno parcial: o MP mantém 'approved' e informa o valor devolvido
  if v_new = 'approved' and v_refunded > 0 then v_new := 'refunded'; end if;
  -- Estorno solicitado e ainda não processado: continua "Estorno pendente"
  if p.status = 'refund_pending' and v_new = 'approved' then v_new := 'refund_pending'; end if;

  -- Nada mudou: só registra a sincronização (webhook repetido)
  if v_new = p.status and p.provider_payment_id is not distinct from p_provider_payment_id
     and p.provider_status is not distinct from p_status
     and (v_new <> 'refunded' or p.refund_amount >= greatest(v_refunded, case when p_status = 'refunded' then p.amount else 0 end)) then
    update public.payments set last_synced_at = now() where id = p.id;
    return jsonb_build_object('outcome', 'no_change', 'payment_id', p.id, 'status', v_new);
  end if;

  update public.payments set
    status                 = v_new,
    provider               = p_provider,
    provider_payment_id    = p_provider_payment_id,
    provider_status        = p_status,
    provider_status_detail = left(p_status_detail, 80),
    payment_type           = left(p_payment_type, 40),
    payment_method_id      = left(p_payment_method_id, 40),
    card_last_four         = case when p_last_four ~ '^[0-9]{4}$' then p_last_four else card_last_four end,
    live_mode              = p_live_mode,
    provider_updated_at    = coalesce(p_updated_at, now()),
    paid_at                = case when v_new in ('approved', 'refund_pending', 'refunded')
                                  then coalesce(paid_at, p_approved_at, now()) else paid_at end,
    refund_amount          = case when v_new = 'refunded'
                                  then greatest(refund_amount, v_refunded, case when p_status = 'refunded' then amount else 0 end)
                                  else refund_amount end,
    refunded_at            = case when v_new = 'refunded' then coalesce(refunded_at, now()) else refunded_at end,
    charged_back_at        = case when v_new = 'charged_back' then coalesce(charged_back_at, now()) else charged_back_at end,
    last_synced_at         = now()
  where id = p.id;

  -- Aprovado, mas o agendamento não pôde ser confirmado (cancelado ou horário ocupado):
  -- devolve o dinheiro automaticamente em vez de cobrar por um horário inexistente.
  select * into a from public.appointments where id = p.appointment_id;
  if v_new = 'approved' and a.status not in ('scheduled', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show') then
    update public.payments set status = 'refund_pending', refund_amount = amount where id = p.id;
    v_refund := true;
    v_new := 'refund_pending';
  end if;

  return jsonb_build_object('outcome', 'applied', 'payment_id', p.id, 'status', v_new,
                            'appointment_status', a.status, 'refund_required', v_refund,
                            'refund_amount', case when v_refund then p.amount end,
                            'refund_provider_payment_id', case when v_refund then p_provider_payment_id end);
end $$;

drop function if exists public.apply_payment_update(uuid, public.payment_status, text, text, text);
drop function if exists public.simulate_payment(uuid, boolean);

-- Limite de requisições (janela fixa). Retorna false quando o limite foi excedido.
create or replace function public.rate_limit_hit(p_bucket text, p_limit int, p_window_seconds int)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits  int;
begin
  insert into public.api_rate_limits (bucket, window_start, hits) values (left(p_bucket, 200), v_start, 1)
  on conflict (bucket, window_start) do update set hits = public.api_rate_limits.hits + 1
  returning hits into v_hits;
  if random() < 0.02 then
    delete from public.api_rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_limit;
end $$;

-- Lembretes (agende com pg_cron, ex.: a cada 30 min). Cria 1 lembrete por agendamento ~24h antes.
create or replace function public.enqueue_reminders()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in
    select a.id, a.client_id from public.appointments a
     where a.status in ('scheduled', 'confirmed')
       and a.starts_at between now() and now() + interval '24 hours'
       and not exists (select 1 from public.notifications x
                        where x.appointment_id = a.id and x.type = 'appointment_reminder')
  loop
    perform public.notify(r.client_id, r.id, 'appointment_reminder', 'Lembrete de atendimento',
                          'Lembrete: ' || public.fmt_appt(r.id) || '. Te esperamos!');
    n := n + 1;
  end loop;
  return n;
end $$;


-- -----------------------------------------------------------------------------
-- 6. ADMINISTRAÇÃO E RELATÓRIOS
-- -----------------------------------------------------------------------------

-- Promove um usuário já cadastrado a funcionário (ou reativa).
create or replace function public.admin_upsert_employee(
  p_email text, p_display_name text, p_title text default 'Designer de sobrancelhas'
)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare v_profile public.profiles; v_emp uuid;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  select * into v_profile from public.profiles where lower(email) = lower(trim(p_email));
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  if v_profile.role = 'client' then
    update public.profiles set role = 'employee' where id = v_profile.id;
  end if;
  insert into public.employees (profile_id, display_name, title, is_active)
  values (v_profile.id, coalesce(nullif(trim(p_display_name), ''), v_profile.full_name), coalesce(p_title, 'Designer de sobrancelhas'), true)
  on conflict (profile_id) do update
     set display_name = excluded.display_name, title = excluded.title, is_active = true
  returning id into v_emp;
  return v_emp;
end $$;

-- Controle de permissões: altera o papel de um usuário.
create or replace function public.admin_set_role(p_user_id uuid, p_role public.user_role)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  if p_user_id = auth.uid() and p_role <> 'admin' then raise exception 'CANNOT_DEMOTE_SELF'; end if;
  update public.profiles set role = p_role where id = p_user_id;
  if p_role = 'client' then
    update public.employees set is_active = false where profile_id = p_user_id;
  end if;
end $$;

-- Indicadores do dashboard
create or replace function public.admin_dashboard(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  tz text := public.app_tz();
  v_today date := (now() at time zone tz)::date;
  v_week_start date := v_today - ((extract(isodow from v_today)::int) - 1);
  f timestamptz := (p_from::timestamp) at time zone tz;
  t timestamptz := ((p_to + 1)::timestamp) at time zone tz;
  r jsonb;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  select jsonb_build_object(
    'today_count', (select count(*) from appointments
                     where (starts_at at time zone tz)::date = v_today and status not in ('cancelled')),
    'week_count',  (select count(*) from appointments
                     where (starts_at at time zone tz)::date between v_week_start and v_week_start + 6
                       and status not in ('cancelled')),
    'revenue',     (select coalesce(sum(amount - refund_amount), 0) from payments
                     where status in ('approved', 'refund_pending', 'refunded') and paid_at >= f and paid_at < t),
    'clients_count', (select count(*) from profiles where role = 'client'),
    'new_clients', (select count(*) from profiles where role = 'client' and created_at >= f and created_at < t),
    'completed_count', (select count(*) from appointments where status = 'completed' and starts_at >= f and starts_at < t),
    'cancelled_count', (select count(*) from appointments where status = 'cancelled' and starts_at >= f and starts_at < t),
    'no_show_count',   (select count(*) from appointments where status = 'no_show'   and starts_at >= f and starts_at < t),
    'pending_refunds', (select count(*) from payments where status = 'refund_pending'),
    'revenue_by_day', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'total', coalesce(x.total, 0)) order by d), '[]')
        from generate_series(p_from, p_to, interval '1 day') d
        left join (select (paid_at at time zone tz)::date as day, sum(amount - refund_amount) total
                     from payments where status in ('approved', 'refund_pending', 'refunded')
                      and paid_at >= f and paid_at < t group by 1) x on x.day = d::date),
    'by_service', (
      select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', c) order by c desc), '[]')
        from (select sv.name, count(*) c from appointments a join services sv on sv.id = a.service_id
               where a.starts_at >= f and a.starts_at < t and a.status not in ('cancelled')
               group by sv.name) z),
    'by_status', (
      select coalesce(jsonb_object_agg(status, c), '{}')
        from (select status, count(*) c from appointments where starts_at >= f and starts_at < t group by status) z)
  ) into r;
  return r;
end $$;

-- "Minhas compras": visão segura das compras (pagamentos) com o procedimento e o status do horário.
-- security_invoker = true → aplica o RLS de quem consulta (cada cliente vê só as próprias).
-- Não expõe link de checkout, tokens nem nada além do mascarado (últimos 4 dígitos).
create or replace view public.purchases with (security_invoker = true) as
select p.id,
       p.client_id                       as user_id,
       p.appointment_id,
       a.service_id                      as product_id,
       sv.name                           as product_name,
       a.starts_at                       as appointment_starts_at,
       a.status                          as appointment_status,
       p.kind,
       p.amount,
       p.currency,
       p.status,
       p.method                          as payment_method,
       p.payment_type,
       p.payment_method_id,
       p.card_last_four,
       p.provider,
       p.provider_payment_id             as mercadopago_payment_id,
       p.provider_preference_id          as mercadopago_preference_id,
       p.checkout_expires_at,
       p.created_at                      as purchase_date,
       p.paid_at                         as approved_at,
       p.refunded_at,
       p.charged_back_at,
       p.refund_amount,
       p.updated_at,
       p.is_test_data,
       -- "acesso liberado" = horário confirmado pelo servidor
       (a.status in ('scheduled', 'confirmed', 'arrived', 'in_progress', 'completed')) as access_granted
  from public.payments p
  join public.appointments a on a.id = p.appointment_id
  join public.services sv    on sv.id = a.service_id;

-- Depoimentos públicos (somente primeiro nome do cliente)
create or replace function public.get_public_reviews(p_limit int default 6)
returns table (id uuid, client_first_name text, rating smallint, comment text, created_at timestamptz, is_test_data boolean)
language sql stable security definer set search_path = public as $$
  select r.id, split_part(coalesce(nullif(p.full_name, ''), 'Cliente'), ' ', 1), r.rating, r.comment, r.created_at, r.is_test_data
    from public.reviews r join public.profiles p on p.id = r.client_id
   where r.is_published
   order by r.created_at desc
   limit least(greatest(p_limit, 1), 24)
$$;


-- -----------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY
-- -----------------------------------------------------------------------------
alter table public.settings          enable row level security;
alter table public.profiles          enable row level security;
alter table public.employees         enable row level security;
alter table public.services          enable row level security;
alter table public.employee_services enable row level security;
alter table public.business_hours    enable row level security;
alter table public.special_hours     enable row level security;
alter table public.employee_hours    enable row level security;
alter table public.holidays          enable row level security;
alter table public.blocked_dates     enable row level security;
alter table public.blocked_times     enable row level security;
alter table public.appointments      enable row level security;
alter table public.payments          enable row level security;
alter table public.notifications     enable row level security;
alter table public.reviews           enable row level security;
alter table public.gallery_items     enable row level security;

alter table public.payment_events    enable row level security;
alter table public.api_rate_limits   enable row level security;   -- sem policies: ninguém acessa pela API

-- Remove policies antigas (permite reexecutar o script)
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- settings: leitura pública (contato e política), escrita só admin
create policy settings_read  on public.settings for select using (true);
create policy settings_admin on public.settings for update using (public.is_admin()) with check (public.is_admin());

-- profiles: cada um vê/edita o próprio; admin vê/edita todos
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- employees: perfil público dos profissionais ativos; admin gerencia
create policy employees_public on public.employees for select
  using (is_active or profile_id = auth.uid() or public.is_admin()
         or exists (select 1 from public.appointments a
                     where a.employee_id = employees.id and a.client_id = auth.uid()));
create policy employees_admin_ins on public.employees for insert with check (public.is_admin());
create policy employees_admin_upd on public.employees for update using (public.is_admin()) with check (public.is_admin());
create policy employees_admin_del on public.employees for delete using (public.is_admin());

-- services: públicos quando ativos; admin gerencia
create policy services_public on public.services for select
  using (is_active or public.is_admin()
         or exists (select 1 from public.appointments a        -- histórico de quem já fez o procedimento
                     where a.service_id = services.id
                       and (a.client_id = auth.uid() or a.employee_id = public.current_employee_id())));
create policy services_admin_ins on public.services for insert with check (public.is_admin());
create policy services_admin_upd on public.services for update using (public.is_admin()) with check (public.is_admin());
create policy services_admin_del on public.services for delete using (public.is_admin());

create policy emp_services_public on public.employee_services for select using (true);
create policy emp_services_admin_ins on public.employee_services for insert with check (public.is_admin());
create policy emp_services_admin_del on public.employee_services for delete using (public.is_admin());

-- horários do estabelecimento: públicos (rodapé/contato); admin gerencia
create policy bh_public on public.business_hours for select using (true);
create policy bh_admin_ins on public.business_hours for insert with check (public.is_admin());
create policy bh_admin_upd on public.business_hours for update using (public.is_admin()) with check (public.is_admin());

create policy sh_public on public.special_hours for select using (true);
create policy sh_admin_ins on public.special_hours for insert with check (public.is_admin());
create policy sh_admin_upd on public.special_hours for update using (public.is_admin()) with check (public.is_admin());
create policy sh_admin_del on public.special_hours for delete using (public.is_admin());

create policy holidays_public on public.holidays for select using (true);
create policy holidays_admin_ins on public.holidays for insert with check (public.is_admin());
create policy holidays_admin_upd on public.holidays for update using (public.is_admin()) with check (public.is_admin());
create policy holidays_admin_del on public.holidays for delete using (public.is_admin());

-- jornada/bloqueios: admin + o próprio funcionário (leitura)
create policy eh_select on public.employee_hours for select
  using (public.is_admin() or employee_id = public.current_employee_id());
create policy eh_admin_ins on public.employee_hours for insert with check (public.is_admin());
create policy eh_admin_upd on public.employee_hours for update using (public.is_admin()) with check (public.is_admin());
create policy eh_admin_del on public.employee_hours for delete using (public.is_admin());

create policy bd_select on public.blocked_dates for select
  using (public.is_admin() or employee_id is null or employee_id = public.current_employee_id());
create policy bd_admin_ins on public.blocked_dates for insert with check (public.is_admin());
create policy bd_admin_upd on public.blocked_dates for update using (public.is_admin()) with check (public.is_admin());
create policy bd_admin_del on public.blocked_dates for delete using (public.is_admin());

create policy bt_select on public.blocked_times for select
  using (public.is_admin() or employee_id is null or employee_id = public.current_employee_id());
create policy bt_admin_ins on public.blocked_times for insert with check (public.is_admin());
create policy bt_admin_upd on public.blocked_times for update using (public.is_admin()) with check (public.is_admin());
create policy bt_admin_del on public.blocked_times for delete using (public.is_admin());

-- appointments: cliente vê os seus; funcionário vê os dele; admin tudo.
-- Criação/alteração por cliente e funcionário SOMENTE via funções (book/cancel/reschedule/status).
create policy appt_select on public.appointments for select
  using (client_id = auth.uid() or employee_id = public.current_employee_id() or public.is_admin());
create policy appt_admin_ins on public.appointments for insert with check (public.is_admin());
create policy appt_admin_upd on public.appointments for update using (public.is_admin()) with check (public.is_admin());
create policy appt_admin_del on public.appointments for delete using (public.is_admin());

-- payments: cliente vê os seus; admin gerencia. Funcionário não acessa dados financeiros.
create policy pay_select on public.payments for select using (client_id = auth.uid() or public.is_admin());
create policy pay_admin_ins on public.payments for insert with check (public.is_admin());
create policy pay_admin_upd on public.payments for update using (public.is_admin()) with check (public.is_admin());

-- payment_events: somente leitura para a administração (gravação apenas pela service_role)
create policy pay_events_admin on public.payment_events for select using (public.is_admin());

-- notifications: cada um vê e marca como lida as suas
create policy notif_select on public.notifications for select using (user_id = auth.uid() or public.is_admin());
create policy notif_update on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- reviews: cliente cria para atendimento concluído próprio; admin modera
create policy reviews_select on public.reviews for select using (client_id = auth.uid() or public.is_admin());
create policy reviews_insert on public.reviews for insert with check (
  client_id = auth.uid() and is_published = false and is_test_data = false and exists (
    select 1 from public.appointments a
     where a.id = appointment_id and a.client_id = auth.uid() and a.status = 'completed'));
create policy reviews_admin_upd on public.reviews for update using (public.is_admin()) with check (public.is_admin());
create policy reviews_admin_del on public.reviews for delete using (public.is_admin());

-- galeria: pública quando ativa
create policy gallery_public on public.gallery_items for select using (is_active or public.is_admin());
create policy gallery_admin_ins on public.gallery_items for insert with check (public.is_admin());
create policy gallery_admin_upd on public.gallery_items for update using (public.is_admin()) with check (public.is_admin());
create policy gallery_admin_del on public.gallery_items for delete using (public.is_admin());


-- -----------------------------------------------------------------------------
-- 8. GRANTS
-- -----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- Colunas que o próprio usuário pode alterar em notificações
revoke update on public.notifications from authenticated;
grant update (read_at, status) on public.notifications to authenticated;

-- Tabelas internas de pagamento: nada para o navegador (só leitura de eventos pelo admin via RLS)
revoke all on public.payment_events  from anon, authenticated;
revoke all on public.api_rate_limits from anon, authenticated;
grant select on public.payment_events to authenticated;
revoke all on public.purchases from anon;
grant select on public.purchases to authenticated;

-- Funções: o Postgres concede EXECUTE a PUBLIC e o Supabase concede a anon/authenticated
-- em toda função nova. Revogamos de TODOS e liberamos uma a uma, só o que o site precisa.
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
grant execute on function public.get_available_slots(uuid, date, uuid, uuid)  to anon, authenticated;
grant execute on function public.get_month_availability(uuid, date, uuid)     to anon, authenticated;
grant execute on function public.get_public_reviews(int)                      to anon, authenticated;
grant execute on function public.auth_role()                                  to authenticated;
grant execute on function public.ensure_profile()                             to authenticated;
grant execute on function public.is_admin()                                   to anon, authenticated;
grant execute on function public.current_employee_id()                        to anon, authenticated;
grant execute on function public.app_tz()                                     to anon, authenticated;
grant execute on function public.book_appointment(uuid, timestamptz, uuid, public.payment_method, text, uuid) to authenticated;
grant execute on function public.cancellation_quote(uuid)                     to authenticated;
grant execute on function public.cancel_appointment(uuid, text)               to authenticated;
grant execute on function public.reschedule_appointment(uuid, timestamptz, uuid) to authenticated;
grant execute on function public.update_appointment_status(uuid, public.appointment_status) to authenticated;
grant execute on function public.request_appointment_change(uuid, text)       to authenticated;
grant execute on function public.get_employee_agenda(timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.admin_upsert_employee(text, text, text)      to authenticated;
grant execute on function public.admin_set_role(uuid, public.user_role)       to authenticated;
grant execute on function public.admin_dashboard(date, date)                  to authenticated;
grant execute on function public.expire_pending_appointments()                to authenticated;
-- apply_gateway_payment, rate_limit_hit, enqueue_reminders, notify, notify_admins: somente service_role
grant execute on all functions in schema public to service_role;
-- funções de trigger precisam ser executáveis pelos papéis que disparam os triggers
-- (funções de trigger não precisam de EXECUTE para disparar; notify/fmt_appt ficam
--  restritas para que ninguém crie notificações para terceiros via RPC)

-- Dados iniciais obrigatórios (idempotente)
-- Contato oficial do estúdio (editável em Admin → Configurações → Contato e avisos)
insert into public.settings (id, phone, whatsapp, instagram, email, address, maps_url)
values (1, '(11) 96097-8246', '5511960978246', 'jhen.beautycare', 'jhenbeautycare@gmail.com',
        'R. Manoel de Nóbrega, 352 - Maracanã',
        'https://www.google.com/maps/search/?api=1&query=R.+Manoel+de+N%C3%B3brega%2C+352+-+Maracan%C3%A3')
on conflict (id) do nothing;
insert into public.business_hours (weekday, is_open, open_time, close_time, break_start, break_end) values
  (0, false, null, null, null, null),
  (1, false, null, null, null, null),
  (2, true, '09:00', '19:00', '12:00', '13:00'),
  (3, true, '09:00', '19:00', '12:00', '13:00'),
  (4, true, '09:00', '19:00', '12:00', '13:00'),
  (5, true, '09:00', '19:00', '12:00', '13:00'),
  (6, true, '09:00', '16:00', null, null)
on conflict (weekday) do nothing;


-- -----------------------------------------------------------------------------
-- 9. STORAGE (bucket público "media": procedimentos, galeria, avatares)
--    Executado apenas se o schema storage existir (sempre existe no Supabase).
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'Schema storage não encontrado — pulando configuração de Storage.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('media', 'media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = true, file_size_limit = 5242880,
                                 allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

  execute 'drop policy if exists media_public_read on storage.objects';
  execute 'drop policy if exists media_admin_write on storage.objects';
  execute 'drop policy if exists media_admin_update on storage.objects';
  execute 'drop policy if exists media_admin_delete on storage.objects';
  execute 'drop policy if exists media_avatar_insert on storage.objects';
  execute 'drop policy if exists media_avatar_update on storage.objects';
  execute 'drop policy if exists media_avatar_delete on storage.objects';

  execute $p$create policy media_public_read on storage.objects for select using (bucket_id = 'media')$p$;
  execute $p$create policy media_admin_write on storage.objects for insert to authenticated
            with check (bucket_id = 'media' and public.is_admin())$p$;
  execute $p$create policy media_admin_update on storage.objects for update to authenticated
            using (bucket_id = 'media' and public.is_admin())$p$;
  execute $p$create policy media_admin_delete on storage.objects for delete to authenticated
            using (bucket_id = 'media' and public.is_admin())$p$;
  -- avatares: avatars/<uid>/arquivo
  execute $p$create policy media_avatar_insert on storage.objects for insert to authenticated
            with check (bucket_id = 'media' and (storage.foldername(name))[1] = 'avatars'
                        and (storage.foldername(name))[2] = auth.uid()::text)$p$;
  execute $p$create policy media_avatar_update on storage.objects for update to authenticated
            using (bucket_id = 'media' and (storage.foldername(name))[1] = 'avatars'
                   and (storage.foldername(name))[2] = auth.uid()::text)$p$;
  execute $p$create policy media_avatar_delete on storage.objects for delete to authenticated
            using (bucket_id = 'media' and (storage.foldername(name))[1] = 'avatars'
                   and (storage.foldername(name))[2] = auth.uid()::text)$p$;
end $$;

-- Fim do schema.
