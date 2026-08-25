import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import {
  anchorForProfile,
  refreshDirectory,
  placeDirectory,
  searchNearby,
  DEFAULT_RADIUS_MILES,
} from "@/lib/compset";
import { parseTripAdvisorRef } from "@/lib/xotelo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Typeahead for adding a competitor.
//
// Bounded by a radius from the operator's own hotel, so "Hampton Inn" returns
// the two nearby ones rather than every Hampton Inn on earth. A pasted
// TripAdvisor link is accepted too, which is the escape hatch for anything the
// directory has not caught up with.

export async function GET(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa } = auth;

  const q = req.nextUrl.searchParams;
  const profileId = Number(q.get("profileId")) || null;
  const query = (q.get("q") ?? "").trim();
  const radiusMiles = Math.min(
    Math.max(Number(q.get("radius")) || DEFAULT_RADIUS_MILES, 1),
    100
  );

  const { data: profile } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", profileId ?? -1)
    .maybeSingle<{ id: number }>();
  if (!profile) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });

  // A pasted link short-circuits everything: the key is right there.
  const ref = query ? parseTripAdvisorRef(query) : { hotelKey: null, name: null, locationKey: null };
  if (ref.hotelKey) {
    return NextResponse.json({
      radiusMiles,
      pasted: true,
      results: [
        {
          hotelKey: ref.hotelKey,
          name: ref.name ?? ref.hotelKey,
          distanceMiles: null,
          rating: null,
          reviewCount: null,
          latitude: null,
          longitude: null,
          alreadyTracked: false,
        },
      ],
    });
  }

  const { anchor, error } = await anchorForProfile(supa, profile.id);
  if (!anchor) return NextResponse.json({ error }, { status: 400 });

  // Fill the directory for this market if it is stale, then place anything
  // that came back without coordinates so the radius filter can see it.
  const dir = await refreshDirectory(supa, anchor.locationKey);
  if (dir.error && dir.total === 0) {
    return NextResponse.json(
      {
        radiusMiles,
        results: [],
        error: `No hotel directory for this market yet. ${dir.error}`,
        hint: "Paste a TripAdvisor link for the hotel to add it directly.",
      },
      { status: 200 }
    );
  }
  await placeDirectory(supa, anchor.locationKey, anchor.cityName, query ? 4 : 10);

  const results = await searchNearby(supa, profile.id, anchor, { query, radiusMiles });

  return NextResponse.json({
    radiusMiles,
    anchor: { latitude: anchor.latitude, longitude: anchor.longitude },
    directorySize: dir.total,
    results,
  });
}
