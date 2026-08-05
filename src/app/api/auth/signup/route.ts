import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createAccount, SESSION_COOKIE, SESSION_MAX_AGE, startSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { email, password } = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }
  const supa = db();
  const { account, error } = await createAccount(supa, email, password);
  if (error || !account) return NextResponse.json({ error }, { status: 400 });

  const token = await startSession(supa, account.id);
  const res = NextResponse.json({ ok: true, email: account.email });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return res;
}
