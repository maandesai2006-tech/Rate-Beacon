import type { SupabaseClient } from "@supabase/supabase-js";
import { computeForecast } from "./forecast";
import { forecastCompIds, forecastContextKey, type ForecastHotel } from "./forecast-market";
import { advanceForecastTasks, FORECAST_HORIZON, loadForecastSnapshots } from "./forecast-storage";
import { addDaysISO, dateRange } from "./dates";

export interface ForecastMarket {
  profileId: number;
  hotelId: string;
  compHotelIds: string[];
  hotelNames: Record<string, string>;
  currency: string;
  horizonDays: number;
  contextKey: string;
}

interface MarketLink {
  hotel_id: string;
  is_mine: boolean;
  hotels: Omit<ForecastHotel, "hotel_id"> | null;
}

/** The caller must validate the profile's account; no service-role fallback here. */
export async function loadForecastMarkets(
  supa: SupabaseClient,
  profile: { id: number; currency: string; horizon_days: number; compset_radius_miles: number }
): Promise<ForecastMarket[]> {
  const [links, edges] = await Promise.all([
    supa.from("profile_hotels")
      .select("hotel_id,is_mine,hotels(name,latitude,longitude)").eq("profile_id", profile.id)
      .order("hotel_id").limit(501).returns<MarketLink[]>(),
    supa.from("baseline_comps").select("baseline_hotel_id,comp_hotel_id")
      .eq("profile_id", profile.id).order("baseline_hotel_id").order("comp_hotel_id")
      .limit(1000).returns<{ baseline_hotel_id: string; comp_hotel_id: string }[]>(),
  ]);
  if (links.error || edges.error) throw new Error(`Could not read the competitive set: ${links.error?.message ?? edges.error?.message}`);
  if ((links.data?.length ?? 0) > 500 || (edges.data?.length ?? 0) >= 1000) {
    throw new Error("The configured competitive sets exceed the forecast collection limit.");
  }
  const hotels: ForecastHotel[] = (links.data ?? []).map((l) => ({
    hotel_id: l.hotel_id, name: l.hotels?.name ?? l.hotel_id,
    latitude: l.hotels?.latitude ?? null, longitude: l.hotels?.longitude ?? null,
  }));
  const hotelNames = Object.fromEntries(hotels.map((h) => [h.hotel_id, h.name]));
  return (links.data ?? []).filter((l) => l.is_mine).map((baseline) => {
    const compHotelIds = forecastCompIds(baseline.hotel_id,
      (edges.data ?? []).filter((e) => e.baseline_hotel_id === baseline.hotel_id).map((e) => e.comp_hotel_id),
      hotels, profile.compset_radius_miles);
    return {
      profileId: profile.id, hotelId: baseline.hotel_id, compHotelIds, hotelNames,
      currency: profile.currency,
      horizonDays: Math.max(1, Math.min(FORECAST_HORIZON, profile.horizon_days)),
      contextKey: forecastContextKey(baseline.hotel_id, compHotelIds, profile.currency),
    };
  });
}

export async function computeMarketForecasts(
  supa: SupabaseClient, market: ForecastMarket, asOf: string, deadline = Infinity
): Promise<void> {
  const snapshots = await loadForecastSnapshots(supa,
    [market.hotelId, ...market.compHotelIds], market.currency,
    asOf, addDaysISO(asOf, market.horizonDays - 1), { deadline });
  const computedAt = new Date().toISOString();
  const rows = dateRange(asOf, market.horizonDays).map((checkIn) => {
    if (Date.now() >= deadline) throw new Error("Forecast computation reached its time budget; it will retry.");
    const forecast = computeForecast({ ...market, asOf, checkIn, snapshots });
    return {
      profile_id: market.profileId, hotel_id: market.hotelId, check_in: checkIn,
      demand_score: forecast.demandScore, forecast_median: forecast.forecastMedian,
      suggested_low: forecast.suggestedLow, suggested_high: forecast.suggestedHigh,
      confidence: forecast.confidence, signals: forecast.signals, forecast,
      computed_at: computedAt, context_key: market.contextKey,
    };
  });
  const { error } = await supa.from("demand_forecasts").upsert(rows, { onConflict: "profile_id,hotel_id,check_in" });
  if (error) throw new Error(`Could not save demand forecasts: ${error.message}`);
}

/** Background-only cross-account task; request handlers never invoke it. */
export async function tickForecasts(
  supa: SupabaseClient, runDate: string, cursor: number, deadline: number
): Promise<{ cursor: number; complete: boolean }> {
  const { data, error } = await supa.from("profiles")
    .select("id,currency,horizon_days,compset_radius_miles").order("id").limit(501)
    .returns<{ id: number; currency: string; horizon_days: number; compset_radius_miles: number }[]>();
  if (error) throw new Error(`Could not read forecast profiles: ${error.message}`);
  if ((data?.length ?? 0) > 500) throw new Error("Forecast profile limit reached; no partial run was marked complete.");
  const { data: baselines, error: baselineError } = await supa.from("profile_hotels")
    .select("profile_id,hotel_id").eq("is_mine", true)
    .order("profile_id").order("hotel_id").limit(1000)
    .returns<{ profile_id: number; hotel_id: string }[]>();
  if (baselineError) throw new Error(`Could not read forecast hotels: ${baselineError.message}`);
  if ((baselines?.length ?? 0) >= 1000) throw new Error("Forecast hotel limit reached; no partial run was marked complete.");
  const profiles = new Map((data ?? []).map((profile) => [profile.id, profile]));
  // Cursor is by hotel, so a slower hotel cannot force already saved hotels
  // to repeat on every tick. Setup changes queue a new collection from zero.
  return advanceForecastTasks(baselines ?? [], cursor, deadline, async (task) => {
    const profile = profiles.get(task.profile_id);
    if (!profile) throw new Error("Forecast profile changed during collection; refresh to start a new run.");
    const market = (await loadForecastMarkets(supa, profile)).find((m) => m.hotelId === task.hotel_id);
    if (!market) throw new Error("Forecast hotel changed during collection; refresh to start a new run.");
    await computeMarketForecasts(supa, market, runDate, deadline);
  }, async (nextCursor) => {
    const { error: checkpointError } = await supa.from("collection_runs")
      .update({ forecast_cursor: nextCursor }).eq("run_date", runDate);
    if (checkpointError) throw new Error(`Could not checkpoint forecasts: ${checkpointError.message}`);
  });
}
