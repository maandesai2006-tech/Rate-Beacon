import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestReport } from "@/lib/report-ingest";

export const maxDuration = 60;

// Generic inbound-email webhook. Any forwarding service can post here —
// SendGrid Inbound Parse, Mailgun routes, Cloudflare Email Workers, Zapier,
// Make — as long as it sends the message text and the address it was sent to.
// The address carries the profile's token: reports+<token>@yourdomain.
//
// Accepts JSON or multipart form data, and reads the fields those services
// commonly use, so no provider-specific adapter is needed.
export async function POST(req: NextRequest) {
  const supa = db();
  const contentType = req.headers.get("content-type") ?? "";

  let to = "";
  let subject = "";
  let text = "";
  let token = req.nextUrl.searchParams.get("token") ?? "";

  if (contentType.includes("application/json")) {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    to = String(b.to ?? b.recipient ?? b.To ?? "");
    subject = String(b.subject ?? b.Subject ?? "");
    text = String(b.text ?? b["body-plain"] ?? b.plain ?? b.html ?? b["body-html"] ?? b.TextBody ?? "");
  } else {
    const form = await req.formData().catch(() => null);
    if (form) {
      to = String(form.get("to") ?? form.get("recipient") ?? "");
      subject = String(form.get("subject") ?? "");
      text = String(
        form.get("text") ?? form.get("body-plain") ?? form.get("html") ?? form.get("body-html") ?? ""
      );
      // Some services post attachments separately.
      for (const [k, v] of form.entries()) {
        if (k.startsWith("attachment") && typeof v !== "string") {
          text += "\n" + (await v.text());
        }
      }
    }
  }

  if (!token) {
    // reports+<token>@domain  or  <token>@domain
    const m = to.match(/(?:\+|^)([a-z0-9]{8,})@/i);
    if (m) token = m[1];
  }
  if (!token) {
    return NextResponse.json({ error: "No profile token in the recipient address" }, { status: 400 });
  }
  if (!text.trim()) {
    return NextResponse.json({ error: "Empty message" }, { status: 400 });
  }

  const { data: src } = await supa
    .from("report_sources")
    .select("profile_id")
    .eq("inbox_token", token.toLowerCase())
    .maybeSingle<{ profile_id: number }>();
  if (!src) {
    return NextResponse.json({ error: "Unknown token" }, { status: 404 });
  }

  const result = await ingestReport(supa, {
    profileId: src.profile_id,
    text,
    subject,
    source: "email",
  });
  return NextResponse.json(result);
}
