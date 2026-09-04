import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accountForSession, SESSION_COOKIE } from "@/lib/auth";
import { reportError } from "@/lib/errors";

export const dynamic = "force-dynamic";

// Deleting your own account, and everything it holds.
//
// A customer's data is theirs to remove. Profiles, tracked hotels, competitor
// sets, manual rates, manager's reports and their flags, mailbox credentials,
// sessions — all cascade from the account row. The shared market data (hotel
// names, published rates) is not theirs and stays; it holds nothing private.
//
// The Supabase auth user that backs the account goes with it, so the same
// address can sign up again cleanly later.

export async function DELETE(req: NextRequest) {
  const supa = db();
  const accountId = await accountForSession(supa, req.cookies.get(SESSION_COOKIE)?.value);
  if (!accountId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== "DELETE") {
    return NextResponse.json(
      { error: 'Type DELETE to confirm — this removes the account and all of its data permanently.' },
      { status: 400 }
    );
  }

  const { data: account } = await supa
    .from("accounts")
    .select("auth_user_id")
    .eq("id", accountId)
    .maybeSingle<{ auth_user_id: string | null }>();

  // my_rates has no cascading key, so it is cleared explicitly.
  const { data: profiles } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .returns<{ id: number }[]>();
  const profileIds = (profiles ?? []).map((p) => p.id);
  if (profileIds.length) await supa.from("my_rates").delete().in("profile_id", profileIds);

  const { error } = await supa.from("accounts").delete().eq("id", accountId);
  if (error) {
    await reportError("auth", error, { accountId, detail: "account deletion" });
    return NextResponse.json({ error: "The account could not be deleted. Try again in a moment." }, { status: 500 });
  }

  if (account?.auth_user_id) {
    await supa.auth.admin.deleteUser(account.auth_user_id).catch(() => {});
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
