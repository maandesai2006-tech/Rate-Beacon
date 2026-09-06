import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemandForecast, ForecastSnapshot } from "./forecast";

export const FORECAST_HORIZON = 45;
export const FORECAST_HISTORY_DAYS = 120;
export const FORECAST_MAX_ROWS = 60_000;

/** Postgres numeric may arrive as a decimal string via a database transport. */
export function normalizeForecastSnapshot(row: Omit<ForecastSnapshot, "price"> & { price: number | string | null }): ForecastSnapshot {
  return { ...row, price: typeof row.price === "string"
    ? (row.price.trim() ? Number(row.price) : NaN) : row.price };
}

/** Complete bounded input, or an explicit failure. Never forecast a truncated query. */
export async function loadForecastSnapshots(
  supa: SupabaseClient,
  hotelIds: string[],
  currency: string,
  asOf: string,
  lastStay: string,
  { maxRows = FORECAST_MAX_ROWS, deadline = Infinity }: { maxRows?: number; deadline?: number } = {}
): Promise<ForecastSnapshot[]> {
  if (!hotelIds.length) return [];
  if (hotelIds.length > 100) throw new Error("This forecast exceeds the 100-hotel data limit. Narrow the competitive set.");
  const since = new Date(`${asOf}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - FORECAST_HISTORY_DAYS);
  const earliest = since.toISOString().slice(0, 10);
  const rows: ForecastSnapshot[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset <= maxRows; offset += pageSize) {
    if (Date.now() >= deadline) throw new Error("Forecast history read reached its time budget; it will retry.");
    // A stable unique ordering avoids overlap between pages. Captures are one
    // row per hotel / stay / observation date, not just latest_rates.
    const query = supa.from("rate_snapshots")
      .select("hotel_id,check_in,captured_on,price,available,is_anomaly,currency")
      .in("hotel_id", [...new Set(hotelIds)])
      .eq("currency", currency)
      .gte("captured_on", earliest).lte("captured_on", asOf)
      .gte("check_in", earliest).lte("check_in", lastStay)
      .order("id", { ascending: true })
      .range(offset, Math.min(offset + pageSize - 1, maxRows));
    if (Number.isFinite(deadline)) query.abortSignal(AbortSignal.timeout(Math.max(1, deadline - Date.now())));
    const { data, error } = await query.returns<ForecastSnapshot[]>();
    if (error) throw new Error(`Forecast history unavailable: ${error.message}`);
    const page = data ?? [];
    rows.push(...page.map(normalizeForecastSnapshot));
    if (rows.length > maxRows) throw new Error(`Forecast history exceeds the ${maxRows.toLocaleString()}-row safety limit. No partial forecast was produced.`);
    if (page.length < pageSize) return rows;
  }
  return rows;
}

export interface StoredForecast {
  check_in: string;
  computed_at: string;
  context_key: string;
  forecast: DemandForecast;
}

export async function readStoredForecasts(
  supa: SupabaseClient,
  profileId: number,
  hotelId: string,
  asOf: string,
  lastStay: string,
  contextKey: string
): Promise<{ forecasts: StoredForecast[]; status: string | null }> {
  const { data, error } = await supa.from("demand_forecasts")
    .select("check_in,computed_at,context_key,forecast")
    .eq("profile_id", profileId).eq("hotel_id", hotelId)
    .eq("context_key", contextKey)
    .gte("check_in", asOf).lte("check_in", lastStay)
    .order("check_in").limit(FORECAST_HORIZON)
    .returns<StoredForecast[]>();
  if (error) {
    return { forecasts: [], status: "Demand forecasts are unavailable. Collection will retry once forecast storage is ready." };
  }
  const forecasts = (data ?? []).filter((row) =>
    row.forecast?.version === 1 && row.forecast.asOf === asOf &&
    row.forecast.hotelId === hotelId && row.forecast.checkIn === row.check_in);
  return {
    forecasts,
    status: forecasts.length ? null : "Demand forecasts will appear after rate collection completes for this competitive set.",
  };
}

/** One task is persisted before advancing. Errors/timeouts leave its cursor retryable. */
export async function advanceForecastTasks<T>(
  tasks: T[],
  cursor: number,
  deadline: number,
  run: (task: T) => Promise<void>,
  checkpoint: (nextCursor: number) => Promise<void>
): Promise<{ cursor: number; complete: boolean }> {
  let next = cursor;
  while (next < tasks.length && Date.now() < deadline) {
    await run(tasks[next]);
    await checkpoint(next + 1);
    next++;
  }
  return { cursor: next, complete: next >= tasks.length };
}
