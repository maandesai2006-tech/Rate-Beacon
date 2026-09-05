import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { anchorForProfile } from "@/lib/compset";
import { airportTraffic, nearestAirport, trendOf } from "@/lib/flights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Arrivals and departures at the airport nearest the property.
//
// The one free, daily, public signal of whether a market is filling up. Day
// over day, or week over week.
export async function GET(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa, shared } = auth;

  const q = req.nextUrl.searchParams;
  const grouping = q.get("grouping") === "week" ? "week" : "day";

  const { data: profile } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", Number(q.get("profileId")) || -1)
    .maybeSingle<{ id: number }>();
  if (!profile) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });

  const { anchor } = await anchorForProfile(supa, profile.id, {
    shared,
    baselineHotelId: q.get("baselineHotelId"),
  });
  if (!anchor?.baselineHotelId) {
    return NextResponse.json({ points: [], note: "Place your hotel first and this fills in." });
  }

  const airport = await nearestAirport(shared, anchor.baselineHotelId, anchor.latitude, anchor.longitude);
  if (!airport) {
    return NextResponse.json({ points: [], note: "No airport with published traffic near this property." });
  }

  // Four weeks covers a week-over-week view with something to compare against.
  const series = await airportTraffic(shared, airport.icao, grouping === "week" ? 28 : 14);
  const { points, changePct } = trendOf(series, grouping);

  return NextResponse.json({
    airport: { icao: airport.icao, name: airport.name, milesAway: Math.round(airport.distanceMiles) },
    grouping,
    points,
    changePct: changePct == null ? null : Math.round(changePct),
    note:
      points.length === 0
        ? "No flight counts yet — they fill in over the next few days."
        : null,
  });
}
