-- =====================================================================
--  Shri Sai Service Seva One  -  Supabase backend
--  Run this whole file once in: Supabase Dashboard > SQL Editor
--  Money rules live in Postgres functions (atomic, server-side only).
-- =====================================================================

create schema if not exists private;

-- ---------- ID sequences ----------
create sequence if not exists private.seq_payment     start 1001;
create sequence if not exists private.seq_application start 100001;
create sequence if not exists private.seq_ticket      start 1001;
create sequence if not exists private.seq_retailer    start 1001;

-- =====================================================================
-- 1. TABLES
-- =====================================================================

-- One row per auth user (Supabase Auth owns email + password)
create table public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  name                 text not null check (char_length(name) between 3 and 60),
  mobile               text not null unique check (mobile ~ '^[6-9][0-9]{9}$'),
  email                text not null,
  state                text check (state in ('Andhra Pradesh','Assam','Bihar','Chhattisgarh','Delhi','Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Odisha','Punjab','Rajasthan','Tamil Nadu','Telangana','Uttar Pradesh','Uttarakhand','West Bengal')),
  username             text check (username ~ '^[A-Za-z][A-Za-z0-9_.]{2,29}$'),
  role                 text not null default 'retailer' check (role in ('retailer','admin')),
  wallet               integer not null default 0 check (wallet >= 0),   -- main wallet, whole rupees
  earn                 integer not null default 0 check (earn  >= 0),   -- earnings wallet
  referral_code        text unique,
  referred_by          uuid references public.profiles(id),
  referral_paid        boolean not null default false,
  mobile_verified      boolean not null default false,
  disabled             boolean not null default false,
  must_change_password boolean not null default false,
  created_at           timestamptz not null default now()
);
create unique index profiles_email_key    on public.profiles (lower(email));
create unique index profiles_username_key on public.profiles (lower(username)) where username is not null;

-- Service catalogue (prices decided here, never by the page)
create table public.services (
  id        serial primary key,
  category  text not null,
  name      text not null,
  fee       integer not null check (fee > 0),
  active    boolean not null default true,
  sort      integer not null default 0,
  unique (category, name)
);

-- Public site settings (announcement, UPI id, limits ...). Nothing secret here.
create table public.app_settings (
  key   text primary key,
  value text not null
);

create table public.payments (
  id           text primary key,                              -- PAY1001
  user_id      uuid not null references public.profiles(id),
  amount       integer not null check (amount > 0),
  status       text not null check (status in ('Pending','Verifying','Success','Rejected','Cancelled')),
  utr          text unique check (utr ~ '^[0-9]{12}$'),
  created_at   timestamptz not null default now(),
  submitted_at timestamptz,
  decided_at   timestamptz,
  decided_by   uuid references public.profiles(id)
);
create index on public.payments (user_id);
create index on public.payments (status);

-- Wallet ledger (every rupee movement)
create table public.wallet_transactions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id),
  wallet      text not null check (wallet in ('main','earn')),
  amount      integer not null,                               -- negative = debit
  kind        text not null check (kind in ('recharge','admin_credit','application_fee','commission','refund','referral_bonus','transfer')),
  description text not null,
  created_at  timestamptz not null default now()
);
create index on public.wallet_transactions (user_id, id desc);

create table public.applications (
  id               text primary key,                          -- SSS-100001
  owner_id         uuid not null references public.profiles(id),
  service_id       integer references public.services(id),
  category         text not null,                             -- snapshot at time of order
  service_name     text not null,
  fee              integer not null,
  commission       integer not null,
  customer_name    text not null,
  customer_mobile  text not null check (customer_mobile ~ '^[6-9][0-9]{9}$'),
  note             text,
  status           text not null default 'Received' check (status in ('Received','In process','Completed','Rejected')),
  commission_paid  boolean not null default false,
  refunded         boolean not null default false,
  created_at       timestamptz not null default now()
);
create index on public.applications (owner_id, created_at desc);
create index on public.applications (status);

