import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { encryptSecret } from "@/lib/secrets";
import { testConnection } from "@/lib/mailbox";

export const maxDuration = 60;

/**
 * Resolve the caller's profile and hand back the client scoped to them, so
 * every query below is bounded by the account rather than by remembering to
 * add a filter.
 */
async function profileFor(
  req: NextRequest,
  profileId: number | null
): Promise<{ profile: { id: number }; supa: SupabaseClient } | null> {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return null;
  const { accountId, supa } = auth;
  const { data } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", profileId ?? -1)
    .maybeSingle<{ id: number }>();
  return data ? { profile: data, supa } : null;
}

// Current connection, without ever returning the password.
export async function GET(req: NextRequest) {
  const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;
  const found = await profileFor(req, profileId);
  if (!found) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });
  const { profile, supa } = found;

  const { data } = await supa
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
  const found = await profileFor(req, body.profileId ?? null);
  if (!found) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });
  const { profile, supa } = found;
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
  const found = await profileFor(req, profileId);
  if (!found) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });
  const { profile, supa } = found;
  await supa.from("email_sources").delete().eq("profile_id", profile.id);
  return NextResponse.json({ ok: true });
}
