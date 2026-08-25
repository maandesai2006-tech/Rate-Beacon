-- Tenant isolation, enforced by Postgres rather than by remembering.
--
-- Until now every route filtered by account_id by hand. That works exactly as
-- long as nobody ever forgets, on any route, forever — and the failure mode is
-- one hotel reading another's data. With one customer that is a latent bug;
-- with fifty it is a breach.
--
-- These policies move the rule into the database. The app connects with a JWT
-- carrying the account id, and Postgres refuses rows belonging to anyone else.
-- A forgotten filter then returns nothing instead of somebody else's data.
--
-- The service_role key bypasses RLS entirely, so enabling this changes nothing
-- until the app switches to the scoped client (SUPABASE_ANON_KEY and
-- SUPABASE_JWT_SECRET in the environment). That is deliberate: policies land
-- first, cutover second, and neither step can break the other alone.

create or replace function app_account_id() returns bigint
language sql stable as $$
  select nullif(
    coalesce(current_setting('request.jwt.claims', true)::json ->> 'account_id', ''),
    ''
  )::bigint
$$;

create or replace function app_profile_ids() returns setof bigint
language sql stable as $$
  select id from profiles where account_id = app_account_id()
$$;

alter table accounts enable row level security;
drop policy if exists accounts_own on accounts;
create policy accounts_own on accounts
  for all to authenticated
  using (id = app_account_id())
  with check (id = app_account_id());

alter table sessions enable row level security;
drop policy if exists sessions_own on sessions;
create policy sessions_own on sessions
  for all to authenticated
  using (account_id = app_account_id())
  with check (account_id = app_account_id());

alter table profiles enable row level security;
drop policy if exists profiles_own on profiles;
create policy profiles_own on profiles
  for all to authenticated
  using (account_id = app_account_id())
  with check (account_id = app_account_id());

-- Everything hanging off a profile follows the same rule, so it is written
-- once rather than fifteen times.
do $$
declare t text;
begin
  foreach t in array array[
    'profile_hotels','baseline_comps','my_rates','manager_reports',
    'daily_manager_reports','email_sources','report_sources',
    'report_inboxes','map_places','events'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_own', t);
    execute format(
      'create policy %I on %I for all to authenticated
         using (profile_id in (select app_profile_ids()))
         with check (profile_id in (select app_profile_ids()))',
      t || '_own', t
    );
  end loop;
end $$;

-- Two tables reach their profile through their parent report.
alter table report_metrics enable row level security;
drop policy if exists report_metrics_own on report_metrics;
create policy report_metrics_own on report_metrics
  for all to authenticated
  using (report_id in (select id from manager_reports where profile_id in (select app_profile_ids())))
  with check (report_id in (select id from manager_reports where profile_id in (select app_profile_ids())));

alter table daily_insights enable row level security;
drop policy if exists daily_insights_own on daily_insights;
create policy daily_insights_own on daily_insights
  for all to authenticated
  using (report_id in (select id from daily_manager_reports where profile_id in (select app_profile_ids())))
  with check (report_id in (select id from daily_manager_reports where profile_id in (select app_profile_ids())));

-- Shared market facts: hotel names, coordinates and published rates are
-- collected once and read by everyone, which is most of why this is cheap to
-- run. Readable by any signed-in request, writable only by the server.
do $$
declare t text;
begin
  foreach t in array array['hotels','hotel_directory','rate_snapshots'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- latest_rates is a view, so it cannot carry policies of its own. Running it
-- as the invoker makes it obey rate_snapshots' policy instead of the owner's
-- privileges, which is the behaviour we want and not the default.
alter view latest_rates set (security_invoker = true);

-- Anything unnamed above has no policy for authenticated, which means no rows:
-- settings and api_settings stay server-only.
alter table settings enable row level security;
alter table api_settings enable row level security;

-- ── Grants ───────────────────────────────────────────────────────────────
-- Policies decide which rows; grants decide whether the role can reach the
-- table at all. Without these the scoped client sees "permission denied"
-- rather than a filtered result, so both halves have to land together.
--
-- The grant is deliberately wide and the policy deliberately narrow: the role
-- may touch these tables, and row-level security decides that it only ever
-- touches its own rows.
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','profile_hotels','baseline_comps','my_rates','manager_reports',
    'report_metrics','daily_manager_reports','daily_insights','email_sources',
    'report_sources','report_inboxes','map_places','events','accounts','sessions'
  ] loop
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

-- Shared market facts are read-only to a customer: collected once by the
-- server, read by everyone.
grant select on hotels, hotel_directory, rate_snapshots, latest_rates to authenticated;

-- Inserts need the sequences behind bigserial keys.
grant usage, select on all sequences in schema public to authenticated;

-- settings and api_settings are intentionally omitted: no grant, no access,
-- regardless of policy.
