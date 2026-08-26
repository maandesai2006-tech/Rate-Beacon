import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Is the temperature overlay usable on this deployment?
//
// Mirrors the traffic check. A layer that quietly fails looks like a broken
// map — the console fills with tile errors and the user is told nothing — so
// the map asks first and either draws the overlay or says the one thing that
// would fix it.
export async function GET() {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) {
    return NextResponse.json(
      {
        available: false,
        reason: "no-key",
        detail:
          "The temperature overlay needs a free OpenWeather key. Add OPENWEATHER_API_KEY on the deployment and this layer turns on. Radar does not need one.",
      },
      { headers: { "Cache-Control": "public, s-maxage=60" } }
    );
  }

  // One tile over the Gulf coast tells a working key from a rejected one.
  const url = new URL("https://tile.openweathermap.org/map/temp_new/4/4/6.png");
  url.searchParams.set("appid", key);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "RateBeacon/1.0 (health check)" },
      next: { revalidate: 3600 },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (res.ok && contentType.startsWith("image/")) {
      return NextResponse.json(
        { available: true, reason: "ok", detail: "Temperature field from OpenWeather." },
        { headers: { "Cache-Control": "public, s-maxage=3600" } }
      );
    }
    const rejected = res.status === 401 || res.status === 403;
    return NextResponse.json(
      {
        available: false,
        reason: rejected ? "bad-key" : "upstream",
        detail: rejected
          ? "OpenWeather rejected the key. A newly created key takes up to two hours to activate — if it is older than that, check it was copied whole."
          : `OpenWeather returned ${res.status}.`,
      },
      { headers: { "Cache-Control": "public, s-maxage=300" } }
    );
  } catch (e) {
    return NextResponse.json(
      { available: false, reason: "unreachable", detail: `Could not reach OpenWeather: ${(e as Error).message}` },
      { headers: { "Cache-Control": "public, s-maxage=60" } }
    );
  }
}
