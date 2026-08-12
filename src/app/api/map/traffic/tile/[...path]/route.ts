import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// TomTom traffic flow tiles, proxied.
//
// There is no keyless live-traffic source worth having — OpenStreetMap has no
// speed observations, and every provider that does gates them behind a key.
// TomTom's free tier covers a dashboard this size comfortably, and proxying
// keeps the key server-side so a tile URL in the page cannot be lifted and
// spent.
//
// Styles, from TomTom's flow product:
//   relative0        speed relative to free-flow, tuned for a light basemap
//   relative0-dark   the same, tuned for a dark one
// Both colour roads green through red, which is the convention every driver
// already reads without a legend.

const STYLES = {
  light: "relative0",
  dark: "relative0-dark",
} as const;

// Flow refreshes about every minute upstream. A short edge cache keeps panning
// cheap without showing stale roads.
const CACHE = "public, s-maxage=60, stale-while-revalidate=240";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const key = process.env.TOMTOM_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "TOMTOM_API_KEY is not set on the deployment." },
      { status: 503 }
    );
  }

  const { path } = await ctx.params;
  if (path.length !== 3) {
    return NextResponse.json({ error: "Expected /<z>/<x>/<y>" }, { status: 400 });
  }
  const z = Number(path[0]);
  const x = Number(path[1]);
  const y = Number(path[2].replace(/\.png$/i, ""));
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22) {
    return NextResponse.json({ error: "Bad tile coordinates" }, { status: 400 });
  }

  const theme = req.nextUrl.searchParams.get("theme") === "dark" ? "dark" : "light";
  const url = new URL(
    `https://api.tomtom.com/traffic/map/4/tile/flow/${STYLES[theme]}/${z}/${x}/${y}.png`
  );
  url.searchParams.set("key", key);
  // Thicker than default so a single carriageway still reads at city zoom.
  url.searchParams.set("thickness", "6");

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "RateBeacon/1.0 (hotel rate dashboard)" },
      next: { revalidate: 60 },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.startsWith("image/")) {
      // TomTom answers a bad key with JSON and a 403; surfacing the status is
      // what lets the map say "check the key" instead of drawing nothing.
      return NextResponse.json(
        { error: `TomTom returned ${res.status}` },
        { status: res.status === 403 || res.status === 401 ? 502 : 502 }
      );
    }
    return new NextResponse(await res.arrayBuffer(), {
      status: 200,
      headers: { "Content-Type": contentType, "Cache-Control": CACHE },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach TomTom: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
