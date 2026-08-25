import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import {
  anchorForProfile,
  refreshDirectory,
  placeDirectory,
  searchNearby,
  DEFAULT_RADIUS_MILES,
} from "@/lib/compset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The compset we would pick, offered rather than imposed.
//
// Nearest first inside the radius, because proximity is the strongest single
// predictor of whether a guest actually chose between two properties. The
// operator confirms the list — a suggested set applied silently would be a
// worse product than one they agreed to.

export async function GET(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa } = auth;

  const q = req.nextUrl.searchParams;
  const profileId = Number(q.get("profileId")) || null;
  const count = Math.min(Math.max(Number(q.get("count")) || 15, 1), 30);
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

  const { anchor, error } = await anchorForProfile(supa, profile.id);
  if (!anchor) return NextResponse.json({ error }, { status: 400 });

  const dir = await refreshDirectory(supa, anchor.locationKey);
  await placeDirectory(supa, anchor.locationKey, anchor.cityName, 14);

  const all = await searchNearby(supa, profile.id, anchor, {
    radiusMiles,
    limit: count + 10,
  });
  // Your own hotels are not competitors.
  const suggestions = all.filter((c) => !c.alreadyTracked).slice(0, count);
  const fromListing = suggestions.filter((s) => s.source === "listing").length;

  return NextResponse.json({
    radiusMiles,
    directorySize: dir.total,
    listingShape: dir.shape,
    listingError: dir.error,
    fromListing,
    fromKnown: suggestions.length - fromListing,
    suggestions,
    note:
      suggestions.length > 0 && dir.error
        ? `The market listing could not be read (${dir.error}), so these are the hotels already known near you. Paste a TripAdvisor link to add anything missing.`
        : suggestions.length === 0 && dir.error
          ? `Nothing to suggest yet: the market listing could not be read, and no hotels are known within ${radiusMiles} miles. ${dir.error} Paste a TripAdvisor link to add competitors directly.`
          : suggestions.length === 0
            ? `No hotels found within ${radiusMiles} miles. Try a wider radius.`
            : null,
  });
}