create table public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  message    text not null,
  sms_text   text,                       -- if set, the send-sms Edge Function texts it
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.notifications (user_id, id desc);

create table public.agents (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name       text not null check (char_length(name) between 2 and 60),
  mobile     text not null check (mobile ~ '^[6-9][0-9]{9}$')
);

create table public.tickets (
  id          text primary key,                               -- TK1001
  user_id     uuid not null references public.profiles(id),
  topic       text not null check (topic in ('Payment issue','Application delay','Technical problem','Other')),
  message     text not null check (char_length(message) between 5 and 300),
  status      text not null default 'Open' check (status in ('Open','Resolved')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index on public.tickets (user_id);

create table public.password_reset_requests (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  status      text not null default 'Open' check (status in ('Open','Done','Dismissed')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id)
);

create table public.sms_log (
  id         bigint generated always as identity primary key,
  to_mobile  text,
  type       text,
  text       text,
  status     text,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid,
  action     text not null,
  detail     text,
  created_at timestamptz not null default now()
);

-- =====================================================================
-- 2. HELPER FUNCTIONS (private schema, not exposed through the API)
-- =====================================================================

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and not disabled)
$$;

create or replace function private.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and not disabled and not must_change_password)
$$;

create or replace function private.require_retailer() returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from public.profiles
      where id = auth.uid() and role = 'retailer' and not disabled and not must_change_password) then
    raise exception 'This action is for active retailer accounts.' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

create or replace function private.require_admin() returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if not private.is_admin() then raise exception 'Admin only.' using errcode = '42501'; end if;
  return auth.uid();
end $$;

create or replace function private.setting_int(p_key text, p_default int) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select value::int from public.app_settings where key = p_key), p_default)
$$;

create or replace function private.notify(p_uid uuid, p_msg text, p_sms text default null) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications(user_id, message, sms_text) values (p_uid, p_msg, p_sms)
$$;

create or replace function private.audit(p_actor uuid, p_action text, p_detail text default '') returns void
language sql security definer set search_path = public as $$
  insert into public.audit_log(actor_id, action, detail) values (p_actor, p_action, p_detail)
$$;

create or replace function private.add_tx(p_uid uuid, p_wallet text, p_amt int, p_kind text, p_descr text) returns void
language sql security definer set search_path = public as $$
  insert into public.wallet_transactions(user_id, wallet, amount, kind, description) values (p_uid, p_wallet, p_amt, p_kind, p_descr)
$$;

create or replace function private.credit(p_uid uuid, p_wallet text, p_amt int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_wallet = 'main' then update public.profiles set wallet = wallet + p_amt where id = p_uid;
  else                      update public.profiles set earn   = earn   + p_amt where id = p_uid; end if;
end $$;

-- returns false instead of going below zero
create or replace function private.debit(p_uid uuid, p_wallet text, p_amt int) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_wallet = 'main' then update public.profiles set wallet = wallet - p_amt where id = p_uid and wallet >= p_amt;
  else                      update public.profiles set earn   = earn   - p_amt where id = p_uid and earn   >= p_amt; end if;
  return found;
end $$;

-- =====================================================================
-- 3. SIGN-UP TRIGGER  (replaces POST /api/register)
--    Client calls supabase.auth.signUp({ email, password,
--      options:{ data:{ name, mobile, state, referral } } })
-- =====================================================================
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare
  m      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_code text  := upper(nullif(trim(m->>'referral'), ''));
  v_ref  uuid;
begin
  if v_code is not null then
    select id into v_ref from public.profiles where referral_code = v_code and role = 'retailer';
    if v_ref is null then raise exception 'Invalid referral code.'; end if;
  end if;
  -- role is NEVER read from metadata: everyone starts as a retailer
  insert into public.profiles(id, name, mobile, email, state, referral_code, referred_by)
  values (new.id, trim(m->>'name'), m->>'mobile', lower(new.email), m->>'state',
          'SSS' || nextval('private.seq_retailer'), v_ref);
  if v_ref is not null then
    perform private.notify(v_ref, trim(m->>'name') || ' registered with your code. You earn ₹10 when they make their first wallet recharge.');
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- max 20 agents per retailer
create or replace function private.limit_agents() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.agents where user_id = new.user_id) >= 20 then
    raise exception 'You can add up to 20 agents.';
  end if;
  return new;
