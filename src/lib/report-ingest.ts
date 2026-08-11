// Shared ingestion path for manager's reports, whether they arrive by email
// or by upload. One code path so both routes behave identically.

import { SupabaseClient } from "@supabase/supabase-js";
import { extractMetrics, extractReportDate, matchHotel } from "./reports";
import { todayISO } from "./dates";
import { storeDailyReport, DAILY_METRIC_COLUMNS } from "./daily-reports";

export interface IngestInput {
  profileId: number;
  text: string;
  subject?: string;
  fileName?: string;
  source: "upload" | "email";
  hotelIdOverride?: string | null;
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

  const match = input.hotelIdOverride
    ? { hotelId: input.hotelIdOverride, matchedBy: "chosen manually" }
    : matchHotel(input.text, input.subject ?? "", candidates);

  const reportDate = extractReportDate(input.text, todayISO());
  const metrics = extractMetrics(input.text);

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

    // Mirror into the normalised layer so a report collected over IMAP or by
    // upload produces the same row, and the same fifteen flags, as one that
    // arrived through the Cloudflare Worker.
    const wide: Partial<Record<(typeof DAILY_METRIC_COLUMNS)[number], number>> = {};
    for (const m of metrics) {
      const col = m.metric === "occupancy" ? "occupancy_percent" : m.metric;
      if ((DAILY_METRIC_COLUMNS as readonly string[]).includes(col)) {
        wide[col as (typeof DAILY_METRIC_COLUMNS)[number]] = m.value;
      }
    }
    try {
      await storeDailyReport(supa, {
        profileId: input.profileId,
        hotelId: match.hotelId,
        reportDate,
        metrics: wide,
        source: input.source,
        extractor: "text-parser",
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
    metrics: metrics.length,
  };
}
