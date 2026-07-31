import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET ?profileId=N → that profile + its hotels (no id → first profile).
export async function GET(req: NextRequest) {
  const supa = db();
  const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;

  let q = supa.from("profiles").select("*").order("id").limit(1);
  if (profileId) q = supa.from("profiles").select("*").eq("id", profileId).limit(1);
  const { data: profile } = await q.maybeSingle<Profile>();
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

interface SetupBody {
  profileId?: number | null; // null/absent → create a new profile
  name?: string;
  hotelName: string;
  cityCode: string;
  cityName: string;
  currency: string;
  horizonDays: number;
  adults: number;
  notes?: string;
  hotels: { hotelId: string; name: string; isMine: boolean }[];
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as SetupBody;
  if (!body.cityCode || !Array.isArray(body.hotels) || body.hotels.length === 0) {
    return NextResponse.json(
      { error: "Pick a location and at least one hotel to track" },
      { status: 400 }
    );
  }
  const supa = db();

  const profileFields = {
    name: body.name || body.hotelName || body.cityName || "New profile",
    hotel_name: body.hotelName || null,
    city_code: body.cityCode,
    city_name: body.cityName || null,
    currency: body.currency || "USD",
    horizon_days: Math.min(120, Math.max(7, body.horizonDays || 45)),
    adults: Math.min(9, Math.max(1, body.adults || 2)),
    notes: body.notes ?? null,
  };

  let profileId = body.profileId ?? null;
  if (profileId) {
    const { error } = await supa.from("profiles").update(profileFields).eq("id", profileId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { data, error } = await supa
      .from("profiles")
      .insert(profileFields)
      .select("id")
      .single<{ id: number }>();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    profileId = data.id;
  }

  // Global hotel registry (shared across profiles).
  const { error: hErr } = await supa.from("hotels").upsert(
    body.hotels.map((h) => ({ hotel_id: h.hotelId, name: h.name })),
    { onConflict: "hotel_id" }
  );
  if (hErr) return NextResponse.json({ error: hErr.message }, { status: 500 });

  // Replace this profile's tracked set.
  const { error: dErr } = await supa
    .from("profile_hotels")
    .delete()
    .eq("profile_id", profileId);
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 });
  const { error: lErr } = await supa.from("profile_hotels").insert(
    body.hotels.map((h) => ({
      profile_id: profileId,
      hotel_id: h.hotelId,
      is_mine: h.isMine,
    }))
  );
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, profileId });
}

// DELETE ?profileId=N → remove a profile (its links cascade).
export async function DELETE(req: NextRequest) {
  const profileId = Number(req.nextUrl.searchParams.get("profileId"));
  if (!profileId) return NextResponse.json({ error: "profileId required" }, { status: 400 });
  const { error } = await db().from("profiles").delete().eq("id", profileId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
