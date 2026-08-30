import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { discoverForBaseline } from "@/lib/discovery";
import type { Profile } from "@/lib/types";

export const maxDuration = 300;

// POST /api/discover?profileId=1[&baselineId=g..-d..]
// Rebuilds competitor sets from data: location listing → geocode → nearest by
// distance. Runs for one baseline, or every baseline in the profile.
export async function POST(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa } = auth;
  const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;
  const baselineId = req.nextUrl.searchParams.get("baselineId");
  const compCount = Number(req.nextUrl.searchParams.get("comps")) || 15;

  try {
    // Bounded by the account either way: without it, passing any profile id
    // rebuilt someone else's competitive set.
    let q = supa
      .from("profiles")
      .select("*")
      .eq("account_id", accountId)
      .order("id")
      .limit(1);
    if (profileId) {
      q = supa
        .from("profiles")
        .select("*")
        .eq("account_id", accountId)
        .eq("id", profileId)
        .limit(1);
    }
    const { data: profile } = await q.maybeSingle<Profile>();
    if (!profile) {
      return NextResponse.json({ error: "No profile found" }, { status: 404 });
    }

    const { data: baselines } = await supa
      .from("profile_hotels")
      .select("hotel_id")
      .eq("profile_id", profile.id)
      .eq("role", "baseline")
      .returns<{ hotel_id: string }[]>();

    const targets = (baselines ?? [])
      .map((b) => b.hotel_id)
      .filter((id) => !baselineId || id === baselineId);
    if (targets.length === 0) {
      return NextResponse.json({ error: "No baseline hotels in this profile" }, { status: 400 });
    }

    const results = [];
    for (const id of targets) {
      results.push(
        await discoverForBaseline(
          supa,
          profile.id,
          id,
          profile.city_name ?? null,
          compCount
        )
      );
    }
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
