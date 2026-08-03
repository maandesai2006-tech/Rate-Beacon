-- Several baseline ("mine") hotels can live in one profile, each with its own
-- competitor set (sets may overlap). Hotels also carry coordinates so the map
-- view can plot rates spatially.

create table if not exists baseline_comps (
  profile_id bigint not null references profiles(id) on delete cascade,
  baseline_hotel_id text not null references hotels(hotel_id) on delete cascade,
  comp_hotel_id text not null references hotels(hotel_id) on delete cascade,
  primary key (profile_id, baseline_hotel_id, comp_hotel_id)
);
create index if not exists baseline_comps_lookup_idx
  on baseline_comps (profile_id, baseline_hotel_id);
alter table baseline_comps enable row level security;

alter table hotels add column if not exists geo_updated_at timestamptz;
alter table hotels add column if not exists address text;

-- Seed from the existing single-baseline layout: every non-mine hotel in the
-- profile becomes a competitor of the profile's current baseline.
insert into baseline_comps (profile_id, baseline_hotel_id, comp_hotel_id)
select b.profile_id, b.hotel_id, c.hotel_id
from profile_hotels b
join profile_hotels c
  on c.profile_id = b.profile_id and not c.is_mine and c.hotel_id <> b.hotel_id
where b.is_mine
on conflict do nothing;
