-- Hotels enter a profile in one of three roles:
--   baseline — one of the operator's own hotels
--   comp     — a tracked competitor of some baseline (full rate horizon)
--   map      — nearby context for the map only (short rate horizon)
-- Competitor sets are discovered from data (location listing + geocoded
-- distance), never hand-authored, so the same pipeline works for any hotel.

alter table profile_hotels
  add column if not exists role text not null default 'comp'
  check (role in ('baseline', 'comp', 'map'));

update profile_hotels set role = 'baseline' where is_mine and role <> 'baseline';

-- Distance (km) from the baseline that selected this competitor, recorded by
-- the discovery run so the UI can explain why a hotel is in the set.
alter table baseline_comps
  add column if not exists distance_km double precision;
alter table baseline_comps
  add column if not exists discovered_at timestamptz;

-- Every hotel ever seen in a location listing, so discovery can rank by
-- proximity without re-listing on each run.
create table if not exists hotel_directory (
  hotel_id text primary key,
  location_key text not null,
  name text not null,
  latitude double precision,
  longitude double precision,
  geo_attempted_at timestamptz,
  seen_at timestamptz not null default now()
);
create index if not exists hotel_directory_location_idx
  on hotel_directory (location_key);
alter table hotel_directory enable row level security;
