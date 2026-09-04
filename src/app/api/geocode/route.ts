import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geocodeHotel } from "@/lib/geo";
import type { Profile } from "@/lib/types";

// Places tracked hotels on the map. Nominatim asks for ~1 request/second, so
// a call handles a bounded batch and reports how many are still pending; the
// dashboard loops until none remain.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 20, 40);
  const supa = db();
  try {
    // A failed lookup used to stamp geo_updated_at and then be excluded by
    // `geo_updated_at is null` forever, so one transient Nominatim miss made a
    // hotel permanently unplaceable. Failures are retried after a cooling-off
    // period instead; successes have a latitude and never come back here.
    const retryAfter = new Date(Date.now() - 3 * 86400_000).toISOString();

    const [{ data: profiles }, { data: pending }, { data: memberships }] = await Promise.all([
      supa.from("profiles").select("*").returns<Profile[]>(),
      supa
        .from("hotels")
        .select("hotel_id, name, city_code")
        .is("latitude", null)
        .or(`geo_updated_at.is.null,geo_updated_at.lt.${retryAfter}`)
        .limit(limit)
        .returns<{ hotel_id: string; name: string; city_code: string | null }[]>(),
      supa
        .from("profile_hotels")
        .select("hotel_id, profile_id")
        .returns<{ hotel_id: string; profile_id: number }[]>(),
    ]);

    const marketByCity = new Map(
      (profiles ?? [])
        .filter((p) => p.city_code)
        .map((p) => [p.city_code as string, p.city_name ?? ""])
    );

    // Most hotels carry no city_code, so the stronger hint is the market of
    // whichever profile tracks them — "Pensacola, FL" turns an ambiguous
    // brand name into a single result.
    const cityByProfile = new Map((profiles ?? []).map((p) => [p.id, p.city_name ?? ""]));
    const hintByHotel = new Map<string, string>();
    for (const m of memberships ?? []) {
      const city = cityByProfile.get(m.profile_id);
      if (city && !hintByHotel.has(m.hotel_id)) hintByHotel.set(m.hotel_id, city);
    }

    let located = 0;
    const errors: string[] = [];
    for (const h of pending ?? []) {
      const near = marketByCity.get(h.city_code ?? "") || hintByHotel.get(h.hotel_id) || null;
      // "Candlewood Suites Pensacola University Area by IHG" is a brand string,
      // not a place. Nominatim does better once the chain suffix is gone, so a
      // failed lookup is retried on the trimmed name before giving up.
      let geo = await geocodeHotel(h.name, near);
      if (!geo) {
        const trimmed = h.name
          .replace(/\s+by\s+(ihg|marriott|hilton|wyndham|choice|hyatt)\b.*$/i, "")
          .replace(/\s*[-–—]\s*[^-–—]*$/, "")
          .trim();
        if (trimmed && trimmed !== h.name) geo = await geocodeHotel(trimmed, near);
      }
      const patch = geo
        ? {
            latitude: geo.latitude,
            longitude: geo.longitude,
            address: geo.address,
        geo_precision: geo.precision,
            geo_updated_at: new Date().toISOString(),
          }
        : { geo_updated_at: new Date().toISOString() };
      const { error } = await supa.from("hotels").update(patch).eq("hotel_id", h.hotel_id);
      if (error) errors.push(`${h.name}: ${error.message}`);
      else if (geo) located++;
    }

    const { count: remaining } = await supa
      .from("hotels")
      .select("hotel_id", { count: "exact", head: true })
      .is("latitude", null)
      .or(`geo_updated_at.is.null,geo_updated_at.lt.${retryAfter}`);

    return NextResponse.json({
      located,
      attempted: pending?.length ?? 0,
      remaining: remaining ?? 0,
      errors: errors.slice(0, 5),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
