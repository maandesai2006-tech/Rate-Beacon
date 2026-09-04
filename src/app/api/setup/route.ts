import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import {
  deleteProfile,
  ownedProfile,
  profilesForAccount,
  saveProfile,
  type SaveProfileInput,
} from "@/lib/profiles";
import { queueHydration, registerSchedulerTarget } from "@/lib/hydration";
import { geocodeHotel } from "@/lib/geo";
import { planLimits } from "@/lib/plans";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Creating and editing a profile. Every operation belongs to the signed-in
// account: this endpoint used to take whatever profile id it was given and
// write profiles with no owner at all, which is why a new customer's profile
// was invisible to them the moment they finished onboarding.

// GET ?profileId=N → that profile and its hotels. No id → this account's first
// profile, or nulls for a brand-new account.
export async function GET(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa } = auth;

  const requested = Number(req.nextUrl.searchParams.get("profileId")) || null;
  const profile = requested
    ? await ownedProfile(supa, accountId, requested)
    : ((await profilesForAccount(supa, accountId))[0] ?? null);

  if (!profile) return NextResponse.json({ profile: null, hotels: [] });

  const { data: links } = await supa
    .from("profile_hotels")
    .select("hotel_id, is_mine, hotels(name)")
    .eq("profile_id", profile.id)
    .returns<{ hotel_id: string; is_mine: boolean; hotels: { name: string } | null }[]>();

  return NextResponse.json({
    profile,
    hotels: (links ?? []).map((l) => ({
      hotel_id: l.hotel_id,
      name: l.hotels?.name ?? l.hotel_id,
      is_mine: l.is_mine,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa, shared } = auth;

  const body = (await req.json().catch(() => null)) as SaveProfileInput | null;
  if (!body) return NextResponse.json({ error: "Expected a profile" }, { status: 400 });

  const limits = await planLimits(supa, accountId);
  const result = await saveProfile(supa, accountId, body, { shared, limits });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // Everything a new profile needs before it is worth looking at, done here
  // rather than left behind a button nobody knows to press: put the hotels on
  // the map so the forecast and the radius search have somewhere to measure
  // from, and put today's rates in the queue.
  const firstRun = await prepare(shared, body);

  return NextResponse.json({
    ok: true,
    profileId: result.profileId,
    created: result.created,
    firstRun,
  });
}

// DELETE ?profileId=N → remove one of this account's profiles.
export async function DELETE(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa } = auth;

  const profileId = Number(req.nextUrl.searchParams.get("profileId"));
  if (!profileId) return NextResponse.json({ error: "profileId required" }, { status: 400 });

  const result = await deleteProfile(supa, accountId, profileId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}

/**
 * Get a freshly saved profile ready to be useful.
 *
 * Geocoding is bounded and best-effort — Nominatim asks for about a request a
 * second, and a hotel that cannot be placed now is retried by the background
 * pass. Queueing the collection is the part that matters: without it the first
 * prices would not appear until the next nightly run.
 */
async function prepare(
  shared: SupabaseClient,
  body: SaveProfileInput
): Promise<{ placed: number; queued: boolean }> {
  let placed = 0;

  const { data: unplaced } = await shared
    .from("hotels")
    .select("hotel_id, name")
    .in(
      "hotel_id",
      body.hotels.map((h) => h.hotelId)
    )
    .is("latitude", null)
    .limit(8)
    .returns<{ hotel_id: string; name: string }[]>();

  for (const hotel of unplaced ?? []) {
    const geo = await geocodeHotel(hotel.name, body.cityName || null);
    if (!geo) continue;
    await shared
      .from("hotels")
      .update({
        latitude: geo.latitude,
        longitude: geo.longitude,
        address: geo.address,
        geo_precision: geo.precision,
        geo_updated_at: new Date().toISOString(),
      })
      .eq("hotel_id", hotel.hotel_id);
    placed++;
  }

  let queued = false;
  try {
    await registerSchedulerTarget();
    await queueHydration();
    queued = true;
  } catch {
    // The nightly run still picks it up, and the dashboard says where
    // collection has got to either way.
  }

  return { placed, queued };
}
