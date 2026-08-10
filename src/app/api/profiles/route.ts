import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accountForSession, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Only the signed-in account's profiles.
export async function GET(req: NextRequest) {
  const supa = db();
  const accountId = await accountForSession(supa, req.cookies.get(SESSION_COOKIE)?.value);
  if (!accountId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });

  const { data, error } = await supa
    .from("profiles")
    .select("id, name, hotel_name, city_name")
    .eq("account_id", accountId)
    .order("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ profiles: data ?? [] });
}
