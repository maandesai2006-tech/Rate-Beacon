-- Rate collection as a resumable background job.
--
-- The daily run used to work through as many hotel-nights as it could fit in
-- one serverless invocation, then stop. Nothing recorded where it had got to,
-- so every day it started again at the first night and never reached the rest:
-- a 75-night horizon collected about five nights, and the grid was empty from
-- the following week onward. Pressing "Refresh rates" ran the same work in the
-- foreground, which is why it timed out.
--
-- Now the run has state. Each tick takes a slice, advances the cursor and
-- returns; a scheduler keeps ticking until the day is complete, and then the
-- ticks cost nothing. The dashboard never waits for a scrape — it reads what
-- the pipeline has already stored.

create table if not exists collection_runs (
  run_date     date primary key,
  cursor       integer not null default 0,
  total        integer not null default 0,
  rows_written integer not null default 0,
  errors       text[]  not null default '{}',
  started_at   timestamptz not null default now(),
  last_tick_at timestamptz,
  finished_at  timestamptz
);

-- Server-only, like the other operational tables: no grant, no access.
alter table collection_runs enable row level security;

-- Where the scheduler should call, and with what. Both are written by the app
-- itself from its own environment, so there is nothing to configure by hand
-- and no secret pasted into a SQL editor.
--   app.base_url    https://<deployment>
--   app.cron_secret matches CRON_SECRET on the deployment
-- (api_settings is already server-only.)

-- pg_cron drives the ticks. Vercel's own scheduler starts the day; this keeps
-- it moving, because one invocation cannot finish a day's collection and a
-- daily cron cannot call itself back.
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  perform cron.unschedule('rate-hydration');
exception when others then null;
end $$;

select cron.schedule(
  'rate-hydration',
  '* * * * *',
  $job$
    select net.http_get(
      url := (select value from api_settings where key = 'app.base_url') || '/api/cron/snapshot?tick=1',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || coalesce((select value from api_settings where key = 'app.cron_secret'), '')
      ),
      timeout_milliseconds := 55000
    )
    where exists (select 1 from api_settings where key = 'app.base_url');
  $job$
);
