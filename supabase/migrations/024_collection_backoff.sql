-- Let a collection run tell a rate-source outage from a full market.
--
-- lookups / unpriced accumulate across a run's ticks so the run can notice
-- that most of what it has priced came back empty, which a real market never
-- does. paused_until is the backoff: when the source is failing, ticks leave
-- it alone until then instead of re-confirming the outage every minute.
alter table public.collection_runs
  add column lookups integer not null default 0 check (lookups >= 0),
  add column unpriced integer not null default 0 check (unpriced >= 0 and unpriced <= lookups),
  add column paused_until timestamptz;

comment on column public.collection_runs.lookups is
  'Rate lookups completed by this run so far, across ticks. Reset when the run is judged unbelievable.';
comment on column public.collection_runs.unpriced is
  'Of those lookups, how many returned no price (failed or no offers).';
comment on column public.collection_runs.paused_until is
  'The rate source was failing; scheduled ticks skip until this time. A manual refresh may probe once.';
