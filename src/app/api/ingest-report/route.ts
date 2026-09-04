// Webhook the Cloudflare Email Worker posts to.
//
//   Worker → POST /api/ingest-report  (HMAC-signed)
//     → resolve the alias to a profile and hotel
//     → Gemini reads the PDF into a normalised row
//     → the 15-rule analysis engine flags the night
//     → daily_manager_reports + daily_insights
//
// The route is idempotent: the same report posted twice overwrites its own
// row and its own flags rather than duplicating the night.

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { extractReport, geminiConfigured, DEFAULT_MODEL, UnreadableReportError } from "@/lib/gemini";
import { storeDailyReport, DAILY_METRIC_COLUMNS } from "@/lib/daily-reports";
import { extractMetrics, extractReportDate, matchHotel } from "@/lib/reports";
import { pdfToText } from "@/lib/pdf";
import { todayISO } from "@/lib/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A multi-page scan through Gemini takes a few seconds; Hobby caps at 60.
export const maxDuration = 60;

interface InboundAttachment {
  filename?: string;
  mimeType?: string;
  size?: number;
  contentBase64?: string;
}

interface InboundPayload {
  alias?: string;
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  receivedAt?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: InboundAttachment[];
}

interface FileOutcome {
  file: string;
  ok: boolean;
  hotelId?: string;
  reportDate?: string;
  extractor?: string;
  flags?: number;
  metricsFound?: number;
  error?: string;
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  const auth = verifySignature(req, raw);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  let payload: InboundPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Body was not JSON" }, { status: 400 });
  }

  const alias = (payload.alias ?? "").trim().toLowerCase();
  if (!alias) {
    return NextResponse.json({ error: "No alias on the payload" }, { status: 400 });
  }

  const supa = db();

  // Sub-addressing: reports+hotel123@… should resolve to the hotel123 alias.
  const baseAlias = alias.split("+")[0];
  const { data: inbox } = await supa
    .from("report_inboxes")
    .select("alias, profile_id, hotel_id, active")
    .in("alias", [alias, baseAlias])
    .eq("active", true)
    .limit(1)
    .maybeSingle<{ alias: string; profile_id: number; hotel_id: string | null; active: boolean }>();

  if (!inbox) {
    return NextResponse.json(
      { error: `No active report inbox is configured for "${alias}"` },
      { status: 404 }
    );
  }

  // Which hotels this profile tracks, for the case where the alias is not
  // pinned to one property.
  const { data: tracked } = await supa
    .from("profile_hotels")
    .select("hotel_id, hotels(name)")
    .eq("profile_id", inbox.profile_id)
    .returns<{ hotel_id: string; hotels: { name: string } | null }[]>();
  const candidates = (tracked ?? []).map((t) => ({
    hotel_id: t.hotel_id,
    name: t.hotels?.name ?? t.hotel_id,
  }));

  const { data: profile } = await supa
    .from("profiles")
    .select("currency")
    .eq("id", inbox.profile_id)
    .maybeSingle<{ currency: string | null }>();
  const currency = profile?.currency ?? "USD";

  // Attachments are the normal case; a body-only report is handled as a
  // single pseudo-file so one code path covers both.
  const files: InboundAttachment[] = (payload.attachments ?? []).filter((a) => a.contentBase64);
  const bodyOnly = files.length === 0 && Boolean(payload.bodyText || payload.bodyHtml);

  const results: FileOutcome[] = [];

  const units = bodyOnly
    ? [{ filename: "email body", mimeType: "text/plain", contentBase64: undefined }]
    : files;

  for (const file of units) {
    const label = file.filename ?? "attachment";
    try {
      results.push(
        await ingestOne({
          supa,
          profileId: inbox.profile_id,
          pinnedHotelId: inbox.hotel_id,
          candidates,
          currency,
          payload,
          file,
        })
      );
    } catch (err) {
      results.push({ file: label, ok: false, error: errText(err) });
    }
  }

  await supa
    .from("report_inboxes")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("alias", inbox.alias);

  const anyOk = results.some((r) => r.ok);
  return NextResponse.json(
    { alias: inbox.alias, profileId: inbox.profile_id, results },
    // A 422 tells the Worker not to retry: the mail arrived fine, the content
    // was the problem, and re-posting it would fail identically.
    { status: anyOk ? 200 : 422 }
  );
}

