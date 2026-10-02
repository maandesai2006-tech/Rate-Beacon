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
import { tickForecasts } from "./forecast-service";
import { BACKOFF_MINUTES, pauseUntil, REPEAT_BACKOFF_MINUTES, runLooksDegraded, SOURCE_ERROR_PREFIX } from "./collect-health";

export interface HydrationState {
  runDate: string;
  cursor: number;
  total: number;
  rowsWritten: number;
  startedAt: string | null;
  lastTickAt: string | null;
  finishedAt: string | null;
  /** Rates are finished; the resumable forecast stage is still working. */
  forecastPending: boolean;
  errors: string[];
  /** 0–100, for a progress bar that does not lie when total is unknown. */
  percent: number;
  status: "idle" | "collecting" | "complete";
  /** The rate source is failing; collection resumes on its own at this time. */
  pausedUntil: string | null;
  /** What the source said when it failed, for the person looking at the bar. */
  sourceProblem: string | null;
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
  forecast_cursor: number;
  forecast_finished_at: string | null;
  lookups: number;
  unpriced: number;
  paused_until: string | null;
}

const COLUMNS =
  "run_date, cursor, total, rows_written, errors, started_at, last_tick_at, finished_at, forecast_cursor, forecast_finished_at, lookups, unpriced, paused_until";

function sourceProblemOf(errors: string[] | null): string | null {
  const hit = (errors ?? []).find((e) => e.startsWith(SOURCE_ERROR_PREFIX));
  return hit ? hit.slice(SOURCE_ERROR_PREFIX.length) : null;
}

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
      forecastPending: false,
      errors: [],
      percent: 0,
      status: "idle",
      pausedUntil: null,
      sourceProblem: null,
    };
  }
  const paused = row.paused_until && Date.parse(row.paused_until) > Date.now() ? row.paused_until : null;
  const percent = row.total > 0 ? Math.min(100, Math.round((row.cursor / row.total) * 100)) : 0;
  return {
    runDate: row.run_date,
    cursor: row.cursor,
    total: row.total,
    rowsWritten: row.rows_written,
    startedAt: row.started_at,
    lastTickAt: row.last_tick_at,
    finishedAt: row.forecast_finished_at,
    forecastPending: Boolean(row.finished_at && !row.forecast_finished_at),
    errors: row.errors ?? [],
    percent: row.finished_at ? 100 : percent,
    status: row.finished_at && row.forecast_finished_at ? "complete" : "collecting",
    pausedUntil: paused,
    sourceProblem: paused ? sourceProblemOf(row.errors) : null,
  };
}

/** Today's collection, as far as it has got. Cheap enough to poll. */
export async function hydrationState(supa: SupabaseClient = db()): Promise<HydrationState> {
  const { data, error } = await supa
    .from("collection_runs")
    .select(COLUMNS)
    .eq("run_date", todayISO())
    .maybeSingle<RunRow>();
  if (error) throw new Error(`Could not read collection progress: ${error.message}`);
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
  const { error } = await supa.from("collection_runs").upsert(
    {
      run_date: todayISO(),
      cursor: 0,
      rows_written: 0,
      errors: [],
      started_at: now,
      finished_at: null,
      forecast_cursor: 0,
      forecast_finished_at: null,
      lookups: 0,
      unpriced: 0,
      paused_until: null,
    },
    { onConflict: "run_date" }
  );
  if (error) throw new Error(`Could not queue collection: ${error.message}`);
  return hydrationState(supa);
}

/**
 * Do one slice of today's collection.
 *
 * Returns quickly when the day is already complete, because the scheduler
 * keeps calling long after the work is done.
 */
