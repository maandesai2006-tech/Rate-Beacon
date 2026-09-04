// Persistence for the normalised manager's-report layer.
//
// Both ingest paths land here — the Cloudflare Email Worker webhook and the
// existing IMAP mailbox sync — so a report collected either way produces the
// same row and the same flags.

import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptSecret } from "./secrets";
import {
  analyzeDailyReport,
  deriveMetrics,
  type AnalysisContext,
  type DailyReportData,
  type InsightFlag,
} from "./analysisEngine";

/** Columns of daily_manager_reports that carry a number from the report. */
export const DAILY_METRIC_COLUMNS = [
  "occupancy_percent",
  "adr",
  "revpar",
  "room_revenue",
  "total_revenue",
  "rooms_sold",
  "rooms_available",
  "out_of_order",
  "no_shows",
  "cancellations",
  "total_reservations",
  "comp_rooms",
  "early_departures",
  "extended_stays",
  "walk_ins",
  "arrivals",
  "departures",
  "stayovers",
  "cash_variance",
  "total_adjustments",
  "direct_bill_transfers",
] as const;

export interface StoreInput {
  profileId: number;
  hotelId: string;
  reportDate: string;
  metrics: Partial<Record<(typeof DAILY_METRIC_COLUMNS)[number], number | null>>;
  source: string;
  extractor: string;
  extractorModel?: string | null;
  confidence?: number | null;
  rawPdfUrl?: string | null;
  currency?: string;
  /** The record of what arrived, kept on the row it produced. */
  rawText?: string | null;
  messageId?: string | null;
  fileName?: string | null;
  subject?: string | null;
  matchedBy?: string | null;
}

export interface StoreResult {
  reportId: number;
  flags: InsightFlag[];
  derived: DailyReportData;
}

export async function storeDailyReport(
  supa: SupabaseClient,
  input: StoreInput
): Promise<StoreResult> {
  const collected: Record<string, number> = {};
  for (const col of DAILY_METRIC_COLUMNS) {
    const v = input.metrics[col];
    if (v != null && Number.isFinite(v)) collected[col] = v;
  }
  const derived = deriveMetrics({ report_date: input.reportDate, ...collected } as DailyReportData);

  const row: Record<string, unknown> = {
    profile_id: input.profileId,
    hotel_id: input.hotelId,
    report_date: input.reportDate,
    source: input.source,
    extractor: input.extractor,
    extractor_model: input.extractorModel ?? null,
    confidence: input.confidence ?? null,
    raw_pdf_url: input.rawPdfUrl ?? null,
    // The report used to be written to a second table purely to keep these,
    // and nothing read that table. They live on the row they describe.
    // The night audit is the hotel's internal operating record. It is kept as
    // evidence for what the parser saw, but encrypted under APP_SECRET so a
    // copy of the database on its own does not expose it.
    raw_text: input.rawText ? await encryptSecret(input.rawText.slice(0, 60_000)) : null,
    message_id: input.messageId ?? null,
    file_name: input.fileName ?? null,
    subject: input.subject ?? null,
    matched_by: input.matchedBy ?? null,
  };
  for (const col of DAILY_METRIC_COLUMNS) {
    const v = derived[col];
    row[col] = v != null && Number.isFinite(v) ? v : null;
  }

  const { data: saved, error } = await supa
    .from("daily_manager_reports")
    .upsert(row, { onConflict: "profile_id,hotel_id,report_date" })
    .select("id")
    .single<{ id: number }>();

  if (error || !saved) {
    throw new Error(error?.message ?? "Could not save the normalised report");
  }

  const [history, context] = await Promise.all([
    loadHistory(supa, input.profileId, input.hotelId, input.reportDate),
    buildContext(supa, input.profileId, input.hotelId, input.reportDate, input.currency),
  ]);

  const flags = analyzeDailyReport(derived, history, context);

  // Replace rather than accumulate: re-running the engine over a corrected
  // report should leave exactly the flags the corrected numbers justify.
  await supa.from("daily_insights").delete().eq("report_id", saved.id);
  if (flags.length) {
    await supa.from("daily_insights").insert(
      flags.map((f) => ({
        report_id: saved.id,
        flag_type: f.flag_type,
        message: f.message,
        severity: f.severity,
        metric_key: f.metric_key,
        observed: f.observed,
        threshold: f.threshold,
      }))
    );
  }

  return { reportId: saved.id, flags, derived };
}

/** The 120 reports before this one — enough for every rolling window a rule uses. */
async function loadHistory(
  supa: SupabaseClient,
  profileId: number,
  hotelId: string,
  before: string
): Promise<DailyReportData[]> {
  const { data } = await supa
    .from("daily_manager_reports")
    .select(`report_date, ${DAILY_METRIC_COLUMNS.join(", ")}`)
    .eq("profile_id", profileId)
    .eq("hotel_id", hotelId)
    .lt("report_date", before)
    .order("report_date", { ascending: false })
    .limit(120)
    .returns<DailyReportData[]>();
  return (data ?? []).reverse();
}

/**
 * Real compset average for the report date, taken from the rate pipeline's own
 * snapshots. Returns null when the compset was not priced for that night, so
 * rule 13 skips rather than compares against something invented.
 */
async function buildContext(
  supa: SupabaseClient,
  profileId: number,
  hotelId: string,
  reportDate: string,
  currency?: string
): Promise<AnalysisContext> {
  const { data: comps } = await supa
    .from("baseline_comps")
    .select("comp_hotel_id")
    .eq("profile_id", profileId)
    .eq("baseline_hotel_id", hotelId)
    .returns<{ comp_hotel_id: string }[]>();

  const compIds = (comps ?? []).map((c) => c.comp_hotel_id);
  if (compIds.length === 0) return { currency };

  // One price per competitor: the most recently captured snapshot for that
  // arrival date.
  const { data: rates } = await supa
    .from("rate_snapshots")
    .select("hotel_id, price, captured_on")
    .in("hotel_id", compIds)
    .eq("check_in", reportDate)
    .order("captured_on", { ascending: false })
    .returns<{ hotel_id: string; price: number | null; captured_on: string }[]>();

  const latest = new Map<string, number>();
  for (const r of rates ?? []) {
    if (r.price == null || !Number.isFinite(Number(r.price))) continue;
    if (!latest.has(r.hotel_id)) latest.set(r.hotel_id, Number(r.price));
  }
  if (latest.size === 0) return { currency };

  const values = [...latest.values()];
  return {
    compsetAverageAdr: values.reduce((a, b) => a + b, 0) / values.length,
    compsetSize: values.length,
    currency,
  };
}
