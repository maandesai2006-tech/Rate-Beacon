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
  const { accountId, supa, shared } = auth;

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

  const { anchor, error } = await anchorForProfile(supa, profile.id, shared);
  if (!anchor) return NextResponse.json({ error }, { status: 400 });

  // Fill the directory for this market if it is stale, then place anything
  // that came back without coordinates so the radius filter can see it.
  const dir = await refreshDirectory(shared, anchor.locationKey);
  await placeDirectory(shared, anchor.locationKey, anchor.cityName, query ? 4 : 10);

  // Search runs whether or not the listing answered: hotels already known to
  // the deployment are a second source, so a failed upstream call narrows the
  // results rather than emptying them.
  const results = await searchNearby(supa, profile.id, anchor, { query, radiusMiles });

  return NextResponse.json({
    radiusMiles,
    anchor: { latitude: anchor.latitude, longitude: anchor.longitude },
    directorySize: dir.total,
    listingError: dir.error,
    results,
    note:
      results.length === 0 && dir.error
        ? `Nothing found within ${radiusMiles} miles, and the market listing could not be read: ${dir.error} Paste the hotel's TripAdvisor link to add it directly.`
        : null,
  });
}
