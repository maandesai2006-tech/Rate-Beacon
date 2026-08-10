import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { SESSION_COOKIE, SESSION_MAX_AGE, startSession, verifyLogin } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { identifier, password } = (await req.json().catch(() => ({}))) as {
    identifier?: string;
    password?: string;
  };
  if (!identifier || !password) {
    return NextResponse.json({ error: "Enter your username or email and password" }, { status: 400 });
  }
  const supa = db();
  const { accountId, error } = await verifyLogin(supa, identifier, password);
  if (error || !accountId) return NextResponse.json({ error }, { status: 401 });

  const token = await startSession(supa, accountId);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return res;
}
