-- Manager's-report pipeline: Cloudflare Email Worker → /api/ingest-report →
-- Gemini extraction → deterministic analysis engine → these tables.
--
-- Two tables are added and one is extended:
--   hotels                 gains pms_type / compset_ids / owner_account_id
--   daily_manager_reports  one wide, normalised row per hotel per business date
--   daily_insights         the flags the analysis engine raised for that row
--
-- The existing manager_reports / report_metrics pair is kept as the *raw*
-- ingest ledger (message id, subject, extracted text) so a report can be
-- re-parsed later without going back to the mailbox. daily_manager_reports is
-- the normalised layer everything downstream reads.

-- ── 1. hotels ────────────────────────────────────────────────────────────
-- hotel_id (text, the TripAdvisor key) is already this table's primary key,
-- so it plays the "id" role from the spec. compset_ids denormalises the
-- competitive set for the rules that compare against it; baseline_comps stays
-- the authoritative, discovery-populated source and this mirrors it.
alter table hotels add column if not exists pms_type text;
alter table hotels add column if not exists compset_ids text[] not null default '{}';
alter table hotels add column if not exists owner_account_id bigint references accounts(id) on delete set null;

comment on column hotels.pms_type is
  'PMS/brand family the manager''s report comes from: ihg, hilton, marriott, choice, wyndham, independent. Set by the extractor, used only for diagnostics.';
comment on column hotels.compset_ids is
  'Mirror of baseline_comps for this hotel, so a single row read gives the analysis engine its compset.';

