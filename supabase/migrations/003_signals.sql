-- Demand-signal data: profile geo (weather/events lookups), hotel review
-- standing, and a local-events table refreshed by the daily cron.

alter table profiles add column if not exists latitude double precision;
alter table profiles add column if not exists longitude double precision;
alter table profiles add column if not exists country_code text not null default 'US';

alter table hotels add column if not exists rating numeric;
alter table hotels add column if not exists review_count int;
alter table hotels add column if not exists rating_updated_at timestamptz;

create table if not exists events (
  id bigint generated always as identity primary key,
  profile_id bigint not null references profiles(id) on delete cascade,
  event_date date not null,
  name text not null,
  venue text,
  category text,
  url text,
  fetched_at timestamptz not null default now(),
  unique (profile_id, event_date, name)
);
create index if not exists events_profile_date_idx on events (profile_id, event_date);
alter table events enable row level security;
