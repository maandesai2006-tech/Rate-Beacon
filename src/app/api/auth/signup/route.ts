import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createAccount, SESSION_COOKIE, SESSION_MAX_AGE, startSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { identifier, password } = (await req.json().catch(() => ({}))) as {
    identifier?: string;
    password?: string;
  };
  if (!identifier || !password) {
    return NextResponse.json({ error: "Enter your username or email and password" }, { status: 400 });
  }
  const supa = db();
  const { account, error } = await createAccount(supa, identifier, password);
  if (error || !account) return NextResponse.json({ error }, { status: 400 });

  const token = await startSession(supa, account.id);
  const res = NextResponse.json({ ok: true, label: account.label });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return res;
}
