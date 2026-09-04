import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reportError } from "@/lib/errors";

export const dynamic = "force-dynamic";

// "Contact us" on the public site.
//
// Public, so it assumes the worst: a size cap, a honeypot field bots fill in
// and people never see, and one enquiry per address per ten minutes. What it
// writes is a row someone reads and answers — there is no mail provider on the
// deployment, and pretending to send an email that never arrives would be
// worse than saying "we have it".

const PROPERTY_TYPES = new Set(["franchised", "independent", "bnb", "other"]);

interface Body {
  name?: string;
  email?: string;
  propertyName?: string;
  propertyType?: string;
  message?: string;
  source?: string;
  /** Honeypot: rendered off-screen, so a value means a bot. */
  website?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return NextResponse.json({ error: "Expected a message" }, { status: 400 });

  // Bots fill every field. People cannot see this one.
  if (body.website) return NextResponse.json({ ok: true });

  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return NextResponse.json({ error: "Enter the email address you would like a reply at" }, { status: 400 });
  }
  const propertyType = PROPERTY_TYPES.has(body.propertyType ?? "") ? body.propertyType : null;

  const supa = db();

  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const { count } = await supa
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("email", email)
    .gte("created_at", tenMinutesAgo);
  if ((count ?? 0) > 0) {
    return NextResponse.json({ ok: true, note: "We already have your message — we will be in touch." });
  }

  const { error } = await supa.from("leads").insert({
    name: (body.name ?? "").trim().slice(0, 120) || null,
    email,
    property_name: (body.propertyName ?? "").trim().slice(0, 200) || null,
    property_type: propertyType,
    message: (body.message ?? "").trim().slice(0, 4000) || null,
    source: (body.source ?? "landing").slice(0, 40),
  });

  if (error) {
    await reportError("contact", error, { detail: `from ${email}` });
    return NextResponse.json(
      { error: "Your message could not be saved. Email us directly and we will sort it out." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
