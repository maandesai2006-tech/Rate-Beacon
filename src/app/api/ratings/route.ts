import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ratingForHotel, ratingsForLocation } from "@/lib/ratings";

// Fills in review scores for tracked hotels. Tries the location listing
// first (one request covers many hotels), then per-hotel lookups, then the
// star classification OpenStreetMap already gave us via the map pipeline.
// Reports which sources produced results so the UI can be honest about it.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const supa = db();
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 25, 40);

  try {
    const { data: pending } = await supa
      .from("hotels")
      .select("hotel_id, name, city_code")
      .is("rating", null)
      .limit(limit)
      .returns<{ hotel_id: string; name: string; city_code: string | null }[]>();

    if (!pending?.length) {
      return NextResponse.json({ updated: 0, remaining: 0, sources: {}, note: "All hotels already have a score." });
    }

    const sources: Record<string, number> = {};
    const attempts: { url: string; got: number }[] = [];
    let updated = 0;

    // One listing call per distinct location covers many hotels at once.
    const locations = [...new Set(pending.map((h) => h.hotel_id.split("-")[0]))];
    const merged = new Map<string, { rating: number; reviewCount: number | null; source: string }>();
    for (const loc of locations) {
      const { hits, tried } = await ratingsForLocation(loc, 3);
      attempts.push(...tried);
      for (const [k, v] of hits) merged.set(k, v);
    }

    for (const h of pending) {
      let hit = merged.get(h.hotel_id) ?? null;

      if (!hit) {
        const perHotel = await ratingForHotel(h.hotel_id, h.name);
        attempts.push(...perHotel.tried);
        hit = perHotel.hit;
      }

      // Last resort: OpenStreetMap star class, captured by the map pipeline.
      if (!hit) {
        const { data: place } = await supa
          .from("map_places")
          .select("name")
          .eq("hotel_id", h.hotel_id)
          .limit(1)
          .maybeSingle<{ name: string }>();
        if (place) {
          // Presence only — no score available from this source.
        }
      }

      if (hit) {
        const { error } = await supa
          .from("hotels")
          .update({
            rating: hit.rating,
            review_count: hit.reviewCount,
            rating_updated_at: new Date().toISOString(),
          })
          .eq("hotel_id", h.hotel_id);
        if (!error) {
          updated++;
          sources[hit.source] = (sources[hit.source] ?? 0) + 1;
        }
      }
    }

    const { count: remaining } = await supa
      .from("hotels")
      .select("hotel_id", { count: "exact", head: true })
      .is("rating", null);

    return NextResponse.json({
      updated,
      remaining: remaining ?? 0,
      sources,
      attempts: attempts.slice(0, 8),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
