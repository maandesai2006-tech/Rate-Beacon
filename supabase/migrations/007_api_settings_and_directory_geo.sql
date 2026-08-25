-- Learned facts about upstream APIs whose accepted shape is not documented.
-- Small, server-only, and never user-editable.
create table if not exists api_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table api_settings enable row level security;
drop policy if exists api_settings_no_anon on api_settings;
create policy api_settings_no_anon on api_settings
  for all to anon, authenticated using (false) with check (false);

-- The directory is the search index: every hotel we have ever seen in a
-- market, with coordinates so a radius filter is a real query rather than a
-- guess. Coordinates may come from the listing itself or from geocoding.
alter table hotel_directory add column if not exists rating numeric;
alter table hotel_directory add column if not exists review_count integer;
alter table hotel_directory add column if not exists last_listed_at timestamptz;

create index if not exists hotel_directory_location_idx on hotel_directory (location_key);
create index if not exists hotel_directory_geo_idx on hotel_directory (latitude, longitude);
