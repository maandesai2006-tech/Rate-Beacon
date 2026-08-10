import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accountForSession, SESSION_COOKIE } from "@/lib/auth";
import { ingestReport } from "@/lib/report-ingest";

export const maxDuration = 60;

// Manual upload: CSV, TSV, text, or an email saved as text. Spreadsheets
// should be exported to CSV first; a PDF can be pasted as text.
export async function POST(req: NextRequest) {
  const supa = db();
  const accountId = await accountForSession(supa, req.cookies.get(SESSION_COOKIE)?.value);
  if (!accountId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  let text = "";
  let fileName: string | undefined;
  let profileId: number | null = null;
  let hotelIdOverride: string | null = null;

  if (form) {
    const file = form.get("file");
    if (file && typeof file !== "string") {
      fileName = file.name;
      text = await file.text();
    }
    const pasted = form.get("text");
    if (typeof pasted === "string" && pasted.trim()) text = pasted;
    const pid = form.get("profileId");
    if (typeof pid === "string") profileId = Number(pid) || null;
    const hid = form.get("hotelId");
    if (typeof hid === "string" && hid) hotelIdOverride = hid;
  } else {
    const body = (await req.json().catch(() => ({}))) as {
      text?: string;
      profileId?: number;
      hotelId?: string;
    };
    text = body.text ?? "";
    profileId = body.profileId ?? null;
    hotelIdOverride = body.hotelId ?? null;
  }

  if (!text.trim()) {
    return NextResponse.json({ error: "No report content found in that file" }, { status: 400 });
  }

  // The profile must belong to the signed-in account.
  const { data: profile } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", profileId ?? -1)
    .maybeSingle<{ id: number }>();
  if (!profile) {
    return NextResponse.json({ error: "Unknown profile" }, { status: 400 });
  }

  const result = await ingestReport(supa, {
    profileId: profile.id,
    text,
    fileName,
    source: "upload",
    hotelIdOverride,
  });
  return NextResponse.json(result, { status: result.error && !result.reportId ? 422 : 200 });
}