export async function tickHydration(
  { budgetMs = 45_000, ignorePause = false }: { budgetMs?: number; ignorePause?: boolean } = {}
): Promise<HydrationState & { didWork: boolean }> {
  const supa = db();
  const runDate = todayISO();
  const deadline = Date.now() + budgetMs;

  const { data: existing, error: stateError } = await supa
    .from("collection_runs")
    .select(COLUMNS)
    .eq("run_date", runDate)
    .maybeSingle<RunRow>();
  if (stateError) throw new Error(`Could not read collection progress: ${stateError.message}`);

  if (existing?.finished_at) {
    if (existing.forecast_finished_at) return { ...toState(existing), didWork: false };
    return finishForecastStage(supa, existing, deadline);
  }

  // The source failed recently. Leave it alone until the backoff is up rather
  // than spending every minute of the day confirming it is still down. A
  // person pressing Refresh is allowed one probe.
  if (!ignorePause && existing?.paused_until && Date.parse(existing.paused_until) > Date.now()) {
    return { ...toState(existing), didWork: false };
  }

  const plan = await buildJobs(supa);
  if (plan.jobs.length === 0) {
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
      forecast_cursor: 0,
      forecast_finished_at: now,
      lookups: 0,
      unpriced: 0,
      paused_until: null,
    };
    await supa.from("collection_runs").upsert(row, { onConflict: "run_date" });
    return { ...toState(row as RunRow), didWork: false };
  }

  const cursor = existing?.cursor ?? 0;
  const slice = plan.jobs.slice(cursor);
  // No new lookup after six seconds before the deadline, none in flight past
  // one second before it. In-flight calls are bounded now, so the old twelve
  // seconds of reserve was mostly idle time.
  const r = await processJobs(supa, slice, {
    budgetMs: Math.max(1, deadline - Date.now() - 6_000),
    hardDeadline: deadline - 1_000,
  });

  if (r.tripped) {
    return recordOutage(supa, existing, runDate, plan.jobs.length, r.lastFailure ?? "the rate source is not answering", {
      resetRun: false,
    });
  }

  // The source can also fail by answering with nothing. One empty answer is a
  // full hotel; most of a day's answers empty is the source. The rows this
  // run has written so far cannot be believed, so they become unknown.
  const lookups = (existing?.lookups ?? 0) + r.lookups;
  const unpriced = (existing?.unpriced ?? 0) + r.unpriced;
  if (runLooksDegraded(lookups, unpriced, plan.jobs.length)) {
    return recordOutage(
      supa,
      existing,
      runDate,
      plan.jobs.length,
      `${unpriced} of ${lookups} lookups came back with no price; that is the source, not the market`,
      { resetRun: true }
    );
  }

  const nextCursor = cursor + r.done;
  const complete = nextCursor >= plan.jobs.length;

  // A slice that made no progress and produced errors is an outage, not a
  // quiet night — record it where someone will see it.
  if (r.done === 0 && r.errors.length > 0) {
    await reportError("collection", r.errors[0], { detail: r.errors.slice(0, 5).join("\n") }, supa);
  }
  if (plan.note) await reportError("collection", plan.note, {}, supa);

  // Progress means the source is back; an outage note would now mislead.
  const errors = [...(existing?.errors ?? []).filter((e) => !e.startsWith(SOURCE_ERROR_PREFIX)), ...r.errors];

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
    forecast_cursor: existing?.forecast_cursor ?? 0,
    forecast_finished_at: null,
    lookups,
    unpriced,
    paused_until: null,
  };
  const { error: saveError } = await supa.from("collection_runs").upsert(row, { onConflict: "run_date" });
  if (saveError) throw new Error(`Could not save collection progress: ${saveError.message}`);

  if (complete) {
    // Persist rate completion BEFORE forecasts/enrichment. A timeout in either
    // stage no longer discards the completed rate cursor or repeats collection.
    const state = await finishForecastStage(supa, row, deadline);
    if (Date.now() < deadline - 5_000) {
      const enrichErrors = await runEnrichment(supa, plan.profiles);
      if (enrichErrors.length) {
        state.errors = [...state.errors, ...enrichErrors].slice(0, 10);
        await supa.from("collection_runs").update({ errors: state.errors }).eq("run_date", runDate);
      }
    }
    return { ...state, didWork: r.done > 0 || state.didWork };
  }
  return { ...toState(row), didWork: r.done > 0 };
}