end $$;
create trigger agents_limit before insert on public.agents for each row execute function private.limit_agents();

-- =====================================================================
-- 4. RPC FUNCTIONS  (called with supabase.rpc('name', {...}))
-- =====================================================================

-- ---- wallet recharge ----
create or replace function public.create_payment(p_amount int) returns text
language plpgsql security definer set search_path = public, private as $$
declare uid uuid := private.require_retailer(); mn int := private.setting_int('min_recharge',300); mx int := private.setting_int('max_recharge',50000); v_id text;
begin
  if p_amount is null or p_amount < mn or p_amount > mx then
    raise exception 'Enter a whole-rupee amount between ₹% and ₹%.', mn, mx;
  end if;
  if (select count(*) from payments where user_id = uid and status = 'Pending') >= 5 then
    raise exception 'You have too many unfinished payments. Complete or cancel them first.';
  end if;
  v_id := 'PAY' || nextval('private.seq_payment');
  insert into payments(id, user_id, amount, status) values (v_id, uid, p_amount, 'Pending');
  return v_id;
end $$;

create or replace function public.submit_utr(p_payment_id text, p_utr text) returns void
language plpgsql security definer set search_path = public, private as $$
declare uid uuid := private.require_retailer(); p payments;
begin
  if p_utr !~ '^[0-9]{12}$' then raise exception 'Enter the 12-digit UTR from your payment app.'; end if;
  select * into p from payments where id = p_payment_id and user_id = uid for update;
  if not found then raise exception 'Payment not found.'; end if;
  if p.status <> 'Pending' then raise exception 'This payment can no longer be changed.'; end if;
  begin
    update payments set status = 'Verifying', utr = p_utr, submitted_at = now() where id = p.id;
  exception when unique_violation then
    raise exception 'This UTR was already submitted.';
  end;
  perform private.notify(uid, format('Payment %s of ₹%s submitted. Your wallet will be credited after verification.', p.id, p.amount));
end $$;

create or replace function public.cancel_payment(p_payment_id text) returns void
language plpgsql security definer set search_path = public, private as $$
declare uid uuid := private.require_retailer();
begin
  update payments set status = 'Cancelled', decided_at = now()
   where id = p_payment_id and user_id = uid and status = 'Pending';
end $$;

create or replace function public.admin_decide_payment(p_payment_id text, p_approve boolean) returns void
language plpgsql security definer set search_path = public, private as $$
declare adm uuid := private.require_admin(); p payments; ru profiles; bonus int := private.setting_int('referral_bonus',10);
begin
  select * into p from payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found.'; end if;
  if p.status <> 'Verifying' then raise exception 'Only payments awaiting verification can be decided.'; end if;

  if p_approve then
    perform private.credit(p.user_id, 'main', p.amount);
    perform private.add_tx(p.user_id, 'main', p.amount, 'recharge', format('Wallet recharge via UPI (%s, UTR %s)', p.id, p.utr));
    perform private.notify(p.user_id, format('₹%s added to your wallet.', p.amount),
                           format('Shri Sai Seva One: Rs %s added to your wallet. Ref %s.', p.amount, p.utr));
    select * into ru from profiles where id = p.user_id for update;
    if ru.referred_by is not null and not ru.referral_paid
       and exists (select 1 from profiles where id = ru.referred_by and role = 'retailer' and not disabled) then
      perform private.credit(ru.referred_by, 'earn', bonus);
      perform private.add_tx(ru.referred_by, 'earn', bonus, 'referral_bonus', 'Referral bonus – ' || ru.name);
      perform private.notify(ru.referred_by, format('%s made their first recharge. ₹%s added to your Earnings wallet.', ru.name, bonus));
      update profiles set referral_paid = true where id = ru.id;
    end if;
  else
    perform private.notify(p.user_id, format('Payment %s could not be verified. Please contact support.', p.id),
                           format('Shri Sai Seva One: Payment %s could not be verified. Contact support.', p.id));
  end if;

  update payments set status = case when p_approve then 'Success' else 'Rejected' end,
                      decided_at = now(), decided_by = adm where id = p.id;
  perform private.audit(adm, case when p_approve then 'payment_approved' else 'payment_rejected' end,
                        format('%s %s %s UTR %s', p.id, p.user_id, p.amount, p.utr));
