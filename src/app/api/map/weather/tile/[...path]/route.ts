import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// OpenWeather map tiles, proxied.
//
// Two reasons this goes through the server rather than straight from the
// browser to tile.openweathermap.org:
//
//  1. The API key stays server-side. A tile URL in the page is a key anyone
//     can lift and spend your quota on.
//  2. OpenWeather has two tile products and only one of them can show a
//     forecast. Which one an account has depends on its plan, so the fallback
//     has to happen somewhere that can see the upstream status code.
//
//     Maps 2.0  maps.openweathermap.org/maps/2.0/weather/{op}/{z}/{x}/{y}
//               takes a `date`, so it can render a specific forecast hour.
//     Maps 1.0  tile.openweathermap.org/map/{layer}/{z}/{x}/{y}.png
//               is on every plan including free, but is current conditions
//               only — it has no time dimension at all.
//
// When 2.0 is not available the response carries X-Weather-Source so the UI
// can say the overlay is current conditions rather than animating a timeline
// that is really the same image twelve times.

export type WeatherLayer = "precipitation" | "temperature" | "clouds" | "wind";

const LAYERS: Record<WeatherLayer, { v1: string; v2: string; palette?: string }> = {
  // PR0 is precipitation intensity — the radar look, rather than an
  // accumulation total that only fills in over hours.
  precipitation: {
    v1: "precipitation_new",
    v2: "PR0",
    // Transparent when dry, then the app's cool-to-warm progression, so the
    // overlay reads as part of this map rather than a foreign screenshot.
    palette:
      "0:00000000;0.1:64B4E6A0;0.5:3C8CDCC8;1:2864C8DC;2:6E4FC0E0;4:B4459BE6;10:D6465AE6;50:E23C3CF0",
  },
  temperature: { v1: "temp_new", v2: "TA2" },
  clouds: { v1: "clouds_new", v2: "CL" },
  wind: { v1: "wind_new", v2: "WND" },
};

// Tiles are immutable for a given (layer, z, x, y, hour). Cache hard at the
// edge so panning and replaying cost nothing.
const CACHE = "public, s-maxage=1800, stale-while-revalidate=86400, max-age=900";

function isLayer(v: string): v is WeatherLayer {
  return v in LAYERS;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "OPENWEATHER_API_KEY is not set on the deployment." },
      { status: 503 }
    );
  }

  const { path } = await ctx.params;
  if (path.length !== 4) {
    return NextResponse.json({ error: "Expected /<layer>/<z>/<x>/<y>" }, { status: 400 });
  }
  const [layerName, zRaw, xRaw, yRaw] = path;
  if (!isLayer(layerName)) {
    return NextResponse.json({ error: `Unknown layer "${layerName}"` }, { status: 400 });
  }
  const z = Number(zRaw);
  const x = Number(xRaw);
  const y = Number(yRaw.replace(/\.png$/i, ""));
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19) {
    return NextResponse.json({ error: "Bad tile coordinates" }, { status: 400 });
  }

  const layer = LAYERS[layerName];
  const dateRaw = req.nextUrl.searchParams.get("date");
  const date = dateRaw ? Number(dateRaw) : null;

  // Forecast hour requested → try the product that can actually serve one.
  if (date && Number.isFinite(date)) {
    const url = new URL(
      `https://maps.openweathermap.org/maps/2.0/weather/${layer.v2}/${z}/${x}/${y}`
    );
    url.searchParams.set("appid", key);
    url.searchParams.set("date", String(Math.round(date)));
    url.searchParams.set("opacity", "0.7");
    if (layer.palette) url.searchParams.set("palette", layer.palette);

    const res = await fetchTile(url);
    if (res.ok) {
      return imageResponse(res.body, res.contentType, "maps-2.0-forecast");
    }
    // 401/403 means the plan does not include Maps 2.0; anything else is a
    // transient upstream problem. Either way, current conditions beat nothing.
  }

  const v1 = new URL(
    `https://tile.openweathermap.org/map/${layer.v1}/${z}/${x}/${y}.png`
  );
  v1.searchParams.set("appid", key);
  const res = await fetchTile(v1);
  if (!res.ok) {
    return NextResponse.json(
      { error: `OpenWeather returned ${res.status}` },
      { status: 502 }
    );
  }
  return imageResponse(res.body, res.contentType, date ? "maps-1.0-current-fallback" : "maps-1.0-current");
}

async function fetchTile(url: URL): Promise<{
  ok: boolean;
  status: number;
  body: ArrayBuffer | null;
  contentType: string;
}> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "RateBeacon/1.0 (hotel rate dashboard)" },
      next: { revalidate: 1800 },
    });
    const contentType = res.headers.get("content-type") ?? "image/png";
    // OpenWeather answers errors as JSON with a 200 in some cases, so an
    // image content type is part of "ok".
    if (!res.ok || !contentType.startsWith("image/")) {
      return { ok: false, status: res.status, body: null, contentType };
    }
    return { ok: true, status: res.status, body: await res.arrayBuffer(), contentType };
  } catch {
    return { ok: false, status: 0, body: null, contentType: "" };
  }
}

function imageResponse(body: ArrayBuffer | null, contentType: string, source: string) {
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": CACHE,
      "X-Weather-Source": source,
    },
  });
}
