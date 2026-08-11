import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// Twelve hours of weather over whatever the map is showing.
//
// Open-Meteo is free and keyless and takes a list of coordinates in one
// request, so a grid across the visible bounds costs a single call. That gives
// the map a real spatial field to animate rather than one city-wide number
// repeated over the whole view.

const GRID = 4; // 4×4 = 16 sample points — enough to show a front moving across
const HOURS = 12;

interface OpenMeteoLocation {
  latitude: number;
  longitude: number;
  hourly?: {
    time: string[];
    temperature_2m?: (number | null)[];
    precipitation_probability?: (number | null)[];
    precipitation?: (number | null)[];
    cloud_cover?: (number | null)[];
    wind_speed_10m?: (number | null)[];
  };
}

export async function GET(req: NextRequest) {
  const bboxRaw = req.nextUrl.searchParams.get("bbox");
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

  // Sample the interior of the box: cell centres, not corners, so the field
  // covers the view evenly.
  const lats: number[] = [];
  const lons: number[] = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      lats.push(south + ((i + 0.5) / GRID) * (north - south));
      lons.push(west + ((j + 0.5) / GRID) * (east - west));
    }
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lats.map((v) => v.toFixed(4)).join(","));
  url.searchParams.set("longitude", lons.map((v) => v.toFixed(4)).join(","));
  url.searchParams.set(
    "hourly",
    "temperature_2m,precipitation,precipitation_probability,cloud_cover,wind_speed_10m"
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("timezone", "auto");

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "RateBeacon/1.0 (hotel rate dashboard)" },
      // Forecasts move hourly; a short cache keeps replays cheap.
      next: { revalidate: 1800 },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Open-Meteo returned ${res.status}` },
        { status: 502 }
      );
    }

    const json = await res.json();
    // One coordinate returns an object; several return an array.
    const locations: OpenMeteoLocation[] = Array.isArray(json) ? json : [json];
    const first = locations[0]?.hourly;
    if (!first?.time?.length) {
      return NextResponse.json({ error: "Open-Meteo returned no hourly data" }, { status: 502 });
    }

    // Start at the current hour rather than at midnight.
    const now = Date.now();
    let start = first.time.findIndex((t) => new Date(t).getTime() >= now - 3600_000);
    if (start < 0) start = 0;
    const end = Math.min(start + HOURS, first.time.length);

    const frames = [];
    for (let h = start; h < end; h++) {
      frames.push({
        time: first.time[h],
        cells: locations.map((loc, idx) => ({
          latitude: loc.latitude ?? lats[idx],
          longitude: loc.longitude ?? lons[idx],
          temperature: loc.hourly?.temperature_2m?.[h] ?? null,
          precipitation: loc.hourly?.precipitation?.[h] ?? null,
          precipitationChance: loc.hourly?.precipitation_probability?.[h] ?? null,
          cloudCover: loc.hourly?.cloud_cover?.[h] ?? null,
          windSpeed: loc.hourly?.wind_speed_10m?.[h] ?? null,
        })),
      });
    }

    return NextResponse.json({
      frames,
      units: { temperature: "°F", precipitation: "in", wind: "mph" },
      grid: GRID,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach Open-Meteo: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