/**
 * The rate source is failing: back off, say so where someone will see it, and
 * do not let anything this run wrote pass for a market fact.
 *
 * With `resetRun`, the run itself is not believable, so its empty answers are
 * turned back into unknowns and it starts again from the top once the source
 * recovers. Without it, the breaker stopped the slice before it advanced, so
 * the cursor is already where it should be.
 */
async function recordOutage(
  supa: SupabaseClient,
  existing: RunRow | null,
  runDate: string,
  total: number,
  reason: string,
  { resetRun }: { resetRun: boolean }
): Promise<HydrationState & { didWork: boolean }> {
  const now = new Date();
  const message = `${SOURCE_ERROR_PREFIX}${reason}`.slice(0, 300);
  const previous = existing?.errors ?? [];
  // One report per outage, not one per probe.
  const alreadyReported = previous.some((e) => e.startsWith(SOURCE_ERROR_PREFIX));

  if (resetRun) {
    const { error: undoError } = await supa
      .from("rate_snapshots")
      .update({ available: null })
      .eq("captured_on", runDate)
      .is("price", null)
      .eq("available", false);
    if (undoError) throw new Error(`Could not withdraw unbelievable rates: ${undoError.message}`);
  }

  const row: RunRow = {
    run_date: runDate,
    cursor: resetRun ? 0 : existing?.cursor ?? 0,
    total,
    rows_written: resetRun ? 0 : existing?.rows_written ?? 0,
    errors: [message, ...previous.filter((e) => !e.startsWith(SOURCE_ERROR_PREFIX))].slice(0, 10),
    started_at: existing?.started_at ?? now.toISOString(),
    last_tick_at: now.toISOString(),
    finished_at: null,
    forecast_cursor: 0,
    forecast_finished_at: null,
    lookups: resetRun ? 0 : existing?.lookups ?? 0,
    unpriced: resetRun ? 0 : existing?.unpriced ?? 0,
    paused_until: pauseUntil(now, alreadyReported ? REPEAT_BACKOFF_MINUTES : BACKOFF_MINUTES),
  };
  const { error } = await supa.from("collection_runs").upsert(row, { onConflict: "run_date" });
  if (error) throw new Error(`Could not record the outage: ${error.message}`);
  if (!alreadyReported) await reportError("collection", message, {}, supa);
  return { ...toState(row), didWork: false };
}

async function finishForecastStage(
  supa: SupabaseClient, row: RunRow, deadline: number
): Promise<HydrationState & { didWork: boolean }> {
  if (Date.now() >= deadline) return { ...toState(row), didWork: false };
  try {
    // Do not save a forecast before the collector has judged today's outliers.
    // On a retry this operation is deterministic and safe to repeat.
    const { error: flagError } = await supa.rpc("flag_rate_anomalies", { for_day: row.run_date });
    if (flagError) throw new Error(`Anomaly flagging: ${flagError.message}`);
    const progress = await tickForecasts(supa, row.run_date, row.forecast_cursor ?? 0, deadline);
    const errors = (row.errors ?? []).filter((error) => !error.startsWith("forecast: "));
    const { error: saveError } = await supa.from("collection_runs").update({
      forecast_cursor: progress.cursor,
      forecast_finished_at: progress.complete ? new Date().toISOString() : null,
      last_tick_at: new Date().toISOString(), errors,
    }).eq("run_date", row.run_date);
    if (saveError) throw new Error(`Could not save forecast completion: ${saveError.message}`);
    return { ...(await hydrationState(supa)), didWork: progress.cursor > (row.forecast_cursor ?? 0) };
  } catch (error) {
    // Keep the per-hotel checkpoints already saved by tickForecasts. The next
    // scheduled call resumes from them; failure is never marked complete.
    const message = `forecast: ${error instanceof Error ? error.message : String(error)}`;
    const errors = [message, ...(row.errors ?? []).filter((item) => !item.startsWith("forecast: "))].slice(0, 10);
    const { error: saveError } = await supa.from("collection_runs").update({ errors }).eq("run_date", row.run_date);
    if (saveError) throw new Error(`Could not record forecast failure: ${saveError.message}`);
    return { ...(await hydrationState(supa)), didWork: false };
  }
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
