import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { probeListShapes } from "@/lib/xotelo-list";
import { hotelsNear, lastNearbyErrors } from "@/lib/nearby";
import { verifyHotelKey } from "@/lib/xotelo";
import { anchorForProfile } from "@/lib/compset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Where competitors can come from on this deployment, tested rather than
// assumed.
//
// Three sources feed discovery and each fails differently: the market listing
// has an undocumented request shape, OpenStreetMap rate-limits and refuses some
// datacenter addresses, and the rate feed decides whether a hotel can be
// followed at all. None of them can be probed from a development machine with
// no route to the hosts, so this runs all three against a real market and
// reports every response verbatim — a failure names its cause instead of
// "check your params". A winning listing shape is stored and used from then on.

export async function POST(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa, shared } = auth;

  const locationKey = (req.nextUrl.searchParams.get("locationKey") ?? "g34550").trim();
  if (!/^g\d+$/.test(locationKey)) {
    return NextResponse.json({ error: "locationKey should look like g34550" }, { status: 400 });
  }

  const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;

  const { winner, outcomes } = await probeListShapes(shared, locationKey);

  // The map source, from the profile's own anchor when there is one so the
  // probe reflects the market the customer actually sits in.
  let anchorPoint = { latitude: 30.4213, longitude: -87.2169 };
  if (profileId) {
    const { data: profile } = await supa
      .from("profiles")
      .select("id")
      .eq("account_id", accountId)
      .eq("id", profileId)
      .maybeSingle<{ id: number }>();
    if (profile) {
      const { anchor } = await anchorForProfile(supa, profile.id, {
        shared,
        baselineHotelId: req.nextUrl.searchParams.get("baselineHotelId"),
      });
      if (anchor) anchorPoint = { latitude: anchor.latitude, longitude: anchor.longitude };
    }
  }

  const nearby = await hotelsNear(anchorPoint.latitude, anchorPoint.longitude, 5, 20);

  // And whether the rate feed will follow a hotel at all, using one key it has
  // certainly seen.
  const feed = await verifyHotelKey("g34550-d10637341");

  const sources = [
    {
      name: "Market listing",
      ok: Boolean(winner),
      detail: winner
        ? `Works using the "${winner}" request shape — stored, and used from now on.`
        : `Every request shape was refused. ${outcomes.slice(0, 3).map((o) => `${o.shape}: ${o.message}`).join(" | ")}`,
    },
    {
      name: "Map (OpenStreetMap)",
      ok: nearby.length > 0,
      detail:
        nearby.length > 0
          ? `${nearby.length} hotels within 5 miles of the anchor, e.g. ${nearby.slice(0, 3).map((h) => h.name).join(", ")}.`
          : lastNearbyErrors.length > 0
            ? `Every mirror refused: ${lastNearbyErrors.join(" | ")}`
            : "No hotels found near the anchor, and no mirror reported an error.",
    },
    {
      name: "Rate feed",
      ok: feed.verdict === "priceable",
      detail: `${feed.verdict} — ${feed.detail}`,
    },
  ];

  const usable = sources.filter((s) => s.ok).map((s) => s.name);

  return NextResponse.json({
    locationKey,
    winner,
    outcomes,
    sources,
    summary:
      usable.length === 0
        ? "No source answered, so discovery cannot suggest anything. The per-source detail below is the evidence."
        : `Discovery can work from: ${usable.join(", ")}.`,
  });
}
