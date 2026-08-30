import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";
import { getRates } from "./xotelo";
import { addDaysISO, dateRange, todayISO } from "./dates";
import { refreshEvents, refreshGeo, refreshRatings } from "./enrich";
import type { Profile } from "./types";

export interface SnapshotResult {
  profiles: number;
  hotels: number;
  dates: number;
  rowsWritten: number;
  errors: string[];
  /** Jobs in the whole run, so a caller can show progress. */
  total: number;
  /** Where the next chunk should start; null when the run is complete. */
  nextOffset: number | null;
}

/** One hotel-night to price. */
export interface RateJob {
  checkIn: string;
  hotel: TrackedHotel;
}

export interface TrackedHotel {
  hotel_id: string;
  name: string;
  currency: string;
  adults: number;
  horizon: number;
}

// Fetch nightly quotes for every hotel tracked by any profile and store
// today's snapshot. A hotel shared by several profiles is fetched once, using
// the widest horizon among them. One Xotelo request per hotel per night.
//
// The work is split in two so a background run can be resumed: buildJobs()
// decides what today's collection consists of, and processJobs() prices a
// bounded slice of it. Both are deterministic given the same tracked set, so a
// cursor into the job list survives across invocations.

export interface JobPlan {
  jobs: RateJob[];
  profiles: Profile[];
  hotels: number;
  dates: number;
  note: string | null;
}

export async function buildJobs(
  supa: SupabaseClient,
  maxDates?: number
): Promise<JobPlan> {
  const [{ data: profiles }, { data: links }, { data: hotelRows }] =
    await Promise.all([
      supa.from("profiles").select("*").returns<Profile[]>(),
      supa
        .from("profile_hotels")
        .select("profile_id, hotel_id, role")
        .returns<{ profile_id: number; hotel_id: string; role: string }[]>(),
      supa
        .from("hotels")
        .select("hotel_id, name")
        .returns<{ hotel_id: string; name: string }[]>(),
    ]);

  if (!profiles?.length || !links?.length) {
    return { jobs: [], profiles: profiles ?? [], hotels: 0, dates: 0, note: "No profiles configured yet" };
  }

  const nameById = new Map(hotelRows?.map((h) => [h.hotel_id, h.name]) ?? []);
  // "map" links existed to put prices on map pins. Nothing draws them now, so
  // pricing them would be a few hundred upstream calls a day for data no
  // screen reads.
  const priceable = links.filter((l) => l.role !== "map");
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const tracked = new Map<string, TrackedHotel>();
  for (const link of priceable) {
    const p = profileById.get(link.profile_id);
    if (!p) continue;
    const horizon = p.horizon_days;
    const existing = tracked.get(link.hotel_id);
    if (existing) {
      existing.horizon = Math.max(existing.horizon, horizon);
    } else {
      tracked.set(link.hotel_id, {
        hotel_id: link.hotel_id,
        name: nameById.get(link.hotel_id) ?? link.hotel_id,
        currency: p.currency,
        adults: p.adults,
        horizon,
      });
    }
  }

  const maxHorizon = Math.min(
    Math.max(...[...tracked.values()].map((h) => h.horizon)),
    maxDates ?? 120
  );
  const dates = dateRange(todayISO(), maxHorizon);

  // Date-major, so the nights a dashboard actually shows are priced first and
  // a run that is still in progress is still useful.
  const jobs = dates.flatMap((checkIn, dayIdx) =>
    [...tracked.values()]
      .filter((h) => dayIdx < h.horizon)
      .map((hotel) => ({ checkIn, hotel }))
  );

  return { jobs, profiles, hotels: tracked.size, dates: dates.length, note: null };
}

export interface ProcessResult {
  rowsWritten: number;
  errors: string[];
  /** How many of the given jobs were finished before the budget ran out. */
  done: number;
}

/**
 * Price a slice of jobs, stopping when the time budget is spent.
 *
 * The budget is what makes a run resumable: the caller records how many jobs
 * were finished and starts there next time, instead of restarting the day.
 */
export async function processJobs(
  supa: SupabaseClient,
  jobs: RateJob[],
  { budgetMs = 45_000, concurrency = 4 }: { budgetMs?: number; concurrency?: number } = {}
): Promise<ProcessResult> {
  const deadline = Date.now() + budgetMs;
  const errors: string[] = [];
  let rowsWritten = 0;
  let cursor = 0;
  let finished = 0;
  let aborted = false;

  async function worker() {
    while (!aborted) {
      if (Date.now() > deadline) return;
      const i = cursor++;
      if (i >= jobs.length) return;
      const { checkIn, hotel } = jobs[i];
      try {
        const r = await getRates(
          hotel.hotel_id,
          hotel.name,
          checkIn,
          addDaysISO(checkIn, 1),
          hotel.currency,
          hotel.adults
        );
        const { error } = await supa.from("rate_snapshots").upsert(
          {
            hotel_id: hotel.hotel_id,
            check_in: checkIn,
            captured_on: todayISO(),
            price: r.price,
            price_low: r.priceLow,
            rate_source: r.source ? `${r.source}${r.direct ? " (direct)" : ""}` : null,
            offers: r.offers,
            currency: r.currency ?? hotel.currency,
            available: r.available,
            room_desc: null,
          },
          { onConflict: "hotel_id,check_in,captured_on" }
        );
        if (error) errors.push(`${hotel.name} ${checkIn}: ${error.message}`);
        else rowsWritten++;
      } catch (e) {
        errors.push(`${hotel.name} ${checkIn}: ${(e as Error).message}`);
        // Persistent failure (network, upstream outage) — stop hammering.
        if (errors.length >= 10) aborted = true;
      }
      finished++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { rowsWritten, errors, done: finished };
}

/** Enrichment worth running once, after the day's rates are in. */
export async function runEnrichment(supa: SupabaseClient, profiles: Profile[]): Promise<string[]> {
  const errors: string[] = [];
  errors.push(...(await refreshEvents(supa, profiles)));
  errors.push(...(await refreshRatings(supa, profiles)));
  return errors;
}

/**
 * The original offset/limit interface, kept for callers that drive their own
 * chunking. New work should use the resumable run in lib/hydration.ts.
 */
export async function runSnapshot(
  maxDates?: number,
  chunk?: { offset: number; limit: number }
): Promise<SnapshotResult> {
  const supa = db();
  const plan = await buildJobs(supa, maxDates);
  if (plan.note) {
    return {
      profiles: 0, hotels: 0, dates: 0, rowsWritten: 0,
      errors: [plan.note], total: 0, nextOffset: null,
    };
  }

  const offset = chunk?.offset ?? 0;
  const limit = chunk?.limit ?? plan.jobs.length;
  const slice = plan.jobs.slice(offset, offset + limit);
  const isLastChunk = offset + limit >= plan.jobs.length;

  const r = await processJobs(supa, slice, { budgetMs: 45_000 });
  const errors = [...r.errors];
  if (isLastChunk) errors.push(...(await runEnrichment(supa, plan.profiles)));

  return {
    profiles: plan.profiles.length,
    hotels: plan.hotels,
    dates: plan.dates,
    rowsWritten: r.rowsWritten,
    errors: errors.slice(0, 10),
    total: plan.jobs.length,
    nextOffset: isLastChunk ? null : offset + limit,
  };
}
