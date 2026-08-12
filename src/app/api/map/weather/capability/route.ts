import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Does this OpenWeather account's plan include the forecast tile product?
//
// The client needs to know before it draws a timeline. If only Maps 1.0 is
// available the overlay is current conditions, and scrubbing through twelve
// hours would show the same image twelve times — so the UI says so and hides
// the scrubber rather than faking motion.
//
// One tile over the Gulf coast at low zoom is enough to tell, and the answer
// only changes when a plan changes, so it is cached for a day.

export async function GET() {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) {
    return NextResponse.json(
      { configured: false, forecast: false, detail: "OPENWEATHER_API_KEY is not set." },
      { headers: { "Cache-Control": "public, s-maxage=60" } }
    );
  }

  const url = new URL("https://maps.openweathermap.org/maps/2.0/weather/PR0/5/8/12");
  url.searchParams.set("appid", key);
  url.searchParams.set("date", String(Math.floor(Date.now() / 1000)));

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "RateBeacon/1.0 (hotel rate dashboard)" },
      next: { revalidate: 86400 },
    });
    const contentType = res.headers.get("content-type") ?? "";
    const forecast = res.ok && contentType.startsWith("image/");
    return NextResponse.json(
      {
        configured: true,
        forecast,
        detail: forecast
          ? "Forecast tiles available."
          : `This OpenWeather plan serves current-conditions tiles only (Maps 2.0 replied ${res.status}).`,
      },
      { headers: { "Cache-Control": "public, s-maxage=86400" } }
    );
  } catch (e) {
    return NextResponse.json(
      {
        configured: true,
        forecast: false,
        detail: `Could not reach OpenWeather: ${(e as Error).message}`,
      },
      { headers: { "Cache-Control": "public, s-maxage=60" } }
    );
  }
}
