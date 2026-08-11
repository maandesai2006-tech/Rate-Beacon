import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accountForSession, SESSION_COOKIE } from "@/lib/auth";
import { encryptSecret } from "@/lib/secrets";
import { testConnection } from "@/lib/mailbox";

export const maxDuration = 60;

async function profileFor(req: NextRequest, profileId: number | null) {
  const supa = db();
  const accountId = await accountForSession(supa, req.cookies.get(SESSION_COOKIE)?.value);
  if (!accountId) return null;
  const { data } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", profileId ?? -1)
    .maybeSingle<{ id: number }>();
  return data;
}

// Current connection, without ever returning the password.
export async function GET(req: NextRequest) {
  const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;
  const profile = await profileFor(req, profileId);
  if (!profile) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });

  const { data } = await db()
    .from("email_sources")
    .select("id, host, port, username, mailbox, subject_filter, from_filter, last_sync_at, last_status")
    .eq("profile_id", profile.id)
    .maybeSingle();
  return NextResponse.json({ source: data ?? null });
}

// Connect a mailbox. The credentials are verified before they are stored, so
// a bad login is reported immediately rather than failing quietly at 6am.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    profileId?: number;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    mailbox?: string;
    subjectFilter?: string;
    fromFilter?: string;
  };
  const profile = await profileFor(req, body.profileId ?? null);
  if (!profile) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });
  if (!body.host || !body.username || !body.password) {
    return NextResponse.json({ error: "Mail server, username and password are all needed" }, { status: 400 });
  }

  const cfg = {
    host: body.host.trim(),
    port: body.port || 993,
    username: body.username.trim(),
    password: body.password,
    mailbox: (body.mailbox || "INBOX").trim(),
    subjectFilter: body.subjectFilter?.trim() || null,
    fromFilter: body.fromFilter?.trim() || null,
  };

  const test = await testConnection(cfg);
  if (!test.ok) {
    return NextResponse.json({ error: `Could not sign in: ${test.detail}` }, { status: 400 });
  }

  const supa = db();
  const { error } = await supa.from("email_sources").upsert(
    {
      profile_id: profile.id,
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      secret: await encryptSecret(cfg.password),
      mailbox: cfg.mailbox,
      subject_filter: cfg.subjectFilter,
      from_filter: cfg.fromFilter,
      last_status: test.detail,
    },
    { onConflict: "profile_id,username,host" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, detail: test.detail });
}

export async function DELETE(req: NextRequest) {
  const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;
  const profile = await profileFor(req, profileId);
  if (!profile) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });
  await db().from("email_sources").delete().eq("profile_id", profile.id);
  return NextResponse.json({ ok: true });
}
