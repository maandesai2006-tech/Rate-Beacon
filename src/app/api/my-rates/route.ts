import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { profileId, checkIn, price } = (await req.json()) as {
    profileId?: number;
    checkIn?: string;
    price?: number | null;
  };
  if (!profileId || !checkIn || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) {
    return NextResponse.json(
      { error: "profileId and checkIn (YYYY-MM-DD) required" },
      { status: 400 }
    );
  }
  // This endpoint used to take a profileId and no credentials at all, so
  // anyone who guessed an id could overwrite another hotel's rate overrides.
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa } = auth;

  const { data: owned } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", profileId)
    .maybeSingle<{ id: number }>();
  if (!owned) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });

  if (price == null) {
    const { error } = await supa
      .from("my_rates")
      .delete()
      .eq("profile_id", profileId)
      .eq("check_in", checkIn);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supa.from("my_rates").upsert({
      profile_id: profileId,
      check_in: checkIn,
      price,
      updated_at: new Date().toISOString(),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
