// Whether the market is filling up or emptying out, from the air.
//
// A hotel's demand is mostly people arriving, and the nearest commercial
// airport is the one public, daily, forward-looking signal of that which does
// not cost anything. OpenSky Network publishes flight arrivals and departures
// per airport from a network of community ADS-B receivers, free and without a
// key.
//
// What that means, honestly: these are counts of flights their receivers saw,
// not passengers, and coverage varies by region. So the number on its own is
// not a fact about the airport — the *change* is the signal. Arrivals up a
// third on last Tuesday is worth knowing whatever the absolute count is, and
// that is how it is presented.
//
// Counts are cached per airport per day. A past day never changes, so it is
// fetched once and read forever after; only today is ever re-fetched, and the
// free tier is generous enough for that.

import type { SupabaseClient } from "@supabase/supabase-js";

const OPENSKY = "https://opensky-network.org/api";

export interface AirportDay {
  day: string;
  arrivals: number;
  departures: number;
}

export interface NearestAirport {
  icao: string;
  name: string;
  distanceMiles: number;
}

/** Midnight-to-midnight in UTC, as the unix seconds OpenSky wants. */
function dayWindow(day: string): { begin: number; end: number } {
  const start = Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000);
  return { begin: start, end: start + 86_400 };
}

async function countFlights(icao: string, day: string, kind: "arrival" | "departure"): Promise<number | null> {
  const { begin, end } = dayWindow(day);
  const url = `${OPENSKY}/flights/${kind}?airport=${encodeURIComponent(icao)}&begin=${begin}&end=${end}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "RateBeacon/1.0 (hotel demand signal)" },
      signal: AbortSignal.timeout(15_000),
    });
    // 404 is OpenSky's answer for "no flights recorded", which is a zero, not
    // a failure. Anything else means we learned nothing and should not cache.
    if (res.status === 404) return 0;
    if (!res.ok) return null;
    const json = (await res.json()) as unknown[];
    return Array.isArray(json) ? json.length : null;
  } catch {
    return null;
  }
}

/**
 * The nearest airport to a point, found once and remembered on the hotel.
 *
 * OpenStreetMap tags aerodromes with their ICAO code, which is exactly what
 * the flight feed keys on — so the same source that finds neighbouring hotels
 * finds the airport, and no new dependency is needed.
 */
export async function nearestAirport(
  supa: SupabaseClient,
  hotelId: string,
  latitude: number,
  longitude: number
): Promise<NearestAirport | null> {
  const { data: hotel } = await supa
    .from("hotels")
    .select("nearest_airport, nearest_airport_name, nearest_airport_miles")
    .eq("hotel_id", hotelId)
    .maybeSingle<{
      nearest_airport: string | null;
      nearest_airport_name: string | null;
      nearest_airport_miles: number | null;
    }>();

  if (hotel?.nearest_airport) {
    return {
      icao: hotel.nearest_airport,
      name: hotel.nearest_airport_name ?? hotel.nearest_airport,
      distanceMiles: Number(hotel.nearest_airport_miles ?? 0),
    };
  }

  // Widening rings: a city airport first, and only then the regional one an
  // hour away, so a hotel is not attributed to an airport nobody flies into
  // for it.
  for (const radius of [25, 60]) {
    const found = await airportsNear(latitude, longitude, radius);
    if (found.length === 0) continue;
    const best = found[0];
    await supa
      .from("hotels")
      .update({
        nearest_airport: best.icao,
        nearest_airport_name: best.name,
        nearest_airport_miles: Math.round(best.distanceMiles * 10) / 10,
      })
      .eq("hotel_id", hotelId);
    return best;
  }
  return null;
}

/** Aerodromes with an ICAO code near a point, nearest first. */
async function airportsNear(
  latitude: number,
  longitude: number,
  radiusMiles: number
): Promise<NearestAirport[]> {
  const metres = Math.round(radiusMiles * 1609.34);
  const query = `
    [out:json][timeout:20];
    (
      node["aeroway"="aerodrome"]["icao"](around:${metres},${latitude},${longitude});
      way["aeroway"="aerodrome"]["icao"](around:${metres},${latitude},${longitude});
    );
    out center 20;
  `;
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "RateBeacon/1.0 (hotel demand signal)",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      elements?: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[];
    };
    const R = 3958.8;
    const toRad = (d: number) => (d * Math.PI) / 180;

    return (json.elements ?? [])
      .map((el) => {
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        const icao = el.tags?.icao;
        if (lat == null || lon == null || !icao) return null;
        const dLat = toRad(lat - latitude);
        const dLon = toRad(lon - longitude);
        const h =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(latitude)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
        return {
          icao,
          name: el.tags?.name ?? icao,
          distanceMiles: 2 * R * Math.asin(Math.sqrt(h)),
        };
      })
      .filter((a): a is NearestAirport => a !== null)
      .sort((a, b) => a.distanceMiles - b.distanceMiles);
  } catch {
    return [];
  }
}

/**
 * Daily arrivals and departures for the last `days` days, cached.
 *
 * Yesterday backwards is settled history and is fetched once. Today is still
 * accumulating, so it is refreshed when it is more than an hour stale.
 */
export async function airportTraffic(
  supa: SupabaseClient,
  icao: string,
  days: number
): Promise<AirportDay[]> {
  const wanted: string[] = [];
  for (let i = days; i >= 1; i--) {
    wanted.push(new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10));
  }

  const { data: cached } = await supa
    .from("airport_traffic")
    .select("day, arrivals, departures, fetched_at")
    .eq("icao", icao)
    .in("day", wanted)
    .returns<{ day: string; arrivals: number; departures: number; fetched_at: string }[]>();

  const have = new Map((cached ?? []).map((r) => [r.day, r]));
  const missing = wanted.filter((d) => !have.has(d));

  // Bounded per request: the free feed is shared, and a gap fills itself over
  // the following days rather than in one burst.
  for (const day of missing.slice(0, 4)) {
    const [arrivals, departures] = await Promise.all([
      countFlights(icao, day, "arrival"),
      countFlights(icao, day, "departure"),
    ]);
    if (arrivals == null || departures == null) continue;
    const row = { icao, day, arrivals, departures, fetched_at: new Date().toISOString() };
    await supa.from("airport_traffic").upsert(row, { onConflict: "icao,day" });
    have.set(day, row);
  }

  return wanted
    .map((day) => have.get(day))
    .filter((r): r is { day: string; arrivals: number; departures: number; fetched_at: string } => r != null)
    .map((r) => ({ day: r.day, arrivals: r.arrivals, departures: r.departures }));
}

/** Day-over-day and week-over-week movement, for the caller to state plainly. */
export function trendOf(series: AirportDay[], grouping: "day" | "week"): {
  points: { label: string; arrivals: number; departures: number }[];
  changePct: number | null;
} {
  if (grouping === "day") {
    const points = series.map((d) => ({
      label: new Date(`${d.day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
      arrivals: d.arrivals,
      departures: d.departures,
    }));
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    const changePct =
      last && prev && prev.arrivals > 0 ? ((last.arrivals - prev.arrivals) / prev.arrivals) * 100 : null;
    return { points, changePct };
  }

  // Rolling seven-day blocks back from the most recent day, so "this week" is
  // the last seven days rather than whatever the calendar says. A leading
  // block with fewer than seven days is dropped: comparing two days against
  // seven would report a tripling that did not happen.
  const weeks: { label: string; arrivals: number; departures: number }[] = [];
  for (let i = series.length; i >= 7; i -= 7) {
    const chunk = series.slice(i - 7, i);
    weeks.unshift({
      label: `w/c ${new Date(`${chunk[0].day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`,
      arrivals: chunk.reduce((a, d) => a + d.arrivals, 0),
      departures: chunk.reduce((a, d) => a + d.departures, 0),
    });
  }
  const last = weeks[weeks.length - 1];
  const prev = weeks[weeks.length - 2];
  const changePct =
    last && prev && prev.arrivals > 0 ? ((last.arrivals - prev.arrivals) / prev.arrivals) * 100 : null;
  return { points: weeks, changePct };
}