async function ingestOne(args: {
  supa: ReturnType<typeof db>;
  profileId: number;
  pinnedHotelId: string | null;
  candidates: { hotel_id: string; name: string }[];
  currency: string;
  payload: InboundPayload;
  file: InboundAttachment;
}): Promise<FileOutcome> {
  const { supa, profileId, pinnedHotelId, candidates, currency, payload, file } = args;
  const label = file.filename ?? "email body";
  const bytes = file.contentBase64 ? Buffer.from(file.contentBase64, "base64") : null;
  const isPdf =
    (file.mimeType ?? "").includes("pdf") || (file.filename ?? "").toLowerCase().endsWith(".pdf");

  // Text is pulled out regardless of which extractor wins: it identifies the
  // hotel, and it is kept on the raw ledger so a report can be re-parsed later
  // without going back to the mailbox.
  let text = "";
  if (bytes && isPdf) {
    try {
      const pdf = await pdfToText(new Uint8Array(bytes));
      text = pdf.text;
    } catch {
      text = ""; // a scan has no text layer; Gemini reads it anyway
    }
  } else if (bytes) {
    text = bytes.toString("utf8");
  } else {
    text = payload.bodyText || stripHtml(payload.bodyHtml ?? "");
  }

  const subject = payload.subject ?? "";

  // ── Extraction: Gemini first, the text parser as the fallback ──────────
  let metrics: Partial<Record<(typeof DAILY_METRIC_COLUMNS)[number], number | null>> = {};
  let reportDate: string | null = null;
  let extractor = "text-parser";
  let extractorModel: string | null = null;
  let confidence: number | null = null;
  let hotelNameHint: string | null = null;
  let pmsType: string | null = null;
  let geminiError: string | null = null;

  if (geminiConfigured() && (bytes || text)) {
    try {
      const extracted = await extractReport({
        base64: bytes && isPdf ? bytes.toString("base64") : undefined,
        mimeType: file.mimeType,
        fileName: file.filename,
        text: bytes && isPdf ? undefined : text,
        subject,
      });
      for (const col of DAILY_METRIC_COLUMNS) {
        const v = extracted[col as keyof typeof extracted];
        if (typeof v === "number") metrics[col] = v;
      }
      reportDate = extracted.report_date;
      hotelNameHint = extracted.hotel_name;
      pmsType = extracted.pms_type;
      confidence = extracted.confidence;
      extractor = "gemini";
      extractorModel = DEFAULT_MODEL;
    } catch (err) {
      geminiError = errText(err);
      if (err instanceof UnreadableReportError && !text.trim()) {
        // Nothing readable by either route — record the failure rather than
        // writing an empty night into the hotel's history.
        return { file: label, ok: false, error: `Unreadable report: ${geminiError}` };
      }
    }
  }

  if (extractor !== "gemini") {
    if (!text.trim()) {
      return {
        file: label,
        ok: false,
        error: geminiError ?? "No text could be read from this attachment",
      };
    }
    const found = extractMetrics(text);
    metrics = {};
    for (const m of found) {
      // The narrow parser calls it "occupancy"; the wide table wants
      // "occupancy_percent". Everything else lines up.
      const col = m.metric === "occupancy" ? "occupancy_percent" : m.metric;
      if ((DAILY_METRIC_COLUMNS as readonly string[]).includes(col)) {
        metrics[col as (typeof DAILY_METRIC_COLUMNS)[number]] = m.value;
      }
    }
    reportDate = extractReportDate(text, todayISO());
  }

  if (Object.keys(metrics).length === 0) {
    return {
      file: label,
      ok: false,
      error: geminiError
        ? `No figures found (${geminiError})`
        : "No figures could be read from this report",
    };
  }

  // ── Which hotel ────────────────────────────────────────────────────────
  const haystack = [hotelNameHint, text].filter(Boolean).join("\n");
  const match = pinnedHotelId
    ? { hotelId: pinnedHotelId, matchedBy: "inbox alias" }
    : matchHotel(haystack, subject, candidates);

  if (!match) {
    return {
      file: label,
      ok: false,
      error:
        "Could not tell which hotel this report belongs to. Pin the alias to a hotel in report_inboxes.",
    };
  }

  const date = reportDate ?? todayISO();

  if (pmsType) {
    await supa.from("hotels").update({ pms_type: pmsType }).eq("hotel_id", match.hotelId);
  }

  const stored = await storeDailyReport(supa, {
    profileId,
    hotelId: match.hotelId,
    reportDate: date,
    metrics,
    source: "email",
    extractor,
    extractorModel,
    confidence,
    currency,
    rawText: text,
    messageId: payload.messageId || null,
    fileName: file.filename ?? null,
    subject: subject || null,
    matchedBy: match.matchedBy,
  });

  return {
    file: label,
    ok: true,
    hotelId: match.hotelId,
    reportDate: date,
    extractor,
    metricsFound: Object.keys(metrics).length,
    flags: stored.flags.length,
  };
}

// ── Request authentication ────────────────────────────────────────────────

/**
 * HMAC over "<timestamp>.<body>" with the shared secret, compared in constant
 * time, with a five-minute window so a captured POST cannot be replayed.
 */
function verifySignature(req: NextRequest, body: string): { ok: true } | { ok: false; error: string } {
  const secret = process.env.INGEST_SECRET;
  if (!secret) return { ok: false, error: "INGEST_SECRET is not set on the server" };

  const signature = req.headers.get("x-ratebeacon-signature") ?? "";
  const timestamp = req.headers.get("x-ratebeacon-timestamp") ?? "";
  if (!signature || !timestamp) return { ok: false, error: "Missing signature headers" };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) {
    return { ok: false, error: "Signature timestamp is outside the accepted window" };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const given = signature.replace(/^sha256=/, "");
  if (given.length !== expected.length) return { ok: false, error: "Bad signature" };
  if (!timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"))) {
    return { ok: false, error: "Bad signature" };
  }
  return { ok: true };
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(tr|div|p|table)>/gi, "\n")
    .replace(/<t[dh][^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
