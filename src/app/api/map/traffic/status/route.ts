import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Is traffic usable on this deployment?
//
// The map needs to know before it offers the layer, so it can either draw
// roads or explain in one line what is missing — rather than a toggle that
// silently does nothing, which is what shipped the first time.

export async function GET() {
  const key = process.env.TOMTOM_API_KEY;
  if (!key) {
    return NextResponse.json(
      {
        available: false,
        reason: "no-key",
        detail:
          "Live traffic needs a free TomTom key. Add TOMTOM_API_KEY on the deployment and this layer turns on.",
      },
      { headers: { "Cache-Control": "public, s-maxage=60" } }
    );
  }

  // One tile over the Gulf coast is enough to tell a working key from a
  // rejected one.
  const url = new URL("https://api.tomtom.com/traffic/map/4/tile/flow/relative0/12/1076/1710.png");
  url.searchParams.set("key", key);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "RateBeacon/1.0 (health check)" },
      next: { revalidate: 3600 },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (res.ok && contentType.startsWith("image/")) {
      return NextResponse.json(
        { available: true, reason: "ok", detail: "Live traffic flow from TomTom." },
        { headers: { "Cache-Control": "public, s-maxage=3600" } }
      );
    }
    return NextResponse.json(
      {
        available: false,
        reason: res.status === 403 || res.status === 401 ? "bad-key" : "upstream",
        detail:
          res.status === 403 || res.status === 401
            ? "TomTom rejected the key. Check it is a Traffic API key and that the app it belongs to is enabled."
            : `TomTom returned ${res.status}.`,
      },
      { headers: { "Cache-Control": "public, s-maxage=300" } }
    );
  } catch (e) {
    return NextResponse.json(
      { available: false, reason: "unreachable", detail: `Could not reach TomTom: ${(e as Error).message}` },
      { headers: { "Cache-Control": "public, s-maxage=60" } }
    );
  }
}