end $$;

create or replace function public.admin_add_funds(p_user uuid, p_amount int, p_note text) returns void
language plpgsql security definer set search_path = public, private as $$
declare adm uuid := private.require_admin(); u profiles;
begin
  if p_amount is null or p_amount < 1 or p_amount > 100000 then raise exception 'Enter a whole-rupee amount between ₹1 and ₹1,00,000.'; end if;
  if char_length(coalesce(trim(p_note),'')) < 3 then raise exception 'Please enter a reason.'; end if;
  select * into u from profiles where id = p_user and role = 'retailer' for update;
  if not found then raise exception 'Retailer not found.'; end if;
  perform private.credit(u.id, 'main', p_amount);
  perform private.add_tx(u.id, 'main', p_amount, 'admin_credit', 'Funds added by admin: ' || trim(p_note));
  perform private.notify(u.id, format('₹%s added to your wallet by admin.', p_amount));
  perform private.audit(adm, 'funds_added', format('%s %s ₹%s – %s', u.id, u.name, p_amount, trim(p_note)));
end $$;

create or replace function public.move_earnings() returns int
language plpgsql security definer set search_path = public, private as $$
declare uid uuid := private.require_retailer(); e int;
begin
  select earn into e from profiles where id = uid for update;
  if not (e > 0) then raise exception 'No earnings to move yet.'; end if;
  perform private.debit(uid, 'earn', e);
  perform private.credit(uid, 'main', e);
  perform private.add_tx(uid, 'earn', -e, 'transfer', 'Moved to main wallet');
  perform private.add_tx(uid, 'main',  e, 'transfer', 'From earnings wallet');
  return e;
end $$;

-- ---- applications ----
create or replace function public.submit_application(p_service_id int, p_customer_name text, p_customer_mobile text, p_note text default '') returns text
language plpgsql security definer set search_path = public, private as $$
declare uid uuid := private.require_retailer(); s services; v_id text; v_comm int;
begin
  select * into s from services where id = p_service_id and active;
  if not found then raise exception 'Unknown service.'; end if;
  if p_customer_name !~ '^[^<>[:cntrl:]]{2,60}$' then raise exception 'Enter a valid customer name.'; end if;
  if p_customer_mobile !~ '^[6-9][0-9]{9}$' then raise exception 'Enter a valid 10-digit customer mobile number.'; end if;
  if p_note ~ '[<>[:cntrl:]]' then raise exception 'Remarks contain characters that are not allowed.'; end if;
  v_comm := round(s.fee * private.setting_int('commission_percent',10) / 100.0);
  if not private.debit(uid, 'main', s.fee) then
    raise exception 'Insufficient wallet balance.' using hint = 'LOW_BALANCE';
  end if;
  v_id := 'SSS-' || nextval('private.seq_application');
  insert into applications(id, owner_id, service_id, category, service_name, fee, commission, customer_name, customer_mobile, note)
  values (v_id, uid, s.id, s.category, s.name, s.fee, v_comm, trim(p_customer_name), p_customer_mobile, left(trim(coalesce(p_note,'')),120));
  perform private.add_tx(uid, 'main', -s.fee, 'application_fee', format('Applied: %s (%s)', s.name, v_id));
  perform private.notify(uid, format('Application %s submitted for %s.', v_id, s.name),
                         format('Shri Sai Seva One: Application %s for %s received. Fee Rs %s debited.', v_id, s.name, s.fee));
  return v_id;
