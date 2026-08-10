import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accountForSession, SESSION_COOKIE } from "@/lib/auth";
import { analyseReports, type ReportPoint } from "@/lib/report-analysis";
import type { MetricKey } from "@/lib/reports";

export const dynamic = "force-dynamic";

// Reports and their analyses for one profile, grouped by hotel. Also returns
// the forwarding token so the UI can show the address to forward reports to.
export async function GET(req: NextRequest) {
  const supa = db();
  const accountId = await accountForSession(supa, req.cookies.get(SESSION_COOKIE)?.value);
  if (!accountId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });

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

  const { data: reports } = await supa
    .from("manager_reports")
    .select("id, hotel_id, report_date, source, file_name, matched_by, created_at, hotels(name)")
    .eq("profile_id", profile.id)
    .order("report_date", { ascending: true })
    .returns<
      {
        id: number;
        hotel_id: string | null;
        report_date: string;
        source: string;
        file_name: string | null;
        matched_by: string | null;
        created_at: string;
        hotels: { name: string } | null;
      }[]
    >();

  const ids = (reports ?? []).map((r) => r.id);
  const { data: metricRows } = ids.length
    ? await supa
        .from("report_metrics")
        .select("report_id, metric, value")
        .in("report_id", ids)
        .returns<{ report_id: number; metric: string; value: number | null }[]>()
    : { data: [] as { report_id: number; metric: string; value: number | null }[] };

  const metricsByReport = new Map<number, Partial<Record<MetricKey, number>>>();
  for (const m of metricRows ?? []) {
    if (m.value == null) continue;
    const bag = metricsByReport.get(m.report_id) ?? {};
    bag[m.metric as MetricKey] = Number(m.value);
    metricsByReport.set(m.report_id, bag);
  }

  const byHotel = new Map<
    string,
    { hotelId: string; name: string; points: ReportPoint[]; latestSource: string; count: number }
  >();
  for (const r of reports ?? []) {
    if (!r.hotel_id) continue;
    const entry =
      byHotel.get(r.hotel_id) ??
      {
        hotelId: r.hotel_id,
        name: r.hotels?.name ?? r.hotel_id,
        points: [] as ReportPoint[],
        latestSource: r.source,
        count: 0,
      };
    entry.points.push({ date: r.report_date, metrics: metricsByReport.get(r.id) ?? {} });
    entry.latestSource = r.source;
    entry.count += 1;
    byHotel.set(r.hotel_id, entry);
  }

  const hotels = [...byHotel.values()].map((h) => ({
    hotelId: h.hotelId,
    name: h.name,
    reportCount: h.count,
    latestDate: h.points[h.points.length - 1]?.date ?? null,
    points: h.points,
    insights: analyseReports(h.points),
  }));

  return NextResponse.json({ inboxToken: source.inbox_token, hotels });
}
