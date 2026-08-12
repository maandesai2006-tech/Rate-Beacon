import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accountForSession, SESSION_COOKIE } from "@/lib/auth";
import { geocodeHotel } from "@/lib/geo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Forecast at each of the profile's own hotels.
//
// Open-Meteo takes a list of coordinates in one request and needs no key, so
// every hotel is covered by a single call regardless of how many there are.
// The ranges line up with the map's timeline: 12 and 24 hours are hourly, 7
// days is daily highs and lows.

type Range = "12h" | "24h" | "7d";

interface OpenMeteoLocation {
  latitude?: number;
  longitude?: number;
  hourly?: Record<string, (number | null)[] | string[]>;
  daily?: Record<string, (number | null)[] | string[]>;
}

export async function GET(req: NextRequest) {
  const supa = db();
  const accountId = await accountForSession(supa, req.cookies.get(SESSION_COOKIE)?.value);
  if (!accountId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });

  const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;
  const range = (req.nextUrl.searchParams.get("range") ?? "12h") as Range;
  if (!["12h", "24h", "7d"].includes(range)) {
    return NextResponse.json({ error: "range must be 12h, 24h or 7d" }, { status: 400 });
  }

  const { data: profile } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", profileId ?? -1)
    .maybeSingle<{ id: number }>();
  if (!profile) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });

  const { data: tracked } = await supa
    .from("profile_hotels")
    .select("hotel_id, hotels(name, latitude, longitude)")
    .eq("profile_id", profile.id)
    .eq("is_mine", true)
    .returns<
      { hotel_id: string; hotels: { name: string; latitude: number | null; longitude: number | null } | null }[]
    >();

  const candidates = (tracked ?? []).map((t) => ({
    hotelId: t.hotel_id,
    name: t.hotels?.name ?? t.hotel_id,
    latitude: t.hotels?.latitude ?? null,
    longitude: t.hotels?.longitude ?? null,
  }));

  // Telling someone to "run the geocoder" is not an answer when there is no
  // geocoder button. A property with no coordinates is placed here and then,
  // and the result is written back so it only ever happens once.
  const missing = candidates.filter((h) => h.latitude == null || h.longitude == null);
  if (missing.length > 0) {
    const { data: p } = await supa
      .from("profiles")
      .select("city_name")
      .eq("id", profile.id)
      .maybeSingle<{ city_name: string | null }>();
    const near = p?.city_name ?? null;

    for (const h of missing.slice(0, 4)) {
      let geo = await geocodeHotel(h.name, near);
      if (!geo) {
        const trimmed = h.name
          .replace(/\s+by\s+(ihg|marriott|hilton|wyndham|choice|hyatt)\b.*$/i, "")
          .replace(/\s*[-–—]\s*[^-–—]*$/, "")
          .trim();
        if (trimmed && trimmed !== h.name) geo = await geocodeHotel(trimmed, near);
      }
      if (!geo) continue;
      h.latitude = geo.latitude;
      h.longitude = geo.longitude;
      await supa
        .from("hotels")
        .update({
          latitude: geo.latitude,
          longitude: geo.longitude,
          address: geo.address,
          geo_updated_at: new Date().toISOString(),
        })
        .eq("hotel_id", h.hotelId);
    }
  }

  const hotels = candidates.filter(
    (h): h is { hotelId: string; name: string; latitude: number; longitude: number } =>
      h.latitude != null && h.longitude != null
  );

  if (hotels.length === 0) {
    return NextResponse.json({
      range,
      hotels: [],
      note: "Could not place any of your hotels on the map, so there is nowhere to read a forecast from. Check the hotel names on the profile.",
    });
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", hotels.map((h) => h.latitude.toFixed(4)).join(","));
  url.searchParams.set("longitude", hotels.map((h) => h.longitude.toFixed(4)).join(","));
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", "auto");

  if (range === "7d") {
    url.searchParams.set(
      "daily",
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max"
    );
    url.searchParams.set("forecast_days", "7");
  } else {
    url.searchParams.set(
      "hourly",
      "weather_code,temperature_2m,precipitation_probability,wind_speed_10m"
    );
    url.searchParams.set("forecast_days", range === "24h" ? "3" : "2");
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "RateBeacon/1.0 (hotel rate dashboard)" },
      next: { revalidate: 1800 },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Open-Meteo returned ${res.status}` }, { status: 502 });
    }
    const json = await res.json();
    const locations: OpenMeteoLocation[] = Array.isArray(json) ? json : [json];

    const out = hotels.map((hotel, i) => ({
      hotelId: hotel.hotelId,
      name: hotel.name,
      points: range === "7d" ? dailyPoints(locations[i]) : hourlyPoints(locations[i], range),
    }));

    return NextResponse.json({ range, hotels: out });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach Open-Meteo: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}

interface ForecastPoint {
  time: string;
  code: number | null;
  temperature: number | null;
  temperatureMin: number | null;
  precipitationChance: number | null;
  windSpeed: number | null;
}

function numAt(series: unknown, i: number): number | null {
  if (!Array.isArray(series)) return null;
  const v = series[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function hourlyPoints(loc: OpenMeteoLocation | undefined, range: Range): ForecastPoint[] {
  const times = loc?.hourly?.time;
  if (!Array.isArray(times) || times.length === 0) return [];
  // Start at the current hour rather than at midnight.
  const now = Date.now();
  let start = (times as string[]).findIndex((t) => new Date(t).getTime() >= now - 3600_000);
  if (start < 0) start = 0;
  const end = Math.min(start + (range === "24h" ? 24 : 12), times.length);

  const out: ForecastPoint[] = [];
  for (let i = start; i < end; i++) {
    out.push({
      time: (times as string[])[i],
      code: numAt(loc?.hourly?.weather_code, i),
      temperature: numAt(loc?.hourly?.temperature_2m, i),
      temperatureMin: null,
      precipitationChance: numAt(loc?.hourly?.precipitation_probability, i),
      windSpeed: numAt(loc?.hourly?.wind_speed_10m, i),
    });
  }
  return out;
}

function dailyPoints(loc: OpenMeteoLocation | undefined): ForecastPoint[] {
  const days = loc?.daily?.time;
  if (!Array.isArray(days) || days.length === 0) return [];
  const out: ForecastPoint[] = [];
  for (let i = 0; i < days.length; i++) {
    out.push({
      time: (days as string[])[i],
      code: numAt(loc?.daily?.weather_code, i),
      temperature: numAt(loc?.daily?.temperature_2m_max, i),
      temperatureMin: numAt(loc?.daily?.temperature_2m_min, i),
      precipitationChance: numAt(loc?.daily?.precipitation_probability_max, i),
      windSpeed: numAt(loc?.daily?.wind_speed_10m_max, i),
    });
  }
  return out;
}
