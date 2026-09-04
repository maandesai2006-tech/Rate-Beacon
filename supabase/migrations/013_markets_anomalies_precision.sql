-- Market scope, rate anomalies, and how precisely a hotel has been placed.

-- Exactly, or only to its town. A town-level position is enough for the
-- forecast and for telling Destin from Pensacola; the radius search knows not
-- to trust it to the mile.
alter table hotels add column if not exists geo_precision text
  check (geo_precision in ('hotel','city'));
update hotels set geo_precision = 'hotel' where latitude is not null and geo_precision is null;

-- The radius a profile considers "its market", in miles.
alter table profiles add column if not exists compset_radius_miles integer not null default 15;

-- A rate far above the hotel's own recent level: a scraping error or a real
-- event, and either way something a revenue manager should see flagged rather
-- than absorbed into the median.
alter table rate_snapshots add column if not exists is_anomaly boolean not null default false;
create index if not exists rate_snapshots_anomaly_idx on rate_snapshots (captured_on) where is_anomaly;

create or replace function flag_rate_anomalies(for_day date default current_date)
returns integer language plpgsql as $$
declare flagged integer;
begin
  with baseline as (
    -- Each hotel's typical price over the prior thirty days of captures,
    -- across every night it was priced for. At least five readings, or the
    -- comparison means nothing.
    select hotel_id,
           percentile_cont(0.5) within group (order by price) as typical,
           count(*) as n
    from rate_snapshots
    where price is not null
      and captured_on >= for_day - 30
      and captured_on <  for_day
    group by hotel_id
    having count(*) >= 5
  ),
  judged as (
    update rate_snapshots r
    set is_anomaly = (r.price > b.typical * 1.4)
    from baseline b
    where r.hotel_id = b.hotel_id
      and r.captured_on = for_day
      and r.price is not null
      and r.is_anomaly is distinct from (r.price > b.typical * 1.4)
    returning r.is_anomaly
  )
  select count(*) filter (where is_anomaly) into flagged from judged;
  return coalesce(flagged, 0);
end $$;

-- The grid reads the latest capture per hotel-night through this view; it
-- now carries the flag.
create or replace view latest_rates with (security_invoker = true) as
  select distinct on (hotel_id, check_in)
    hotel_id, check_in, price, currency, available, room_desc,
    captured_on, price_low, rate_source, offers, is_anomaly
  from rate_snapshots
  order by hotel_id, check_in, captured_on desc;
grant select on latest_rates to authenticated;

-- The competitive set was seeded with every tracked hotel regardless of
-- market, which put Destin under Pensacola and moved the median with hotels
-- forty-five miles away. A competitor must share the baseline's TripAdvisor
-- location — the market id the data already carries.
delete from baseline_comps bc
using hotels b, hotels c
where b.hotel_id = bc.baseline_hotel_id
  and c.hotel_id = bc.comp_hotel_id
  and (c.city_code is null or b.city_code is null or c.city_code <> b.city_code);

-- Distances where both ends are placed, so the radius filter is a fact.
update baseline_comps bc
set distance_km = 2 * 6371 * asin(sqrt(
      power(sin(radians(c.latitude - b.latitude) / 2), 2)
    + cos(radians(b.latitude)) * cos(radians(c.latitude))
    * power(sin(radians(c.longitude - b.longitude) / 2), 2)))
from hotels b, hotels c
where b.hotel_id = bc.baseline_hotel_id
  and c.hotel_id = bc.comp_hotel_id
  and b.latitude is not null and c.latitude is not null;

select flag_rate_anomalies(current_date);
