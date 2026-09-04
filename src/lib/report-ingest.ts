// Shared ingestion path for manager's reports, whether they arrive by email
// or by upload. One code path so both routes behave identically.

import { SupabaseClient } from "@supabase/supabase-js";
import { extractMetrics, extractReportDate, matchHotel } from "./reports";
import { todayISO } from "./dates";
import { storeDailyReport, DAILY_METRIC_COLUMNS } from "./daily-reports";
import { extractReport, geminiConfigured, DEFAULT_MODEL } from "./gemini";

export interface IngestInput {
  profileId: number;
  text: string;
  subject?: string;
  fileName?: string;
  source: "upload" | "email";
  hotelIdOverride?: string | null;
  /** Whole PDF, so the model can read a scan the text layer cannot. */
  pdfBase64?: string | null;
}

export interface IngestResult {
  reportId: number | null;
  hotelId: string | null;
  matchedBy: string | null;
  reportDate: string;
  metrics: number;
  error?: string;
}

export async function ingestReport(
  supa: SupabaseClient,
  input: IngestInput
): Promise<IngestResult> {
  // Only hotels this profile actually operates are candidates. A manager's
  // report comes out of your own PMS; it is never a competitor's. Matching
  // against the whole tracked set is how a Holiday Inn Express night audit
  // ended up filed under "Destin Inn & Suites" — the competitor's only
  // distinctive word is "destin", which the report obviously contains.
  const { data: tracked } = await supa
    .from("profile_hotels")
    .select("hotel_id, hotels(name)")
    .eq("profile_id", input.profileId)
    .eq("is_mine", true)
    .returns<{ hotel_id: string; hotels: { name: string } | null }[]>();

  const candidates = (tracked ?? []).map((t) => ({
    hotel_id: t.hotel_id,
    name: t.hotels?.name ?? t.hotel_id,
  }));

  // Gemini reads the report when a key is set — it handles scans and the
  // multi-column Today/MTD/YTD layouts the regex parser cannot. Without a key,
  // or if the call fails, the regex parser still runs, so ingestion never
  // depends on the model being reachable.
  let wide: Partial<Record<(typeof DAILY_METRIC_COLUMNS)[number], number>> = {};
  let reportDate = extractReportDate(input.text, todayISO());
  let extractor = "text-parser";
  let extractorModel: string | null = null;
  let confidence: number | null = null;
  let hotelNameHint = "";

  if (geminiConfigured() && (input.pdfBase64 || input.text.trim())) {
    try {
      const g = await extractReport({
        base64: input.pdfBase64 ?? undefined,
        mimeType: input.pdfBase64 ? "application/pdf" : undefined,
        fileName: input.fileName,
        text: input.pdfBase64 ? undefined : input.text,
        subject: input.subject,
      });
      for (const col of DAILY_METRIC_COLUMNS) {
        const v = g[col as keyof typeof g];
        if (typeof v === "number") wide[col] = v;
      }
      if (g.report_date) reportDate = g.report_date;
      if (g.hotel_name) hotelNameHint = g.hotel_name;
      extractor = "gemini";
      extractorModel = DEFAULT_MODEL;
      confidence = g.confidence;
    } catch {
      wide = {};
    }
  }

  const metrics = extractMetrics(input.text);
  if (extractor !== "gemini" || Object.keys(wide).length === 0) {
    extractor = "text-parser";
    extractorModel = null;
    confidence = null;
    wide = {};
    for (const m of metrics) {
      const col = m.metric === "occupancy" ? "occupancy_percent" : m.metric;
      if ((DAILY_METRIC_COLUMNS as readonly string[]).includes(col)) {
        wide[col as (typeof DAILY_METRIC_COLUMNS)[number]] = m.value;
      }
    }
  }

  const match = input.hotelIdOverride
    ? { hotelId: input.hotelIdOverride, matchedBy: "chosen manually" }
    : matchHotel(
        `${hotelNameHint}\n${input.text}`,
        input.subject ?? "",
        candidates
      );

  if (!match) {
    return {
      reportId: null,
      hotelId: null,
      matchedBy: null,
      reportDate,
      metrics: metrics.length,
      error:
        "Could not tell which hotel this report belongs to. Upload it again and pick the hotel.",
    };
  }

  // One row per hotel-night, carrying both the numbers and the text they were
  // read from. A report collected over IMAP or by upload lands exactly as one
  // that came through the Cloudflare Worker.
  const found = Object.keys(wide).length;
  let reportId: number | null = null;
  try {
    const stored = await storeDailyReport(supa, {
      profileId: input.profileId,
      hotelId: match.hotelId,
      reportDate,
      metrics: wide,
      source: input.source,
      extractor,
      extractorModel,
      confidence,
      rawText: input.text,
      fileName: input.fileName ?? null,
      subject: input.subject ?? null,
      matchedBy: match.matchedBy,
    });
    reportId = stored.reportId;
  } catch (e) {
    return {
      reportId: null,
      hotelId: match.hotelId,
      matchedBy: match.matchedBy,
      reportDate,
      metrics: found,
      error: (e as Error).message,
    };
  }

  return {
    reportId,
    hotelId: match.hotelId,
    matchedBy: match.matchedBy,
    reportDate,
    metrics: found,
  };
}