end $$;

create or replace function public.admin_set_application_status(p_app_id text, p_status text) returns void
language plpgsql security definer set search_path = public, private as $$
declare adm uuid := private.require_admin(); a applications;
begin
  if p_status not in ('Received','In process','Completed','Rejected') then raise exception 'Invalid status.'; end if;
  select * into a from applications where id = p_app_id for update;
  if not found then raise exception 'Application not found.'; end if;
  if a.status in ('Completed','Rejected') then raise exception 'This application is already closed.'; end if;
  if p_status = a.status then return; end if;
  if p_status = 'Received' then raise exception 'An application cannot go back to Received.'; end if;

  if p_status = 'Completed' and not a.commission_paid then
    perform private.credit(a.owner_id, 'earn', a.commission);
    perform private.add_tx(a.owner_id, 'earn', a.commission, 'commission', 'Commission – ' || a.id);
    perform private.notify(a.owner_id, format('%s completed. ₹%s commission added.', a.id, a.commission));
    update applications set commission_paid = true where id = a.id;
  elsif p_status = 'Rejected' and not a.refunded then
    perform private.credit(a.owner_id, 'main', a.fee);
    perform private.add_tx(a.owner_id, 'main', a.fee, 'refund', 'Refund – ' || a.id);
    perform private.notify(a.owner_id, format('%s was rejected. ₹%s refunded.', a.id, a.fee));
    update applications set refunded = true where id = a.id;
  else
    perform private.notify(a.owner_id, format('%s is now %s.', a.id, p_status));
  end if;
  update applications set status = p_status where id = a.id;
  -- SMS for every status change
  update notifications set sms_text = format('Shri Sai Seva One: Application %s is now %s.', a.id, p_status)
   where id = (select max(id) from notifications where user_id = a.owner_id);
  perform private.audit(adm, 'application_status', format('%s %s->%s', a.id, a.status, p_status));
end $$;

-- ---- support, notifications, agents ----
create or replace function public.create_ticket(p_topic text, p_message text) returns text
language plpgsql security definer set search_path = public, private as $$
declare uid uuid := private.require_retailer(); v_id text;
begin
  if p_topic not in ('Payment issue','Application delay','Technical problem','Other') then raise exception 'Choose a topic.'; end if;
  if char_length(trim(coalesce(p_message,''))) not between 5 and 300 then raise exception 'Message must be 5–300 characters.'; end if;
  if (select count(*) from tickets where user_id = uid and status = 'Open') >= 10 then
    raise exception 'You already have many open tickets. Please wait for a reply.';
  end if;
  v_id := 'TK' || nextval('private.seq_ticket');
  insert into tickets(id, user_id, topic, message) values (v_id, uid, p_topic, trim(p_message));
  return v_id;
end $$;

create or replace function public.admin_resolve_ticket(p_ticket_id text) returns void
language plpgsql security definer set search_path = public, private as $$
declare adm uuid := private.require_admin(); t tickets;
begin
  select * into t from tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ticket not found.'; end if;
  if t.status = 'Open' then
    update tickets set status = 'Resolved', resolved_at = now() where id = t.id;
    perform private.notify(t.user_id, format('Support ticket %s has been resolved.', t.id));
    perform private.audit(adm, 'ticket_resolved', t.id);
  end if;
end $$;

create or replace function public.mark_notifications_read() returns void
language sql security definer set search_path = public as $$
  update public.notifications set is_read = true where user_id = auth.uid()
$$;

create or replace function public.my_referral_count() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.profiles where referred_by = auth.uid()
$$;

