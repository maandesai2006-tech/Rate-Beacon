import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { DAILY_METRIC_COLUMNS } from "@/lib/daily-reports";
import type { Severity } from "@/lib/analysisEngine";

export const dynamic = "force-dynamic";

// Normalised reports and their stored flags for one profile, grouped by hotel.
// Reads daily_manager_reports / daily_insights — the layer the ingest pipeline
// writes and the fifteen rules run over — rather than re-deriving anything
// here, so the dashboard shows exactly what was flagged at ingest time.

// Enough history for a season's worth of trend without an unbounded payload.
const MAX_POINTS = 180;

interface DailyRow {
  id: number;
  hotel_id: string;
  report_date: string;
  extractor: string;
  confidence: number | null;
  [key: string]: unknown;
}

interface InsightRow {
  report_id: number;
  flag_type: string;
  message: string;
  severity: Severity;
  metric_key: string | null;
  observed: number | null;
  threshold: number | null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa } = auth;

  const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;
  const { data: profile } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", profileId ?? -1)
    .maybeSingle<{ id: number }>();
  if (!profile) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });

  // A forwarding token is created on first use.
  let { data: source } = await supa
    .from("report_sources")
    .select("inbox_token")
    .eq("profile_id", profile.id)
    .maybeSingle<{ inbox_token: string }>();
  if (!source) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const { data: created } = await supa
      .from("report_sources")
      .insert({ profile_id: profile.id, inbox_token: token })
      .select("inbox_token")
      .maybeSingle<{ inbox_token: string }>();
    source = created ?? { inbox_token: token };
  }

  const { data: rows } = await supa
    .from("daily_manager_reports")
    .select(`id, hotel_id, report_date, extractor, confidence, ${DAILY_METRIC_COLUMNS.join(", ")}`)
    .eq("profile_id", profile.id)
    .order("report_date", { ascending: true })
    .returns<DailyRow[]>();

  const all = rows ?? [];

  // Names for the hotels that actually have reports.
  const hotelIds = [...new Set(all.map((r) => r.hotel_id))];
  const { data: hotelRows } = hotelIds.length
    ? await supa
        .from("hotels")
        .select("hotel_id, name")
        .in("hotel_id", hotelIds)
        .returns<{ hotel_id: string; name: string }[]>()
    : { data: [] as { hotel_id: string; name: string }[] };
  const nameOf = new Map((hotelRows ?? []).map((h) => [h.hotel_id, h.name]));

  // Flags are only needed for each hotel's most recent night — that is what
  // the panel shows — so only those report ids are queried.
  const latestIdByHotel = new Map<string, number>();
  for (const r of all) latestIdByHotel.set(r.hotel_id, r.id); // ascending, so last wins
  const latestIds = [...latestIdByHotel.values()];

  const { data: insightRows } = latestIds.length
    ? await supa
        .from("daily_insights")
        .select("report_id, flag_type, message, severity, metric_key, observed, threshold")
        .in("report_id", latestIds)
        .returns<InsightRow[]>()
    : { data: [] as InsightRow[] };

  const insightsByReport = new Map<number, InsightRow[]>();
  for (const i of insightRows ?? []) {
    insightsByReport.set(i.report_id, [...(insightsByReport.get(i.report_id) ?? []), i]);
  }

  const byHotel = new Map<string, DailyRow[]>();
  for (const r of all) {
    byHotel.set(r.hotel_id, [...(byHotel.get(r.hotel_id) ?? []), r]);
  }

  const hotels = [...byHotel.entries()]
    .map(([hotelId, list]) => {
      const trimmed = list.slice(-MAX_POINTS);
      const latest = list[list.length - 1];
      const points = trimmed.map((r) => {
        const point: Record<string, unknown> = { date: r.report_date };
        for (const col of DAILY_METRIC_COLUMNS) {
          const v = r[col];
          point[col] = v == null ? null : Number(v);
        }
        return point;
      });
      return {
        hotelId,
        name: nameOf.get(hotelId) ?? hotelId,
        reportCount: list.length,
        firstDate: list[0]?.report_date ?? null,
        latestDate: latest?.report_date ?? null,
        extractor: latest?.extractor ?? null,
        confidence: latest?.confidence == null ? null : Number(latest.confidence),
        points,
        insights: (insightsByReport.get(latest?.id ?? -1) ?? []).map((i) => ({
          flag_type: i.flag_type,
          message: i.message,
          severity: i.severity,
          metric_key: i.metric_key,
          observed: i.observed == null ? null : Number(i.observed),
          threshold: i.threshold == null ? null : Number(i.threshold),
        })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ inboxToken: source.inbox_token, hotels });
}
