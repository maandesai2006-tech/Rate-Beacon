-- Minimal predecessor schema for an isolated local forecast-migration test.
-- DO NOT run against an application database. Full historical migrations in
-- this repository do not include the original accounts schema bootstrap.
create role anon;
create role authenticated;
create role service_role bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create table public.accounts (
  id bigserial primary key, email text unique not null,
  password_hash text not null, password_salt text not null
);
create table public.profiles (
  id bigserial primary key, name text not null,
  account_id bigint references public.accounts(id) on delete cascade
);
create table public.hotels (hotel_id text primary key, name text not null);
create table public.profile_hotels (
  profile_id bigint references public.profiles(id) on delete cascade,
  hotel_id text references public.hotels(hotel_id), is_mine boolean default false,
  primary key (profile_id,hotel_id)
);
create table public.collection_runs (run_date date primary key, finished_at timestamptz);
-- Same account-identity and profile policies as migrations 008/009.
create function public.app_account_id() returns bigint language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claims', true)::json ->> 'account_id',
    current_setting('request.jwt.claims', true)::json -> 'app_metadata' ->> 'account_id', ''
  ), '')::bigint
$$;
create function public.app_profile_ids() returns setof bigint language sql stable as $$
  select id from public.profiles where account_id = public.app_account_id()
$$;
alter table public.profiles enable row level security;
create policy profiles_own on public.profiles for all to authenticated
  using (account_id = public.app_account_id()) with check (account_id = public.app_account_id());
grant select on public.profiles to authenticated;
grant all on public.profiles, public.profile_hotels, public.hotels, public.accounts to service_role;