-- ---- admin: users, announcement, resets ----
create or replace function public.admin_set_user_disabled(p_user uuid, p_disabled boolean, p_reason text default '') returns void
language plpgsql security definer set search_path = public, private as $$
declare adm uuid := private.require_admin(); u profiles;
begin
  if p_disabled and char_length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Please enter a reason.'; end if;
  select * into u from profiles where id = p_user and role = 'retailer' for update;
  if not found then raise exception 'Retailer not found.'; end if;
  update profiles set disabled = p_disabled where id = u.id;
  perform private.audit(adm, case when p_disabled then 'user_disabled' else 'user_enabled' end,
                        u.id || ' ' || u.name || case when p_reason <> '' then ' – ' || p_reason else '' end);
  -- NOTE: the admin-user-status Edge Function also bans/unbans the user in Auth so existing sessions die.
end $$;

create or replace function public.admin_set_announcement(p_text text) returns void
language plpgsql security definer set search_path = public, private as $$
declare adm uuid := private.require_admin();
begin
  if char_length(trim(coalesce(p_text,''))) not between 1 and 200 then raise exception 'Announcement must be 1–200 characters.'; end if;
  insert into app_settings(key, value) values ('announcement', trim(p_text))
    on conflict (key) do update set value = excluded.value;
  perform private.audit(adm, 'announcement', left(p_text, 60));
end $$;

create or replace function public.admin_dismiss_reset(p_request_id bigint) returns void
language plpgsql security definer set search_path = public, private as $$
declare adm uuid := private.require_admin(); q password_reset_requests;
begin
  select * into q from password_reset_requests where id = p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if q.status = 'Open' then
    update password_reset_requests set status = 'Dismissed', resolved_at = now(), resolved_by = adm where id = q.id;
    perform private.audit(adm, 'password_reset_dismissed', q.user_id::text);
  end if;
end $$;

-- ---- admin: reports (same numbers as GET /api/admin/reports) ----
create or replace function public.admin_report(p_from date, p_to date) returns jsonb
language plpgsql security definer stable set search_path = public, private as $$
declare
  t0 timestamptz := p_from::timestamp at time zone 'Asia/Kolkata';
  t1 timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Kolkata';
  rech record; by_status jsonb; revenue int; refunds int; comm int; ref_bonus int; daily jsonb; lb record;
begin
  perform private.require_admin();
  if p_to < p_from or p_to - p_from > 366 then raise exception 'Choose a valid date range of up to 366 days.'; end if;

  select coalesce(sum(amount),0) a, count(*) c into rech from payments where status='Success' and decided_at >= t0 and decided_at < t1;
  select coalesce(jsonb_object_agg(status, c),'{}') into by_status
    from (select status, count(*) c from applications where created_at >= t0 and created_at < t1 group by status) s;
  select coalesce(sum(fee) filter (where status <> 'Rejected'),0), coalesce(sum(fee) filter (where status = 'Rejected'),0)
    into revenue, refunds from applications where created_at >= t0 and created_at < t1;
  select coalesce(sum(amount),0) into comm      from wallet_transactions where kind='commission'     and created_at >= t0 and created_at < t1;
  select coalesce(sum(amount),0) into ref_bonus from wallet_transactions where kind='referral_bonus'  and created_at >= t0 and created_at < t1;

  select coalesce(jsonb_agg(jsonb_build_object('d', d::date, 'recharge', coalesce(r.a,0), 'revenue', coalesce(v.a,0)) order by d), '[]')
    into daily
    from generate_series(p_from, p_to, interval '1 day') d
    left join (select (decided_at at time zone 'Asia/Kolkata')::date as dy, sum(amount) a from payments
                where status='Success' and decided_at >= t0 and decided_at < t1 group by 1) r on r.dy = d::date
    left join (select (created_at at time zone 'Asia/Kolkata')::date as dy, sum(fee) a from applications
                where status<>'Rejected' and created_at >= t0 and created_at < t1 group by 1) v on v.dy = d::date;

  select coalesce(sum(wallet),0) w, coalesce(sum(earn),0) e, count(*) n, count(*) filter (where disabled) dis into lb
    from profiles where role='retailer';

  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'recharges', jsonb_build_object('amount', rech.a, 'count', rech.c),
    'revenue', revenue, 'refunds', refunds, 'commission', comm, 'referralBonus', ref_bonus,
    'newRetailers', (select count(*) from profiles where role='retailer' and created_at >= t0 and created_at < t1),
    'appsByStatus', by_status,
    'appsTotal', (select coalesce(sum(value::int),0) from jsonb_each_text(by_status)),
    'topServices', (select coalesce(jsonb_agg(x),'[]') from (
        select service_name as name, count(*) as count, sum(fee) as fee from applications
         where status<>'Rejected' and created_at >= t0 and created_at < t1
         group by service_name order by sum(fee) desc, count(*) desc limit 10) x),
    'topRetailers', (select coalesce(jsonb_agg(x),'[]') from (
        select p.name, count(*) as count, sum(a.fee) as fee from applications a join profiles p on p.id = a.owner_id
         where a.status<>'Rejected' and a.created_at >= t0 and a.created_at < t1
         group by p.id, p.name order by sum(a.fee) desc limit 10) x),
    'daily', daily,
    'liabilities', jsonb_build_object('wallets', lb.w, 'earnings', lb.e, 'retailers', lb.n, 'disabled', lb.dis),
    'waiting', jsonb_build_object(
        'payments',     (select count(*) from payments where status='Verifying'),
        'applications', (select count(*) from applications where status in ('Received','In process')),
        'tickets',      (select count(*) from tickets where status='Open'))
  );
