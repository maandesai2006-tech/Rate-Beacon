// Telling an outage from a market.
//
// On a normal morning about one hotel-night in a hundred comes back with no
// bookable offer: a genuinely full hotel, or a gap in the sellers. On the days
// the rate source throttles us, every lookup comes back empty. The collector
// used to record both the same way, so seven days in September were stored as
// "every hotel in Destin and Pensacola is sold out for a month", the grid
// painted them as sellouts, and the demand forecast read them as compression.
//
// Two checks, because an outage can arrive two ways:
//
//  - The source errors. Each lookup says so, and a handful in a row across
//    several hotels is enough to stop: the fast breaker.
//  - The source answers, with nothing. A single empty answer is a real market
//    fact, and a festival night can empty most of a town, so this is judged on
//    the whole run instead: when most of a day's lookups so far are empty, that
//    is not a market, it is the source.
//
// Kept free of imports so the rules can be tested directly.

export type LookupOutcome = "priced" | "no_offers" | "failed";

export interface FastBreakerPolicy {
  /** How many of the most recent lookups to judge. */
  window: number;
  /** Fewer lookups than this says nothing yet. */
  minSample: number;
  /** Share of the window that must have failed. */
  failedShare: number;
  /** Failures must span this many hotels, so one bad hotel key cannot stall a run. */
  minHotels: number;
}

export const FAST_BREAKER: FastBreakerPolicy = { window: 12, minSample: 8, failedShare: 0.75, minHotels: 3 };

/** Whether the latest lookups say the rate source itself is failing. */
export function sourceFailing(
  outcomes: { hotelId: string; outcome: LookupOutcome }[],
  policy: FastBreakerPolicy = FAST_BREAKER
): boolean {
  const recent = outcomes.slice(-policy.window);
  if (recent.length < policy.minSample) return false;
  const failed = recent.filter((o) => o.outcome === "failed");
  if (failed.length / recent.length < policy.failedShare) return false;
  return new Set(failed.map((o) => o.hotelId)).size >= policy.minHotels;
}

export interface RunSanityPolicy {
  /** Never judge a run on fewer lookups than this... */
  floor: number;
  /** ...nor on more than this before deciding. */
  ceiling: number;
  /** Share of lookups with no price above which the run is not believable. */
  unpricedShare: number;
}

export const RUN_SANITY: RunSanityPolicy = { floor: 16, ceiling: 64, unpricedShare: 0.6 };

/**
 * Whether a day's collection so far is too empty to be a market.
 *
 * Healthy days run about one percent unpriced. A real sellout concentrates on
 * a night or a weekend in one town; it does not empty most of every market
 * across a run. The sample needed scales with the day's size so a two-hotel
 * account is still judged, but never on a handful of lookups.
 */
export function runLooksDegraded(
  lookups: number,
  unpriced: number,
  plannedTotal: number,
  policy: RunSanityPolicy = RUN_SANITY
): boolean {
  const needed = Math.max(policy.floor, Math.min(policy.ceiling, Math.ceil(plannedTotal / 2)));
  if (lookups < needed) return false;
  return unpriced / lookups >= policy.unpricedShare;
}

/** How long to leave a failing source alone before probing it again. */
export const BACKOFF_MINUTES = 30;
/**
 * A second outage the same day waits longer. A run-level probe costs dozens
 * of lookups, and re-probing a source that is still throttling every thirty
 * minutes would spend more calls on a dead day than a healthy day uses.
 */
export const REPEAT_BACKOFF_MINUTES = 120;

export function pauseUntil(now: Date, minutes: number = BACKOFF_MINUTES): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

/** Errors recorded against a run for a source outage carry this prefix. */
export const SOURCE_ERROR_PREFIX = "source: ";
