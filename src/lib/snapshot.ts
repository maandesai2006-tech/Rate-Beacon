import type { SupabaseClient } from "@supabase/supabase-js";
import { getRates } from "./xotelo";
import { addDaysISO, dateRange, todayISO } from "./dates";
import { refreshEvents, refreshGeo, refreshRatings } from "./enrich";
import type { Profile } from "./types";

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
        .select("profile_id, hotel_id")
        .returns<{ profile_id: number; hotel_id: string }[]>(),
      supa
        .from("hotels")
        .select("hotel_id, name")
        .returns<{ hotel_id: string; name: string }[]>(),
    ]);

  if (!profiles?.length || !links?.length) {
    return { jobs: [], profiles: profiles ?? [], hotels: 0, dates: 0, note: "No profiles configured yet" };
  }

  const nameById = new Map(hotelRows?.map((h) => [h.hotel_id, h.name]) ?? []);
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const tracked = new Map<string, TrackedHotel>();
  for (const link of links) {
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
  const today = todayISO();
  const dates = dateRange(today, maxHorizon);

  // Date-major, so the nights a dashboard actually shows are priced first and
  // a run that is still in progress is still useful. Far nights are only
  // priced on the days they are due — see isDueToday.
  const all = dates.flatMap((checkIn, dayIdx) =>
    [...tracked.values()]
      .filter((h) => dayIdx < h.horizon)
      .filter((h) => isDueToday(dayIdx, h.hotel_id, today))
      .map((hotel) => ({ checkIn, hotel }))
  );

  // A ceiling on the day's upstream calls, so one runaway market cannot starve
  // every other customer's collection. Date-major ordering means what is cut
  // is the far end of the horizon, never tonight.
  const budget = dailyBudget();
  const jobs = all.length > budget ? all.slice(0, budget) : all;
  const note =
    all.length > budget
      ? `Daily budget of ${budget} lookups reached; ${all.length - budget} far-horizon nights deferred.`
      : null;

  return { jobs, profiles, hotels: tracked.size, dates: dates.length, note };
}

/**
 * Whether a hotel-night is due for pricing today.
 *
 * Nobody prices day seventy every morning. The near horizon moves daily and is
 * what the grid shows, so it is priced daily; the middle moves weekly and is
 * priced twice a week; the far end barely moves and is priced weekly. That is
 * roughly an eighty percent cut in lookups for nothing anyone would notice —
 * the difference between fifty customers fitting overnight and not.
 *
 * Which day a far night lands on is spread by hotel and date rather than fixed
 * to Mondays, so the load is flat across the week instead of spiking.
 */
export function isDueToday(dayIdx: number, hotelId: string, today: string): boolean {
  const cadence = dayIdx < NEAR_NIGHTS ? 1 : dayIdx < MID_NIGHTS ? 3 : 7;
  if (cadence === 1) return true;
  const dayNumber = Math.floor(new Date(`${today}T00:00:00Z`).getTime() / 86_400_000);
  return (dayNumber + dayIdx + hashOf(hotelId)) % cadence === 0;
}

/** Nights ahead priced every day. */
export const NEAR_NIGHTS = 14;
/** Nights ahead priced every third day; beyond this, weekly. */
export const MID_NIGHTS = 45;

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function dailyBudget(): number {
  const raw = Number(process.env.RATE_LOOKUP_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50_000;
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
