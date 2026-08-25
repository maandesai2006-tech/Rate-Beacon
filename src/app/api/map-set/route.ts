import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { hotelsNear, namesMatch } from "@/lib/overpass";
import { haversineKm } from "@/lib/discovery";

// Builds the map's hotel set for each baseline: the nearest lodging places
// OpenStreetMap knows about, tied to our tracked hotels by name where they
// match so prices can be attached. Independent of the rate feed, so the map
// works even when the upstream price API is unhappy.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // This was reachable without credentials and looped over every profile's
  // baselines, so any visitor could trigger work across all tenants. It is now
  // a signed-in action bounded to the caller's own profiles.
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa } = auth;
  const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;

  const { data: ownProfiles } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .returns<{ id: number }[]>();
  const ownIds = new Set((ownProfiles ?? []).map((p) => p.id));
  if (profileId && !ownIds.has(profileId)) {
    return NextResponse.json({ error: "Unknown profile" }, { status: 400 });
  }
  const want = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 30, 60);

  try {
    const { data: baselines } = await supa
      .from("profile_hotels")
      .select("profile_id, hotel_id, hotels(name, latitude, longitude)")
      .eq("role", "baseline")
      .returns<
        {
          profile_id: number;
          hotel_id: string;
          hotels: { name: string; latitude: number | null; longitude: number | null } | null;
        }[]
      >();

    const targets = (baselines ?? []).filter(
      (b) =>
        ownIds.has(b.profile_id) &&
        (!profileId || b.profile_id === profileId) &&
        b.hotels?.latitude != null
    );
    if (targets.length === 0) {
      return NextResponse.json(
        { error: "No baseline hotel has coordinates yet — run geocoding first." },
        { status: 400 }
      );
    }

    const { data: tracked } = await supa
      .from("hotels")
      .select("hotel_id, name")
      .returns<{ hotel_id: string; name: string }[]>();

    const results = [];
    for (const b of targets) {
      const lat = b.hotels!.latitude as number;
      const lon = b.hotels!.longitude as number;
      const places = await hotelsNear(lat, lon, 6000, 80);
      if (places.length === 0) {
        results.push({ baseline: b.hotel_id, found: 0, note: "Overpass returned nothing" });
        continue;
      }

      const ranked = places
        .map((p) => ({ ...p, distanceKm: haversineKm(lat, lon, p.latitude, p.longitude) }))
        .sort((a, b2) => a.distanceKm - b2.distanceKm)
        .slice(0, want);

      const rows = ranked.map((p) => ({
        profile_id: b.profile_id,
        baseline_hotel_id: b.hotel_id,
        osm_id: p.osmId,
        name: p.name,
        latitude: p.latitude,
        longitude: p.longitude,
        distance_km: p.distanceKm,
        // Tie to a tracked hotel when the names line up, so the map can show
        // a live rate for this point.
        hotel_id:
          (tracked ?? []).find((t) => namesMatch(t.name, p.name))?.hotel_id ?? null,
        refreshed_at: new Date().toISOString(),
      }));

      await supa
        .from("map_places")
        .delete()
        .eq("profile_id", b.profile_id)
        .eq("baseline_hotel_id", b.hotel_id);
      const { error } = await supa.from("map_places").insert(rows);
      results.push({
        baseline: b.hotel_id,
        found: rows.length,
        matchedToRates: rows.filter((r) => r.hotel_id).length,
        error: error?.message,
      });
    }

    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