end $$;

-- =====================================================================
-- 5. ROW LEVEL SECURITY
--    Rule: users can READ their own rows. All money / status changes go
--    through the functions above. Nobody can write money tables directly.
-- =====================================================================
alter table public.profiles                enable row level security;
alter table public.services                enable row level security;
alter table public.app_settings            enable row level security;
alter table public.payments                enable row level security;
alter table public.wallet_transactions     enable row level security;
alter table public.applications            enable row level security;
alter table public.notifications           enable row level security;
alter table public.agents                  enable row level security;
alter table public.tickets                 enable row level security;
alter table public.password_reset_requests enable row level security;
alter table public.sms_log                 enable row level security;
alter table public.audit_log               enable row level security;

-- start from zero write access, then grant only what is needed
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_admin(), private.is_active() to authenticated;

grant select on public.services, public.app_settings to anon, authenticated;
grant select on public.profiles, public.payments, public.wallet_transactions, public.applications,
                public.notifications, public.agents, public.tickets,
                public.password_reset_requests, public.sms_log, public.audit_log to authenticated;
grant update (name, state, username) on public.profiles to authenticated;   -- NOT wallet / role / disabled
grant insert, delete on public.agents to authenticated;
grant insert, update on public.services, public.app_settings to authenticated;  -- gated to admin by policy
grant usage, select on sequence public.services_id_seq to authenticated;
grant execute on all functions in schema public to authenticated;

-- profiles
create policy "own profile"        on public.profiles for select to authenticated using (id = auth.uid() or private.is_admin());
create policy "edit own profile"   on public.profiles for update to authenticated using (id = auth.uid() and private.is_active()) with check (id = auth.uid());
-- catalogue + settings
create policy "read services"      on public.services for select to anon, authenticated using (active or private.is_admin());
create policy "admin services"     on public.services for insert to authenticated with check (private.is_admin());
create policy "admin services upd" on public.services for update to authenticated using (private.is_admin());
create policy "read settings"      on public.app_settings for select to anon, authenticated using (true);
create policy "admin settings"     on public.app_settings for insert to authenticated with check (private.is_admin());
create policy "admin settings upd" on public.app_settings for update to authenticated using (private.is_admin());
-- own-or-admin read tables
create policy "own payments"       on public.payments            for select to authenticated using (user_id  = auth.uid() or private.is_admin());
create policy "own transactions"   on public.wallet_transactions for select to authenticated using (user_id  = auth.uid() or private.is_admin());
create policy "own applications"   on public.applications       for select to authenticated using (owner_id = auth.uid() or private.is_admin());
create policy "own tickets"        on public.tickets             for select to authenticated using (user_id  = auth.uid() or private.is_admin());
create policy "own notifications"  on public.notifications       for select to authenticated using (user_id  = auth.uid());
-- agents (direct insert/delete is safe: scoped to self)
create policy "own agents"         on public.agents for select to authenticated using (user_id = auth.uid());
create policy "add own agent"      on public.agents for insert to authenticated with check (user_id = auth.uid() and private.is_active());
create policy "delete own agent"   on public.agents for delete to authenticated using (user_id = auth.uid());
-- admin-only
create policy "admin resets"       on public.password_reset_requests for select to authenticated using (private.is_admin());
create policy "admin sms log"      on public.sms_log   for select to authenticated using (private.is_admin());
create policy "admin audit"        on public.audit_log for select to authenticated using (private.is_admin());

