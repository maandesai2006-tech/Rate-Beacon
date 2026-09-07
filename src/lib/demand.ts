/**
 * Thresholds for translating a stored 0-100 demand-pressure score into plain
 * language. Previously restated (and re-explained) independently in the rate
 * grid caption, the evidence drawer and the summary stats — one definition
 * keeps them from drifting apart.
 */
export const DEMAND_NEUTRAL = 50;
export const DEMAND_HIGH = 65;
export const DEMAND_LOW = 35;

export function demandPressureLabel(score: number): "Higher pressure" | "Lower pressure" | "Near neutral" {
  return score >= DEMAND_HIGH ? "Higher pressure" : score <= DEMAND_LOW ? "Lower pressure" : "Near neutral";
}
