import type { DemandForecast } from "./forecast";

export interface PricingHeadroom {
  /** What the compset is already charging for this date, right now. */
  basis: number | null;
  /** Midpoint of the engine's suggested range — one number for the plain-language view. */
  center: number | null;
  low: number | null;
  high: number | null;
  /** center vs basis: 0.08 means "8% above what the compset already asks". */
  pct: number | null;
}

/**
 * Restates the engine's already-computed suggested range (suggestedLow /
 * suggestedHigh) against the compset's current price level, so "how much
 * higher could this hotel price than the compset already charges" is one
 * plain figure instead of five separate fields the reader has to subtract
 * themselves. This computes nothing the engine didn't already produce — see
 * computeForecast in forecast.ts for suggestedLow/suggestedHigh.
 */
export function pricingHeadroom(
  forecast: Pick<DemandForecast, "currentMarketMedian" | "suggestedLow" | "suggestedHigh">
): PricingHeadroom {
  const { currentMarketMedian: basis, suggestedLow: low, suggestedHigh: high } = forecast;
  const center = low != null && high != null ? (low + high) / 2 : null;
  const pct = center != null && basis != null && basis > 0 ? center / basis - 1 : null;
  return { basis, center, low, high, pct };
}
