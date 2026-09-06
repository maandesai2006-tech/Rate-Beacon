import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { backtestForecast } from "@/lib/forecast";
import { loadForecastMarkets } from "@/lib/forecast-service";
import { loadForecastSnapshots } from "@/lib/forecast-storage";
import { todayISO } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { supa, accountId } = auth;
  const profileId = Number(req.nextUrl.searchParams.get("profileId"));
  const baselineId = req.nextUrl.searchParams.get("baselineId");
  if (!Number.isSafeInteger(profileId) || profileId <= 0 || !baselineId) {
    return NextResponse.json({ error: "Choose a profile and hotel to evaluate." }, { status: 400 });
  }
  try {
    const { data: profile, error } = await supa.from("profiles")
      .select("id,currency,horizon_days,compset_radius_miles")
      .eq("id", profileId).eq("account_id", accountId)
      .maybeSingle<{ id: number; currency: string; horizon_days: number; compset_radius_miles: number }>();
    if (error) throw new Error("Could not read this profile.");
    if (!profile) return NextResponse.json({ error: "Profile not found." }, { status: 404 });
    const market = (await loadForecastMarkets(supa, profile)).find((m) => m.hotelId === baselineId);
    if (!market) return NextResponse.json({ error: "Hotel not found in this profile." }, { status: 404 });
    const asOf = todayISO();
    const snapshots = await loadForecastSnapshots(supa, [market.hotelId, ...market.compHotelIds],
      market.currency, asOf, asOf, { deadline: Date.now() + 35_000 });
    const backtest = backtestForecast({ ...market, asOf, snapshots, maxDates: 30 });
    backtest.limitations = [...new Set([...backtest.limitations,
      "Reconstruction uses today's configured competitive set; historic membership changes are not reconstructed.",
      "Published feed availability is a market proxy, not verified occupancy or achieved room revenue.",
      "Full captures are retained for 30 days, then one per hotel-night. Missing old captures cannot be reconstructed.",
    ])];
    return NextResponse.json({ backtest }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Backtest could not be completed." },
      { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
