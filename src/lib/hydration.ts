// Keeping the rate data hydrated, without anyone waiting for it.
//
// A day's collection is thousands of hotel-nights and takes minutes; a
// serverless invocation lasts a minute. The previous arrangement asked the
// browser to drive that loop, which meant the dashboard sat on "Fetching
// rates…" and eventually took a gateway timeout — and the nightly cron, which
// had the same limit and no memory, gave up after the first few nights and
// started again from the beginning the next day. That is why the grid ran out
// of prices a week ahead.
//
// So the run keeps its place. Each tick prices what it can inside its budget,
// records how far it got, and returns. Something calls back — Supabase's own
// scheduler, every few minutes — until the day is done, after which ticks cost
// a single query. Nothing in the interface waits for any of it: the dashboard
// reads what is already stored and shows how far along today's run is.

import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";
import { buildJobs, processJobs, runEnrichment } from "./snapshot";
import { todayISO } from "./dates";
import { reportError } from "./errors";

export interface HydrationState {
  runDate: string;
  cursor: number;
  total: number;
  rowsWritten: number;
  startedAt: string | null;
  lastTickAt: string | null;
  finishedAt: string | null;
  errors: string[];
  /** 0–100, for a progress bar that does not lie when total is unknown. */
  percent: number;
  status: "idle" | "collecting" | "complete";
}

interface RunRow {
  run_date: string;
  cursor: number;
  total: number;
  rows_written: number;
  errors: string[] | null;
  started_at: string | null;
  last_tick_at: string | null;
  finished_at: string | null;
}

const COLUMNS = "run_date, cursor, total, rows_written, errors, started_at, last_tick_at, finished_at";

function toState(row: RunRow | null): HydrationState {
  if (!row) {
    return {
      runDate: todayISO(),
      cursor: 0,
      total: 0,
      rowsWritten: 0,
      startedAt: null,
      lastTickAt: null,
      finishedAt: null,
      errors: [],
      percent: 0,
      status: "idle",
    };
  }
  const percent = row.total > 0 ? Math.min(100, Math.round((row.cursor / row.total) * 100)) : 0;
  return {
    runDate: row.run_date,
    cursor: row.cursor,
    total: row.total,
    rowsWritten: row.rows_written,
    startedAt: row.started_at,
    lastTickAt: row.last_tick_at,
    finishedAt: row.finished_at,
    errors: row.errors ?? [],
    percent: row.finished_at ? 100 : percent,
    status: row.finished_at ? "complete" : "collecting",
  };
}

/** Today's collection, as far as it has got. Cheap enough to poll. */
export async function hydrationState(supa: SupabaseClient = db()): Promise<HydrationState> {
  const { data } = await supa
    .from("collection_runs")
    .select(COLUMNS)
    .eq("run_date", todayISO())
    .maybeSingle<RunRow>();
  return toState(data ?? null);
}

/**
 * Ask for today's rates to be collected again from the top.
 *
 * This is what the dashboard's refresh control does now: it moves the cursor
 * back and returns immediately. The collection happens on the next tick, in
 * the background, where a timeout costs nobody a spinner.
 */
export async function queueHydration(supa: SupabaseClient = db()): Promise<HydrationState> {
  const now = new Date().toISOString();
  await supa.from("collection_runs").upsert(
    {
      run_date: todayISO(),
      cursor: 0,
      rows_written: 0,
      errors: [],
      started_at: now,
      finished_at: null,
    },
    { onConflict: "run_date" }
  );
  return hydrationState(supa);
}

/**
 * Do one slice of today's collection.
 *
 * Returns quickly when the day is already complete, because the scheduler
 * keeps calling long after the work is done.
 */
export async function tickHydration(
  { budgetMs = 45_000 }: { budgetMs?: number } = {}
): Promise<HydrationState & { didWork: boolean }> {
  const supa = db();
  const runDate = todayISO();

  const { data: existing } = await supa
    .from("collection_runs")
    .select(COLUMNS)
    .eq("run_date", runDate)
    .maybeSingle<RunRow>();

  if (existing?.finished_at) {
    return { ...toState(existing), didWork: false };
  }

  const plan = await buildJobs(supa);
  if (plan.note || plan.jobs.length === 0) {
    const now = new Date().toISOString();
    const row = {
      run_date: runDate,
      cursor: 0,
      total: 0,
      rows_written: existing?.rows_written ?? 0,
      errors: plan.note ? [plan.note] : [],
      started_at: existing?.started_at ?? now,
      last_tick_at: now,
      finished_at: now,
    };
    await supa.from("collection_runs").upsert(row, { onConflict: "run_date" });
    return { ...toState(row as RunRow), didWork: false };
  }

  const cursor = existing?.cursor ?? 0;
  const slice = plan.jobs.slice(cursor);
  const r = await processJobs(supa, slice, { budgetMs });

  const nextCursor = cursor + r.done;
  const complete = nextCursor >= plan.jobs.length;

  // A slice that made no progress and produced errors is an outage, not a
  // quiet night — record it where someone will see it.
  if (r.done === 0 && r.errors.length > 0) {
    await reportError("collection", r.errors[0], { detail: r.errors.slice(0, 5).join("\n") }, supa);
  }
  if (plan.note) await reportError("collection", plan.note, {}, supa);

  // Enrichment (events, review scores) is only worth running once the day's
  // rates are in, so it rides on the tick that finishes the run.
  const errors = [...(existing?.errors ?? []), ...r.errors];
  if (complete) errors.push(...(await runEnrichment(supa, plan.profiles)));

  const now = new Date().toISOString();
  const row: RunRow = {
    run_date: runDate,
    cursor: nextCursor,
    total: plan.jobs.length,
    rows_written: (existing?.rows_written ?? 0) + r.rowsWritten,
    // Keep the run row small: the first handful of errors is enough to
    // diagnose an outage, and the rest are the same message repeated.
    errors: errors.slice(0, 10),
    started_at: existing?.started_at ?? now,
    last_tick_at: now,
    finished_at: complete ? now : null,
  };
  await supa.from("collection_runs").upsert(row, { onConflict: "run_date" });

  return { ...toState(row), didWork: r.done > 0 };
}

/**
 * Tell the database where to call back.
 *
 * The scheduler runs inside Postgres and cannot know the deployment's URL, and
 * asking someone to paste it (with the cron secret) into a SQL editor is a
 * step that will be got wrong once and then be wrong forever. The app knows
 * both from its own environment, so it writes them down whenever it runs.
 */
export async function registerSchedulerTarget(supa: SupabaseClient = db()): Promise<string | null> {
  const host =
    process.env.APP_BASE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null);
  if (!host) return null;

  const now = new Date().toISOString();
  const rows = [{ key: "app.base_url", value: host.replace(/\/+$/, ""), updated_at: now }];
  const secret = process.env.CRON_SECRET;
  if (secret) rows.push({ key: "app.cron_secret", value: secret, updated_at: now });

  await supa.from("api_settings").upsert(rows, { onConflict: "key" });
  return host;
}
