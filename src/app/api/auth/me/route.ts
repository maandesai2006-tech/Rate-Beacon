import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accountForSession, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supa = db();
  const accountId = await accountForSession(supa, req.cookies.get(SESSION_COOKIE)?.value);
  if (!accountId) return NextResponse.json({ signedIn: false });
  const { data } = await supa
    .from("accounts")
    .select("email, username")
    .eq("id", accountId)
    .maybeSingle<{ email: string | null; username: string | null }>();
  return NextResponse.json({ signedIn: true, label: data?.username ?? data?.email ?? null });
}
