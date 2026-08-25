import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { anchorForProfile } from "@/lib/compset";
import { milesBetween } from "@/lib/xotelo-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Add chosen hotels to a profile's competitive set.
//
// Writes three things, because the grid reads all three: the hotel itself, the
// profile's membership, and the baseline→competitor edge that makes it appear
// in a specific hotel's grid rather than in every grid on the profile.

interface Body {
  profileId?: number;
  baselineHotelId?: string;
  hotels?: { hotelKey: string; name?: string }[];
}

export async function POST(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa } = auth;

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

  // Names and coordinates from the directory where we have them, so a newly
  // added competitor appears on the map immediately.
  const { data: dir } = await supa
    .from("hotel_directory")
    .select("hotel_id, name, latitude, longitude, rating, review_count")
    .in("hotel_id", wanted.map((h) => h.hotelKey))
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

  await supa.from("hotels").upsert(
    wanted.map((h) => {
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

  await supa.from("profile_hotels").upsert(
    wanted.map((h) => ({
      profile_id: profile.id,
      hotel_id: h.hotelKey,
      is_mine: false,
      role: "comp",
    })),
    { onConflict: "profile_id,hotel_id", ignoreDuplicates: true }
  );

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
    const { anchor } = await anchorForProfile(supa, profile.id);
    const rows = wanted.map((h) => {
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
    if (!error) edges = rows.length;
  }

  return NextResponse.json({ added: wanted.length, baseline, edges });
}
