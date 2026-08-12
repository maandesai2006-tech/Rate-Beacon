import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// Forecast over whatever the map is showing, as a grid of samples per frame.
//
// Open-Meteo is free and keyless and takes a list of coordinates in one
// request, so a grid across the visible bounds costs a single call. The client
// draws that grid to a small offscreen canvas and scales it up with smoothing,
// which is what turns 49 samples into a continuous radar-style field.
//
// Ranges:
//   12h / 24h  hourly frames, starting at the current hour
//   7d         one frame per day, using the day's high and total rainfall

const GRID = 7; // 7×7 = 49 samples — the field reads as continuous once smoothed

type Range = "12h" | "24h" | "7d";

interface OpenMeteoLocation {
  latitude: number;
  longitude: number;
  hourly?: Record<string, (number | null)[] | string[]>;
  daily?: Record<string, (number | null)[] | string[]>;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const bboxRaw = q.get("bbox");
  const range = (q.get("range") ?? "12h") as Range;
  if (!["12h", "24h", "7d"].includes(range)) {
    return NextResponse.json({ error: "range must be 12h, 24h or 7d" }, { status: 400 });
  }
  if (!bboxRaw) {
    return NextResponse.json({ error: "bbox=south,west,north,east is required" }, { status: 400 });
  }
  const parts = bboxRaw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return NextResponse.json({ error: "bbox must be four numbers" }, { status: 400 });
  }
  const [south, west, north, east] = parts;
  if (south >= north || west >= east) {
    return NextResponse.json({ error: "bbox is inverted" }, { status: 400 });
  }

  // Sample cell centres so the field covers the view evenly. Row-major from
  // the north-west corner, which is the order the client's canvas expects.
  const lats: number[] = [];
  const lons: number[] = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      lats.push(north - ((i + 0.5) / GRID) * (north - south));
      lons.push(west + ((j + 0.5) / GRID) * (east - west));
    }
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lats.map((v) => v.toFixed(4)).join(","));
  url.searchParams.set("longitude", lons.map((v) => v.toFixed(4)).join(","));
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", "auto");

  if (range === "7d") {
    url.searchParams.set(
      "daily",
      "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max"
    );
    url.searchParams.set("forecast_days", "7");
  } else {
    url.searchParams.set(
      "hourly",
      "temperature_2m,precipitation,precipitation_probability,cloud_cover,wind_speed_10m"
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
    // One coordinate returns an object; several return an array.
    const locations: OpenMeteoLocation[] = Array.isArray(json) ? json : [json];
    const frames =
      range === "7d" ? dailyFrames(locations, lats, lons) : hourlyFrames(locations, lats, lons, range);

    if (frames.length === 0) {
      return NextResponse.json({ error: "Open-Meteo returned no forecast" }, { status: 502 });
    }

    return NextResponse.json({
      range,
      grid: GRID,
      bbox: { south, west, north, east },
      frames,
      units: { temperature: "°F", precipitation: "in", wind: "mph" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach Open-Meteo: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}

interface Cell {
  latitude: number;
  longitude: number;
  temperature: number | null;
  precipitation: number | null;
  precipitationChance: number | null;
  cloudCover: number | null;
  windSpeed: number | null;
}

function numAt(series: unknown, index: number): number | null {
  if (!Array.isArray(series)) return null;
  const v = series[index];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function hourlyFrames(
  locations: OpenMeteoLocation[],
  lats: number[],
  lons: number[],
  range: Range
): { time: string; cells: Cell[] }[] {
  const times = locations[0]?.hourly?.time;
  if (!Array.isArray(times) || times.length === 0) return [];

  // Start at the current hour rather than at midnight.
  const now = Date.now();
  let start = (times as string[]).findIndex((t) => new Date(t).getTime() >= now - 3600_000);
  if (start < 0) start = 0;
  const count = range === "24h" ? 24 : 12;
  const end = Math.min(start + count, times.length);

  const frames = [];
  for (let h = start; h < end; h++) {
    frames.push({
      time: (times as string[])[h],
      cells: locations.map((loc, idx) => ({
        latitude: loc.latitude ?? lats[idx],
        longitude: loc.longitude ?? lons[idx],
        temperature: numAt(loc.hourly?.temperature_2m, h),
        precipitation: numAt(loc.hourly?.precipitation, h),
        precipitationChance: numAt(loc.hourly?.precipitation_probability, h),
        cloudCover: numAt(loc.hourly?.cloud_cover, h),
        windSpeed: numAt(loc.hourly?.wind_speed_10m, h),
      })),
    });
  }
  return frames;
}

function dailyFrames(
  locations: OpenMeteoLocation[],
  lats: number[],
  lons: number[]
): { time: string; cells: Cell[] }[] {
  const days = locations[0]?.daily?.time;
  if (!Array.isArray(days) || days.length === 0) return [];

  const frames = [];
  for (let d = 0; d < days.length; d++) {
    frames.push({
      time: (days as string[])[d],
      cells: locations.map((loc, idx) => ({
        latitude: loc.latitude ?? lats[idx],
        longitude: loc.longitude ?? lons[idx],
        // The day's high is what a guest feels and what a rate reacts to.
        temperature: numAt(loc.daily?.temperature_2m_max, d),
        precipitation: numAt(loc.daily?.precipitation_sum, d),
        precipitationChance: numAt(loc.daily?.precipitation_probability_max, d),
        cloudCover: null,
        windSpeed: numAt(loc.daily?.wind_speed_10m_max, d),
      })),
    });
  }
  return frames;
}