-- live updates in the page (wallet balance, notifications, application status)
alter publication supabase_realtime add table public.profiles, public.notifications, public.applications, public.payments;

-- =====================================================================
-- 6. SEED DATA
-- =====================================================================
insert into public.app_settings(key, value) values
  ('announcement',''), ('upi_id','YOUR-UPI-ID@bank'), ('min_recharge','300'), ('max_recharge','50000'),
  ('referral_bonus','10'), ('commission_percent','10'),
  ('contact_email','YOUR-EMAIL'), ('contact_mobile','YOUR-MOBILE');

insert into public.services(category, name, fee, sort) values
 ('State','Income Certificate',60,1),('State','Caste Certificate',60,2),('State','Domicile Certificate',60,3),('State','Birth Certificate',50,4),
 ('State','Death Certificate',50,5),('State','Ration Card',80,6),('State','Land Records (RTC)',30,7),
 ('Govt','Ayushman Card',40,1),('Govt','Vehicle RC',250,2),('Govt','Driving Licence',350,3),('Govt','Voter ID',50,4),
 ('Govt','PM Kisan Registration',40,5),('Govt','e-Shram Card',30,6),('Govt','Passport Assistance',300,7),
 ('Print','Aadhaar Print',15,1),('Print','PAN Print',15,2),('Print','Voter ID Print',15,3),('Print','Ayushman Card Print',15,4),('Print','Document Lamination',10,5),
 ('AadhaarCorr','Name Correction',100,1),('AadhaarCorr','Address Update',75,2),('AadhaarCorr','Date of Birth Correction',150,3),
 ('AadhaarCorr','Mobile Number Update',75,4),('AadhaarCorr','Biometric Update',125,5),('AadhaarCorr','Download e-Aadhaar',10,6),
 ('PVCDel','Aadhaar PVC Delivery',60,1),('PVCDel','Voter PVC Delivery',60,2),('PVCDel','Driving Licence PVC Delivery',60,3),
 ('PVCMaker','Aadhaar PVC Card',50,1),('PVCMaker','PAN PVC Card',50,2),('PVCMaker','Driving Licence PVC Card',50,3),
 ('PVCMaker','Vehicle RC PVC Card',50,4),('PVCMaker','Ayushman PVC Card',50,5),
 ('PAN','New PAN Application',120,1),('PAN','PAN Correction',110,2),('PAN','Instant e-PAN',75,3),('PAN','PAN Reprint',50,4),('PAN','Link PAN with Aadhaar',30,5),
 ('Buy','Blank PVC Cards (10 pack)',250,1),('Buy','Fingerprint Scanner',2800,2),('Buy','Lamination Pouches (100)',300,3);

-- =====================================================================
-- 7. CREATE THE ADMIN  (do this AFTER running the file)
--  a) Dashboard > Authentication > Users > Add user (email + password),
--     with User Metadata:  {"name":"Administrator","mobile":"XXXXXXXXXX","state":"Karnataka"}
--  b) Then run:
--       update public.profiles set role='admin', mobile_verified=true
--        where lower(email) = lower('YOUR-ADMIN-EMAIL');
-- =====================================================================
