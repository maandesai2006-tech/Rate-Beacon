-- Persist the deterministic forecast and the inputs used to explain it.
-- Candidate prices are experimental in release 1; only the collection job
-- writes forecasts, and signed-in accounts can read their own profiles.
create table public.demand_forecasts (
  profile_id bigint not null,
  hotel_id text not null,
  check_in date not null,
  demand_score numeric not null check (demand_score between 0 and 100),
  forecast_median numeric
    check (forecast_median >= 0 and forecast_median < 'Infinity'::numeric),
  suggested_low numeric
    check (suggested_low >= 0 and suggested_low < 'Infinity'::numeric),
  suggested_high numeric
    check (suggested_high >= 0 and suggested_high < 'Infinity'::numeric),
  confidence numeric not null check (confidence between 0 and 1),
  signals jsonb not null check (jsonb_typeof(signals) = 'array'),
  forecast jsonb not null check (jsonb_typeof(forecast) = 'object'),
  context_key text not null check (length(btrim(context_key)) > 0),
  computed_at timestamptz not null default now(),
  primary key (profile_id, hotel_id, check_in),
  constraint demand_forecasts_tracked_hotel_fk
    foreign key (profile_id, hotel_id)
    references public.profile_hotels (profile_id, hotel_id) on delete cascade,
  constraint demand_forecasts_range_order check (
    (suggested_low is null and suggested_high is null)
    or (suggested_low is not null and suggested_high is not null
        and suggested_low <= suggested_high)
  )
);

comment on column public.demand_forecasts.forecast is
  'Full versioned engine result, including signal contributions, named input rows, capture dates, learning samples and confidence reasons.';
comment on column public.demand_forecasts.context_key is
  'Fingerprint of forecast version, currency and the selected baseline/compset settings. Readers reject a stored result when this context changes.';

alter table public.demand_forecasts enable row level security;
create policy demand_forecasts_own_read on public.demand_forecasts
  for select to authenticated
  using (profile_id in (select public.app_profile_ids()));

-- Remove grants that a project's default privileges may have added when the
-- table was created, including PUBLIC grants inherited by the client roles.
revoke all on table public.demand_forecasts from public, anon, authenticated;
grant select on table public.demand_forecasts to authenticated;
grant all on table public.demand_forecasts to service_role;

-- Rate collection and forecasting finish independently. Keeping the latter's
-- cursor durable permits a later tick to resume after a timeout or error.
alter table public.collection_runs
  add column forecast_cursor integer not null default 0
    check (forecast_cursor >= 0),
  add column forecast_finished_at timestamptz;

comment on column public.collection_runs.forecast_cursor is
  'Number of baseline hotels whose forecast work completed for this run; advance only after successful persistence.';
comment on column public.collection_runs.forecast_finished_at is
  'Set after every baseline forecast is persisted. finished_at continues to describe rate collection only.';
