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
    const [{ data: profiles }, { data: pending }] = await Promise.all([
      supa.from("profiles").select("*").returns<Profile[]>(),
      supa
        .from("hotels")
        .select("hotel_id, name, city_code")
        .is("latitude", null)
        .is("geo_updated_at", null)
        .limit(limit)
        .returns<{ hotel_id: string; name: string; city_code: string | null }[]>(),
    ]);

    const marketByCity = new Map(
      (profiles ?? [])
        .filter((p) => p.city_code)
        .map((p) => [p.city_code as string, p.city_name ?? ""])
    );

    let located = 0;
    const errors: string[] = [];
    for (const h of pending ?? []) {
      const near = marketByCity.get(h.city_code ?? "") || null;
      const geo = await geocodeHotel(h.name, near);
      const patch = geo
        ? {
            latitude: geo.latitude,
            longitude: geo.longitude,
            address: geo.address,
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
      .is("geo_updated_at", null);

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
