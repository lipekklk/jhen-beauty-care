-- =============================================================================
-- Migração: integração Mercado Pago (Checkout Pro) — para bancos que JÁ rodaram
-- a versão anterior do schema.sql. Instalações novas: basta o schema.sql.
--
-- Como rodar (SQL Editor do Supabase): cole e execute este arquivo inteiro UMA vez.
-- Parte 1 adiciona valores de enum e confirma (commit); parte 2 aplica o restante.
-- Efeito: payment_provider passa a 'disabled' até você configurar o Mercado Pago.
-- =============================================================================

-- Parte 1
alter type public.payment_method add value if not exists 'online';
alter type public.payment_status add value if not exists 'in_process';
alter type public.payment_status add value if not exists 'charged_back';
alter type public.payment_status add value if not exists 'in_mediation';
commit;

-- Parte 2
begin;
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
alter table public.settings drop constraint if exists settings_payment_provider_check;
update public.settings set payment_provider = 'disabled' where payment_provider not in ('disabled', 'mercadopago');
alter table public.settings add constraint settings_payment_provider_check check (payment_provider in ('disabled', 'mercadopago'));
alter table public.settings alter column payment_provider set default 'disabled';
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'appointment_confirmed', 'appointment_pending_payment', 'payment_approved', 'payment_failed',
  'appointment_reminder', 'appointment_cancelled', 'appointment_rescheduled',
  'change_request', 'refund_required', 'payment_refunded', 'payment_dispute', 'generic'));
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
create table if not exists public.api_rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (bucket, window_start)
);
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
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  v_client := case when p_client_id is not null and public.is_admin() then p_client_id else v_uid end;
  select * into v_profile from public.profiles where id = v_client;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  if v_profile.is_blocked then raise exception 'ACCOUNT_BLOCKED'; end if;
  select * into v_service from public.services where id = p_service_id and is_active;
  if not found then raise exception 'SERVICE_NOT_FOUND'; end if;
  if p_employee_id is not null and not exists (
       select 1 from public.employee_services es join public.employees e on e.id = es.employee_id
        where es.employee_id = p_employee_id and es.service_id = p_service_id and e.is_active) then
    raise exception 'EMPLOYEE_NOT_ENABLED';
  end if;
  select * into s from public.settings where id = 1;
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
  perform public.expire_pending_appointments();
  v_date := (p_starts_at at time zone s.timezone)::date;
  select g.employee_id into v_emp
    from public.get_available_slots(p_service_id, v_date, p_employee_id) g
   where g.slot_start = p_starts_at
   order by random()                -- "qualquer profissional": distribui a agenda
   limit 1;
  if v_emp is null then raise exception 'SLOT_UNAVAILABLE'; end if;
  v_ends := p_starts_at + make_interval(mins => v_service.duration_minutes);
  if exists (select 1 from public.appointments a
              where a.client_id = v_client and a.status not in ('cancelled', 'no_show')
                and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_starts_at, v_ends, '[)')) then
    raise exception 'CLIENT_CONFLICT';
  end if;
  if v_method = 'on_site' then
    v_kind := 'on_site'; v_amount := v_service.price; v_status := 'scheduled';
  elsif v_service.payment_mode = 'deposit' then
    v_kind := 'deposit'; v_amount := v_service.deposit_amount; v_status := 'pending_payment';
  else
    v_kind := 'full'; v_amount := v_service.price; v_status := 'pending_payment';
  end if;
  begin
    insert into public.appointments (client_id, employee_id, service_id, starts_at, ends_at, status, price, notes)
    values (v_client, v_emp, p_service_id, p_starts_at, v_ends, v_status, v_service.price, nullif(trim(p_notes), ''))
    returning id into v_appt_id;
  exception when exclusion_violation then
    raise exception 'SLOT_TAKEN';
  end;
  insert into public.payments (appointment_id, client_id, amount, kind, method, status, provider, checkout_expires_at)
  values (v_appt_id, v_client, v_amount, v_kind, v_method, 'pending',
          case when v_method = 'on_site' then 'manual' else 'mercadopago' end,
          case when v_status = 'pending_payment' then now() + make_interval(mins => s.payment_hold_minutes) end)
  returning id into v_pay_id;
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
create or replace function public.notify_admins(p_appointment uuid, p_type text, p_title text, p_message text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, appointment_id, type, channel, title, message, status)
  select p.id, p_appointment, p_type, 'in_app', p_title, left(p_message, 500), 'sent'
    from public.profiles p where p.role = 'admin';
