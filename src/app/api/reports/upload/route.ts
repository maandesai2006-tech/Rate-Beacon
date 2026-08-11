import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accountForSession, SESSION_COOKIE } from "@/lib/auth";
import { ingestReport } from "@/lib/report-ingest";
import { pdfToText } from "@/lib/pdf";
import { geminiConfigured } from "@/lib/gemini";

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
  let pdfBase64: string | null = null;

  if (form) {
    const file = form.get("file");
    if (file && typeof file !== "string") {
      fileName = file.name;
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      if (isPdf) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        pdfBase64 = Buffer.from(bytes).toString("base64");
        const out = await pdfToText(bytes).catch(() => null);
        // A scan has no text layer. That is only fatal when the model is not
        // configured to read the page image instead.
        if (!out?.hasTextLayer && !geminiConfigured()) {
          return NextResponse.json(
            {
              error:
                "That PDF has no text layer — it is a scan or an image. Set GEMINI_API_KEY so scans can be read, ask for the report as a text or CSV export, or paste its contents instead.",
            },
            { status: 422 }
          );
        }
        text = out?.text ?? "";
      } else {
        text = await file.text();
      }
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

  if (!text.trim() && !pdfBase64) {
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
    pdfBase64,
    source: "upload",
    hotelIdOverride,
  });
  return NextResponse.json(result, { status: result.error && !result.reportId ? 422 : 200 });
}
