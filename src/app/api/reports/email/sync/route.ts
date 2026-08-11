import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accountForSession, SESSION_COOKIE } from "@/lib/auth";
import { syncMailbox } from "@/lib/mail-sync";

export const maxDuration = 60;

// Check the connected mailbox now.
export async function POST(req: NextRequest) {
  const supa = db();
  const accountId = await accountForSession(supa, req.cookies.get(SESSION_COOKIE)?.value);
  if (!accountId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });

  const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;
  const { data: profile } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", profileId ?? -1)
    .maybeSingle<{ id: number }>();
  if (!profile) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });

  const { data: source } = await supa
    .from("email_sources")
    .select("*")
    .eq("profile_id", profile.id)
    .maybeSingle();
  if (!source) return NextResponse.json({ error: "No mailbox connected yet" }, { status: 400 });

  const outcome = await syncMailbox(supa, source);
  return NextResponse.json(outcome, { status: outcome.error ? 502 : 200 });
}
