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
  const { data: tracked } = await supa
    .from("profile_hotels")
    .select("hotel_id, hotels(name)")
    .eq("profile_id", input.profileId)
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

  const { data: report, error } = await supa
    .from("manager_reports")
    .upsert(
      {
        profile_id: input.profileId,
        hotel_id: match.hotelId,
        report_date: reportDate,
        period: "day",
        source: input.source,
        file_name: input.fileName ?? null,
        subject: input.subject ?? null,
        raw_text: input.text.slice(0, 60_000),
        matched_by: match.matchedBy,
      },
      { onConflict: "profile_id,hotel_id,report_date,period" }
    )
    .select("id")
    .single<{ id: number }>();

  if (error || !report) {
    return {
      reportId: null,
      hotelId: match.hotelId,
      matchedBy: match.matchedBy,
      reportDate,
      metrics: 0,
      error: error?.message ?? "Could not save the report",
    };
  }

  // The narrow store stays the raw record of what the text parser saw.
  if (metrics.length) {
    await supa.from("report_metrics").upsert(
      metrics.map((m) => ({
        report_id: report.id,
        metric: m.metric,
        value: m.value,
        unit: m.unit,
      })),
      { onConflict: "report_id,metric" }
    );
  }

  // The normalised layer is what the dashboard and the fifteen rules read, so
  // a report collected over IMAP or by upload lands exactly as one that came
  // through the Cloudflare Worker.
  const found = Object.keys(wide).length;
  if (found) {
    try {
      await storeDailyReport(supa, {
        profileId: input.profileId,
        hotelId: match.hotelId,
        reportDate,
        metrics: wide,
        source: input.source,
        extractor,
        extractorModel,
        confidence,
        rawReportId: report.id,
      });
    } catch {
      // The raw report is already saved; a failure to normalise should not
      // lose it, and re-ingesting the same report replays this step.
    }
  }

  return {
    reportId: report.id,
    hotelId: match.hotelId,
    matchedBy: match.matchedBy,
    reportDate,
    metrics: found,
  };
}
