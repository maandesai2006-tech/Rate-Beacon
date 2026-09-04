-- What kind of property an account runs, what its plan allows, where public
-- enquiries land, and where background failures go.

-- Property type comes from the landing page and rides through sign-up. It is
-- informational today (copy, support) and the hook for anything that differs
-- by segment later.
alter table accounts add column if not exists property_type text
  check (property_type in ('franchised','independent','bnb','other'));
alter table accounts add column if not exists plan text not null default 'standard';

-- Limits live in a table, not in code, so changing a plan is a row edit and
-- a customer's ceiling is a query away.
create table if not exists plan_limits (
  plan            text primary key,
  max_profiles    integer not null,
  max_competitors integer not null,
  max_horizon     integer not null
);
insert into plan_limits (plan, max_profiles, max_competitors, max_horizon) values
  ('standard', 3, 15, 75),
  ('portfolio', 25, 20, 90)
on conflict (plan) do nothing;
alter table plan_limits enable row level security;
grant select on plan_limits to authenticated;
drop policy if exists plan_limits_read on plan_limits;
create policy plan_limits_read on plan_limits for select to authenticated using (true);

-- Enquiries from the public site. Server-only: written by the contact
-- endpoint, read by whoever answers them. There is no mail provider on the
-- deployment, so this is the record — not a copy of one.
create table if not exists leads (
  id            bigserial primary key,
  name          text,
  email         text not null,
  property_name text,
  property_type text,
  message       text,
  source        text,
  created_at    timestamptz not null default now(),
  handled_at    timestamptz
);
alter table leads enable row level security;

-- Somewhere errors go that is not a browser console. The background jobs run
-- with nobody watching; a customer's reports could stop arriving for a week
-- before anyone noticed. Written by the jobs, read by the system check.
create table if not exists app_errors (
  id          bigserial primary key,
  area        text not null,
  message     text not null,
  detail      text,
  account_id  bigint,
  occurred_at timestamptz not null default now()
);
create index if not exists app_errors_recent_idx on app_errors (occurred_at desc);
alter table app_errors enable row level security;
