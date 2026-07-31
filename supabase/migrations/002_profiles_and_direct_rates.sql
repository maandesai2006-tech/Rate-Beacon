-- Profiles: one per tracked "baseline" hotel, each with its own competitor
-- set. Replaces the single-market `settings` row (kept for back-compat but
-- no longer read). Also: store the full OTA quote list per snapshot and a
-- brand-direct rate alongside the cheapest one.

create table if not exists profiles (
  id bigint generated always as identity primary key,
  name text not null,
  hotel_name text,
  city_code text,
  city_name text,
  currency text not null default 'USD',
  horizon_days int not null default 45 check (horizon_days between 7 and 120),
  adults int not null default 2,
  notes text,
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;

create table if not exists profile_hotels (
  profile_id bigint not null references profiles(id) on delete cascade,
  hotel_id text not null references hotels(hotel_id) on delete cascade,
  is_mine boolean not null default false,
  primary key (profile_id, hotel_id)
);
alter table profile_hotels enable row level security;

alter table rate_snapshots add column if not exists offers jsonb;
alter table rate_snapshots add column if not exists price_low numeric;
alter table rate_snapshots add column if not exists rate_source text;

-- Migrate the legacy single-market setup into profile #1.
insert into profiles (name, hotel_name, city_code, city_name, currency, horizon_days, adults)
select coalesce(s.hotel_name, 'My hotel'), s.hotel_name, s.city_code, s.city_name,
       s.currency, s.horizon_days, s.adults
from settings s
where s.id = 1 and not exists (select 1 from profiles);

insert into profile_hotels (profile_id, hotel_id, is_mine)
select (select min(id) from profiles), h.hotel_id, h.is_mine
from hotels h
where exists (select 1 from profiles)
on conflict do nothing;

alter table my_rates add column if not exists profile_id bigint;
update my_rates set profile_id = (select min(id) from profiles) where profile_id is null;
alter table my_rates alter column profile_id set not null;
alter table my_rates drop constraint if exists my_rates_pkey;
alter table my_rates add primary key (profile_id, check_in);

-- Extend the latest-rate view with the new columns (appended, so
-- create-or-replace is allowed).
create or replace view latest_rates as
  select distinct on (hotel_id, check_in)
    hotel_id, check_in, price, currency, available, room_desc, captured_on,
    price_low, rate_source, offers
  from rate_snapshots
  order by hotel_id, check_in, captured_on desc;
alter view latest_rates set (security_invoker = on);
