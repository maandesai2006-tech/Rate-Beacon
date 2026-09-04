import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { anchorForProfile } from "@/lib/compset";
import { milesBetween } from "@/lib/hotel-match";
import { verifyHotelKey } from "@/lib/xotelo";
import { geocodeHotel } from "@/lib/geo";
import { planLimits } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Add chosen hotels to a profile's competitive set.
//
// Writes three things, because the grid reads all three: the hotel itself, the
// profile's membership, and the baseline→competitor edge that makes it appear
// in a specific hotel's grid rather than in every grid on the profile.
//
// Every hotel is checked against the rate feed before any of that happens. A
// compset is a claim that these are the properties you are priced against, and
// a member that silently never returns a price is worse than a shorter list —
// it drags the median around by being absent. So a key that the feed does not
// recognise is refused and said so, rather than accepted and quietly empty.

interface Body {
  profileId?: number;
  baselineHotelId?: string;
  hotels?: { hotelKey: string; name?: string }[];
}

export async function POST(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa, shared } = auth;

  const body = (await req.json().catch(() => ({}))) as Body;
  const profileId = Number(body.profileId) || null;
  const wanted = (body.hotels ?? []).filter((h) => /^g\d+-d\d+$/.test(h.hotelKey ?? ""));
  if (wanted.length === 0) {
    return NextResponse.json({ error: "No valid hotels to add" }, { status: 400 });
  }

  const { data: profile } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", profileId ?? -1)
    .maybeSingle<{ id: number }>();
  if (!profile) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });

  // A compset has a ceiling per plan. The median needs a handful of the right
  // hotels, not every hotel in town, and each one is a nightly lookup.
  const limits = await planLimits(supa, accountId);
  const { count: current } = await supa
    .from("profile_hotels")
    .select("hotel_id", { count: "exact", head: true })
    .eq("profile_id", profile.id)
    .eq("is_mine", false);
  const room = limits.maxCompetitors - (current ?? 0);
  if (room <= 0) {
    return NextResponse.json(
      { error: `This plan allows ${limits.maxCompetitors} competitors per property. Remove one to add another, or contact us.` },
      { status: 403 }
    );
  }
  if (wanted.length > room) wanted.splice(room);

  // Nothing joins a compset it cannot be priced in. A hotel that is real but
  // sold out for the probe night still counts — those are the ones worth
  // watching — so only an unrecognised id is turned away.
  const checked = await Promise.all(
    wanted.map(async (h) => ({ ...h, ...(await verifyHotelKey(h.hotelKey)) }))
  );
  const accepted = checked.filter((h) => h.verdict === "priceable");
  const rejected = checked.filter((h) => h.verdict !== "priceable");

  if (accepted.length === 0) {
    return NextResponse.json(
      {
        error:
          rejected[0]?.verdict === "unreachable"
            ? `The rate feed could not be reached, so nothing was added: ${rejected[0].detail}`
            : "None of those hotels are known to the rate feed, so none were added.",
        rejected: rejected.map((r) => ({ hotelKey: r.hotelKey, reason: r.detail })),
      },
      { status: 422 }
    );
  }

  // Names and coordinates from the directory where we have them, so a newly
  // added competitor carries its details immediately.
  const { data: dir } = await supa
    .from("hotel_directory")
    .select("hotel_id, name, latitude, longitude, rating, review_count")
    .in("hotel_id", accepted.map((h) => h.hotelKey))
    .returns<
      {
        hotel_id: string;
        name: string;
        latitude: number | null;
        longitude: number | null;
        rating: number | null;
        review_count: number | null;
      }[]
    >();
  const known = new Map((dir ?? []).map((d) => [d.hotel_id, d]));

  const { error: registryError } = await shared.from("hotels").upsert(
    accepted.map((h) => {
      const d = known.get(h.hotelKey);
      return {
        hotel_id: h.hotelKey,
        name: d?.name ?? h.name ?? h.hotelKey,
        city_code: h.hotelKey.split("-")[0],
        latitude: d?.latitude ?? null,
        longitude: d?.longitude ?? null,
        rating: d?.rating ?? null,
        review_count: d?.review_count ?? null,
      };
    }),
    { onConflict: "hotel_id", ignoreDuplicates: false }
  );

  if (registryError) {
    return NextResponse.json(
      { error: `The hotels could not be saved: ${registryError.message}` },
      { status: 500 }
    );
  }

  // A write that fails here used to be reported as "added" anyway, because the
  // count came from the verification step rather than from the database. The
  // QA sweep caught it: the response said success and the hotel was absent.
  const { error: membershipError } = await supa.from("profile_hotels").upsert(
    accepted.map((h) => ({
      profile_id: profile.id,
      hotel_id: h.hotelKey,
      is_mine: false,
      role: "comp",
    })),
    { onConflict: "profile_id,hotel_id", ignoreDuplicates: true }
  );
  if (membershipError) {
    return NextResponse.json(
      { error: `The hotels could not be added to this profile: ${membershipError.message}` },
      { status: 500 }
    );
  }

  // Every hotel gets a position the moment it is added. The forecast reads
  // it, the radius search measures from it, and a competitor without one sits
  // outside both — so this is done here, bounded and best-effort, not left to
  // a background pass that may or may not run before anyone looks.
  const { anchor: place } = await anchorForProfile(supa, profile.id, shared);
  for (const h of accepted) {
    const d = known.get(h.hotelKey);
    if (d?.latitude != null && d?.longitude != null) continue;
    const geo = await geocodeHotel(d?.name ?? h.name ?? h.hotelKey, place?.cityName ?? null);
    if (!geo) continue;
    known.set(h.hotelKey, {
      hotel_id: h.hotelKey,
      name: d?.name ?? h.name ?? h.hotelKey,
      latitude: geo.latitude,
      longitude: geo.longitude,
      rating: d?.rating ?? null,
      review_count: d?.review_count ?? null,
    });
    await shared
      .from("hotels")
      .update({
        latitude: geo.latitude,
        longitude: geo.longitude,
        address: geo.address,
        geo_precision: geo.precision,
        geo_updated_at: new Date().toISOString(),
      })
      .eq("hotel_id", h.hotelKey);
  }

  // Tie them to a baseline so they land in that hotel's grid and not others'.
  let baseline = body.baselineHotelId ?? null;
  if (!baseline) {
    const { data: mine } = await supa
      .from("profile_hotels")
      .select("hotel_id")
      .eq("profile_id", profile.id)
      .eq("is_mine", true)
      .limit(1)
      .returns<{ hotel_id: string }[]>();
    baseline = mine?.[0]?.hotel_id ?? null;
  }

  let edges = 0;
  if (baseline) {
    const { anchor } = await anchorForProfile(supa, profile.id, shared);
    const rows = accepted.map((h) => {
      const d = known.get(h.hotelKey);
      const distance =
        anchor && d?.latitude != null && d?.longitude != null
          ? milesBetween(anchor, { latitude: d.latitude, longitude: d.longitude }) * 1.609344
          : null;
      return {
        profile_id: profile.id,
        baseline_hotel_id: baseline as string,
        comp_hotel_id: h.hotelKey,
        distance_km: distance,
        discovered_at: new Date().toISOString(),
      };
    });
    const { error } = await supa
      .from("baseline_comps")
      .upsert(rows, { onConflict: "profile_id,baseline_hotel_id,comp_hotel_id", ignoreDuplicates: false });
    if (error) {
      return NextResponse.json(
        { error: `The hotels were saved but could not be tied to ${baseline}'s grid: ${error.message}` },
        { status: 500 }
      );
    }
    edges = rows.length;
  }

  return NextResponse.json({
    added: accepted.length,
    baseline,
    edges,
    rejected: rejected.map((r) => ({ hotelKey: r.hotelKey, reason: r.detail })),
    note:
      rejected.length > 0
        ? `Added ${accepted.length}. ${rejected.length} could not be priced and were left out.`
        : null,
  });
}