-- ── 2. daily_manager_reports ─────────────────────────────────────────────
create table if not exists daily_manager_reports (
  id                bigserial primary key,
  profile_id        bigint not null references profiles(id) on delete cascade,
  hotel_id          text   not null references hotels(hotel_id) on delete cascade,
  report_date       date   not null,

  -- Headline performance
  occupancy_percent numeric(6,2),
  adr               numeric(12,2),
  revpar            numeric(12,2),
  room_revenue      numeric(14,2),
  total_revenue     numeric(14,2),
  rooms_sold        integer,
  rooms_available   integer,

  -- Operational detail the 15 rules key off
  out_of_order      integer,
  no_shows          integer,
  cancellations     integer,
  total_reservations integer,
  comp_rooms        integer,
  early_departures  integer,
  extended_stays    integer,
  walk_ins          integer,
  arrivals          integer,
  departures        integer,
  stayovers         integer,
  cash_variance     numeric(12,2),
  total_adjustments numeric(12,2),
  direct_bill_transfers numeric(12,2),

  -- Provenance
  raw_pdf_url       text,
  source            text not null default 'email',
  extractor         text not null default 'gemini',
  extractor_model   text,
  confidence        numeric(4,3),
  raw_report_id     bigint references manager_reports(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- One normalised row per hotel per business date. Re-sending the same
  -- report overwrites rather than duplicating.
  unique (profile_id, hotel_id, report_date)
);

create index if not exists daily_manager_reports_hotel_date_idx
  on daily_manager_reports (hotel_id, report_date desc);
create index if not exists daily_manager_reports_profile_date_idx
  on daily_manager_reports (profile_id, report_date desc);

-- ── 3. daily_insights ────────────────────────────────────────────────────
create table if not exists daily_insights (
  id          bigserial primary key,
  report_id   bigint not null references daily_manager_reports(id) on delete cascade,
  flag_type   text   not null,
  message     text   not null,
  severity    text   not null default 'info'
              check (severity in ('critical','warning','info','positive')),
  metric_key  text,
  observed    numeric,
  threshold   numeric,
  created_at  timestamptz not null default now(),

  -- Re-running the engine over the same report replaces its flags in place.
  unique (report_id, flag_type)
);

create index if not exists daily_insights_report_idx on daily_insights (report_id);
create index if not exists daily_insights_severity_idx on daily_insights (severity);

-- ── 4. Mailbox aliases for the Cloudflare Email Worker ───────────────────
-- Each hotel gets a stable alias (e.g. cw-pensacola@reports.example.com).
-- The Worker looks the alias up here so a new hotel is onboarded by inserting
-- one row, not by redeploying the Worker.
create table if not exists report_inboxes (
  alias        text primary key,
  profile_id   bigint not null references profiles(id) on delete cascade,
  hotel_id     text   references hotels(hotel_id) on delete cascade,
  label        text,
  active       boolean not null default true,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);

comment on table report_inboxes is
  'alias → hotel routing for Cloudflare Email Routing. hotel_id null means "let the extractor decide which tracked hotel this report is for".';

-- ── 5. updated_at maintenance ────────────────────────────────────────────
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists daily_manager_reports_updated_at on daily_manager_reports;
create trigger daily_manager_reports_updated_at
  before update on daily_manager_reports
  for each row execute function set_updated_at();

-- ── 6. Row Level Security ────────────────────────────────────────────────
-- Every read and write in this app goes through server-side API routes using
-- the service_role key, which bypasses RLS. The browser never holds a
-- Supabase key. RLS is therefore enabled with *no* permissive policies:
-- anon and authenticated roles get nothing, which is the intended posture and
-- closes the hole if the publishable key is ever exposed.
alter table daily_manager_reports enable row level security;
alter table daily_insights        enable row level security;
alter table report_inboxes        enable row level security;

-- Explicit deny for the browser-reachable roles. Listed rather than implied so
-- the intent survives someone later adding a permissive policy by accident.
drop policy if exists daily_manager_reports_no_anon on daily_manager_reports;
create policy daily_manager_reports_no_anon on daily_manager_reports
  for all to anon, authenticated using (false) with check (false);

drop policy if exists daily_insights_no_anon on daily_insights;
create policy daily_insights_no_anon on daily_insights
  for all to anon, authenticated using (false) with check (false);

drop policy if exists report_inboxes_no_anon on report_inboxes;
create policy report_inboxes_no_anon on report_inboxes
  for all to anon, authenticated using (false) with check (false);

-- ── 7. Backfill from the existing narrow store ───────────────────────────
-- report_metrics holds one row per (report, metric). Pivot whatever is already
-- collected into the new wide table so the dashboard is not empty on deploy.
insert into daily_manager_reports (
  profile_id, hotel_id, report_date,
  occupancy_percent, adr, revpar, room_revenue, total_revenue,
  rooms_sold, rooms_available,
  out_of_order, no_shows, cancellations, comp_rooms, walk_ins,
  arrivals, departures, stayovers,
  source, extractor, raw_report_id
)
select
  r.profile_id,
  r.hotel_id,
  r.report_date,
  max(m.value) filter (where m.metric = 'occupancy'),
  max(m.value) filter (where m.metric = 'adr'),
  max(m.value) filter (where m.metric = 'revpar'),
  max(m.value) filter (where m.metric = 'room_revenue'),
  max(m.value) filter (where m.metric = 'total_revenue'),
  max(m.value) filter (where m.metric = 'rooms_sold')::int,
  max(m.value) filter (where m.metric = 'rooms_available')::int,
  max(m.value) filter (where m.metric = 'out_of_order')::int,
  max(m.value) filter (where m.metric = 'no_shows')::int,
  max(m.value) filter (where m.metric = 'cancellations')::int,
  max(m.value) filter (where m.metric = 'comp_rooms')::int,
  max(m.value) filter (where m.metric = 'walk_ins')::int,
  max(m.value) filter (where m.metric = 'arrivals')::int,
  max(m.value) filter (where m.metric = 'departures')::int,
  max(m.value) filter (where m.metric = 'stayovers')::int,
  coalesce(r.source, 'email'),
  'text-parser',
  r.id
from manager_reports r
join report_metrics m on m.report_id = r.id
where r.hotel_id is not null
group by r.profile_id, r.hotel_id, r.report_date, r.source, r.id
on conflict (profile_id, hotel_id, report_date) do nothing;