end $$;
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
  if p.provider_payment_id is not null and p.provider_payment_id <> p_provider_payment_id then
    if p.status in ('approved', 'refund_pending', 'refunded', 'charged_back', 'in_mediation') then
      if v_new = 'approved' then
        perform public.notify_admins(p.appointment_id, 'refund_required', 'Pagamento em duplicidade',
          'A cliente pagou duas vezes o mesmo agendamento. O segundo pagamento será estornado automaticamente.');
        return jsonb_build_object('outcome', 'duplicate_payment', 'payment_id', p.id, 'refund_required', true,
                                  'refund_amount', p_amount, 'refund_provider_payment_id', p_provider_payment_id);
      end if;
      return jsonb_build_object('outcome', 'ignored_other_attempt', 'payment_id', p.id);
    end if;
    if v_new in ('rejected', 'cancelled') and p.status in ('pending', 'in_process', 'rejected', 'cancelled') then
      return jsonb_build_object('outcome', 'ignored_other_attempt', 'payment_id', p.id);
    end if;
  end if;
  if p.provider_payment_id is distinct from p_provider_payment_id and v_new in ('refunded', 'charged_back', 'in_mediation') then
    return jsonb_build_object('outcome', 'ignored_other_attempt', 'payment_id', p.id);
  end if;
  if p.provider_payment_id = p_provider_payment_id and p.provider_updated_at is not null
        and p_updated_at is not null and p_updated_at < p.provider_updated_at then
    return jsonb_build_object('outcome', 'stale', 'payment_id', p.id);   -- notificação antiga chegando atrasada
  end if;
  if v_new = 'approved' and v_refunded = 0 then
    if p_require_live and p_live_mode is distinct from true then
      perform public.notify_admins(p.appointment_id, 'refund_required', 'Pagamento de teste em produção',
        'Um pagamento de TESTE foi recebido com o sistema em produção e foi ignorado. Verifique as credenciais.');
      return jsonb_build_object('outcome', 'not_live', 'payment_id', p.id);
    end if;
    if upper(coalesce(p_currency, '')) <> upper(p.currency) or coalesce(p_amount, 0) + 0.005 < p.amount then
      update public.payments set last_synced_at = now() where id = p.id;
      perform public.notify_admins(p.appointment_id, 'refund_required', 'Valor de pagamento divergente',
        'Um pagamento chegou com valor ou moeda diferente do cobrado e NÃO confirmou o horário. Ele será estornado.');
      return jsonb_build_object('outcome', 'amount_mismatch', 'payment_id', p.id, 'refund_required', true,
                                'refund_amount', p_amount, 'refund_provider_payment_id', p_provider_payment_id);
    end if;
  end if;
  if v_new = 'approved' and v_refunded > 0 then v_new := 'refunded'; end if;
  if p.status = 'refund_pending' and v_new = 'approved' then v_new := 'refund_pending'; end if;
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
       (a.status in ('scheduled', 'confirmed', 'arrived', 'in_progress', 'completed')) as access_granted
  from public.payments p
  join public.appointments a on a.id = p.appointment_id
  join public.services sv    on sv.id = a.service_id;
alter table public.payment_events    enable row level security;
alter table public.api_rate_limits   enable row level security;   -- sem policies: ninguém acessa pela API
drop policy if exists pay_events_admin on public.payment_events;
create policy pay_events_admin on public.payment_events for select using (public.is_admin());
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
revoke update on public.notifications from authenticated;
grant update (read_at, status) on public.notifications to authenticated;
revoke all on public.payment_events  from anon, authenticated;
revoke all on public.api_rate_limits from anon, authenticated;
grant select on public.payment_events to authenticated;
revoke all on public.purchases from anon;
grant select on public.purchases to authenticated;
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
grant execute on all functions in schema public to service_role;
commit;
