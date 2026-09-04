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
  const { accountId, supa, shared } = auth;

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

  const { anchor, error } = await anchorForProfile(supa, profile.id, shared);
  if (!anchor) return NextResponse.json({ error }, { status: 400 });

  const dir = await refreshDirectory(shared, anchor.locationKey);
  await placeDirectory(shared, anchor.locationKey, anchor.cityName, 14);

  const all = await searchNearby(supa, profile.id, anchor, {
    radiusMiles,
    limit: count + 10,
  });
  // Your own hotels are not competitors, and neither is anything outside the
  // baseline's market: a suggestion must share its TripAdvisor location.
  const untracked = all.filter(
    (c) => !c.alreadyTracked && (!c.priceable || c.hotelKey.split("-")[0] === anchor.locationKey)
  );

  // "Same range" is measured, not guessed. Each candidate's typical published
  // rate over the next fortnight is compared with the baseline's; a hotel
  // within about a third either way is the kind a guest would weigh against
  // yours, and it goes to the top. Nothing is dropped for being out of range —
  // an operator may well want the resort up the road in view — it just ranks
  // after the near matches.
  const baselineId = q.get("baselineHotelId") ?? anchor.baselineHotelId ?? null;
  const priceableKeys = untracked.filter((c) => c.priceable).map((c) => c.hotelKey);
  const typical = await typicalRates(shared, [...priceableKeys, ...(baselineId ? [baselineId] : [])]);
  const mine = baselineId ? (typical.get(baselineId) ?? null) : null;

  const ranked = untracked.map((c) => {
    const rate = typical.get(c.hotelKey) ?? null;
    const ratio = rate != null && mine != null && mine > 0 ? rate / mine : null;
    return {
      ...c,
      typicalRate: rate,
      bandMatch: ratio != null ? ratio >= 0.65 && ratio <= 1.35 : null,
    };
  });

  // Two lists, because they ask different things of the operator: one is a
  // set to accept, the other is a set of real neighbours that need a link
  // before anyone can follow them.
  const suggestions = ranked
    .filter((c) => c.priceable)
    .sort((a, b) => {
      const am = a.bandMatch === true ? 0 : a.bandMatch === null ? 1 : 2;
      const bm = b.bandMatch === true ? 0 : b.bandMatch === null ? 1 : 2;
      if (am !== bm) return am - bm;
      return (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99);
    })
    .slice(0, count);
  const needsLink = ranked.filter((c) => !c.priceable).slice(0, 12);
  const fromListing = suggestions.filter((s) => s.source === "listing").length;

  return NextResponse.json({
    radiusMiles,
    directorySize: dir.total,
    listingShape: dir.shape,
    listingError: dir.error,
    fromListing,
    fromKnown: suggestions.length - fromListing,
    baselineTypicalRate: mine,
    suggestions,
    needsLink,
    note:
      suggestions.length === 0 && needsLink.length > 0
        ? `Nothing in this market can be priced yet, but ${needsLink.length} real hotels sit within ${radiusMiles} miles. Attach a TripAdvisor link to the ones you compete with and they start collecting tomorrow.`
        : suggestions.length > 0 && dir.error
          ? `The market listing could not be read (${dir.error}), so these are the hotels already known near you.`
          : suggestions.length === 0
            ? `No hotels found within ${radiusMiles} miles. Try a wider radius.`
            : null,
  });
}

/** Each hotel's median published rate across the next fourteen nights. */
async function typicalRates(
  supa: Parameters<typeof searchNearby>[0],
  hotelKeys: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (hotelKeys.length === 0) return out;
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  const { data } = await supa
    .from("latest_rates")
    .select("hotel_id, price, available, is_anomaly")
    .in("hotel_id", hotelKeys)
    .gte("check_in", today)
    .lte("check_in", end)
    .returns<{ hotel_id: string; price: number | null; available: boolean; is_anomaly: boolean | null }[]>();

  const bag = new Map<string, number[]>();
  for (const r of data ?? []) {
    if (r.price == null || !r.available || r.is_anomaly) continue;
    bag.set(r.hotel_id, [...(bag.get(r.hotel_id) ?? []), Number(r.price)]);
  }
  for (const [key, prices] of bag) {
    if (prices.length < 3) continue;
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out.set(key, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
  }
  return out;
}
