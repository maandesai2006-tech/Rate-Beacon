-- Collapsing the places where the same job was done twice, and putting a
-- ceiling on the one table that grew without bound.
--
-- Reports were written into three tables: a raw ledger, a key-value sidecar,
-- and the wide row the dashboard and the fifteen rules actually read. Only the
-- wide row was ever read back, so the other two were storage and a second
-- place for every future change to go wrong. The raw record still matters —
-- it is the evidence for what the parser saw, and the message id is what stops
-- an email being collected twice — so it moves onto the row it produced.

alter table daily_manager_reports add column if not exists raw_text text;
alter table daily_manager_reports add column if not exists message_id text;
alter table daily_manager_reports add column if not exists file_name text;
alter table daily_manager_reports add column if not exists subject text;
alter table daily_manager_reports add column if not exists matched_by text;

update daily_manager_reports d
set raw_text   = coalesce(d.raw_text, m.raw_text),
    message_id = coalesce(d.message_id, m.message_id),
    file_name  = coalesce(d.file_name, m.file_name),
    subject    = coalesce(d.subject, m.subject),
    matched_by = coalesce(d.matched_by, m.matched_by)
from manager_reports m
where m.profile_id = d.profile_id
  and m.hotel_id   = d.hotel_id
  and m.report_date = d.report_date;

create index if not exists daily_manager_reports_message_idx
  on daily_manager_reports (profile_id, message_id)
  where message_id is not null;

alter table daily_manager_reports drop column if exists raw_report_id;

drop table if exists report_metrics;
drop table if exists manager_reports;

-- The competitive set had two models: baseline_comps, holding one edge per
-- baseline hotel, and a role column on profile_hotels holding a flat list. The
-- grid preferred the edges and silently fell back to "every tracked hotel
-- sharing a TripAdvisor location code" when there were none — which was
-- always, because discovery never produced any. That fallback presented a
-- compset nobody had chosen as though they had. Seed the edges from what each
-- profile actually tracks, and the fallback can go.
insert into baseline_comps (profile_id, baseline_hotel_id, comp_hotel_id, distance_km, discovered_at)
select mine.profile_id, mine.hotel_id, comp.hotel_id, null, now()
from profile_hotels mine
join profile_hotels comp
  on comp.profile_id = mine.profile_id
 and comp.hotel_id <> mine.hotel_id
 and coalesce(comp.role, 'comp') <> 'map'
where mine.is_mine
on conflict (profile_id, baseline_hotel_id, comp_hotel_id) do nothing;

-- Map leftovers: the nearby-place table, and the hotels that were tracked only
-- to put a price on a pin.
drop table if exists map_places;
delete from profile_hotels where role = 'map';

-- Rate history grew by one row per hotel-night per day and nothing ever
-- removed any of it — about 40,000 rows a day at fifty customers, which fills
-- the database long before the collector runs out of time. Past a month the
-- intraday captures carry nothing the final price for that night does not, so
-- keep one row per hotel-night and drop the rest.
create or replace function prune_rate_snapshots(retain_days integer default 30)
returns integer language plpgsql as $$
declare removed integer;
begin
  with keep as (
    select distinct on (hotel_id, check_in) id
    from rate_snapshots
    where captured_on < current_date - retain_days
    order by hotel_id, check_in, captured_on desc
  ),
  gone as (
    delete from rate_snapshots
    where captured_on < current_date - retain_days
      and id not in (select id from keep)
    returning 1
  )
  select count(*) into removed from gone;
  return removed;
end $$;

do $$
begin
  perform cron.unschedule('rate-retention');
exception when others then null;
end $$;

-- After the night's collection, before anyone looks at the dashboard.
select cron.schedule('rate-retention', '40 4 * * *', $job$ select prune_rate_snapshots(30) $job$);
