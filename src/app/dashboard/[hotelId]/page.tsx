// Server-rendered manager's-report view for one hotel.
//
// Reads straight from Supabase on the server with the service-role key — no
// Supabase credentials reach the browser, and there is no client-side fetch
// waterfall before the numbers appear. Everything on this page comes from a
// report the pipeline actually ingested; a metric the report did not carry
// renders as "not reported" rather than as a zero.

import Link from "next/link";
import { db } from "@/lib/db";
import { DAILY_METRIC_COLUMNS } from "@/lib/daily-reports";
import type { Severity } from "@/lib/analysisEngine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface DailyRow {
  id: number;
  report_date: string;
  occupancy_percent: number | null;
  adr: number | null;
  revpar: number | null;
  room_revenue: number | null;
  total_revenue: number | null;
  rooms_sold: number | null;
  rooms_available: number | null;
  out_of_order: number | null;
  no_shows: number | null;
  cancellations: number | null;
  total_reservations: number | null;
  comp_rooms: number | null;
  early_departures: number | null;
  extended_stays: number | null;
  walk_ins: number | null;
  arrivals: number | null;
  departures: number | null;
  stayovers: number | null;
  cash_variance: number | null;
  total_adjustments: number | null;
  direct_bill_transfers: number | null;
  extractor: string;
  extractor_model: string | null;
  confidence: number | null;
  source: string;
}

interface InsightRow {
  id: number;
  flag_type: string;
  message: string;
  severity: Severity;
  metric_key: string | null;
  observed: number | null;
  threshold: number | null;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  positive: 3,
};

const SEVERITY_STYLE: Record<Severity, { label: string; color: string; tint: string }> = {
  critical: { label: "Critical", color: "var(--status-critical)", tint: "color-mix(in srgb, var(--status-critical) 8%, transparent)" },
  warning: { label: "Warning", color: "var(--status-warning)", tint: "color-mix(in srgb, var(--status-warning) 8%, transparent)" },
  info: { label: "Note", color: "var(--accent)", tint: "color-mix(in srgb, var(--accent) 7%, transparent)" },
  positive: { label: "Positive", color: "var(--status-good)", tint: "color-mix(in srgb, var(--status-good) 8%, transparent)" },
};

function money(n: number | null, currency = "USD"): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

function percent(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}

function count(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function HotelReportPage({
  params,
}: {
  params: Promise<{ hotelId: string }>;
}) {
  const { hotelId: rawHotelId } = await params;
  const hotelId = decodeURIComponent(rawHotelId);
  const supa = db();

  const { data: hotel } = await supa
    .from("hotels")
    .select("hotel_id, name, pms_type")
    .eq("hotel_id", hotelId)
    .maybeSingle<{ hotel_id: string; name: string; pms_type: string | null }>();

  const { data: rows } = await supa
    .from("daily_manager_reports")
    .select(
      `id, report_date, extractor, extractor_model, confidence, source, ${DAILY_METRIC_COLUMNS.join(", ")}`
    )
    .eq("hotel_id", hotelId)
    .order("report_date", { ascending: false })
    .limit(30)
    .returns<DailyRow[]>();

  const history = rows ?? [];
  const latest = history[0] ?? null;
  const previous = history[1] ?? null;

  const { data: insightRows } = latest
    ? await supa
        .from("daily_insights")
        .select("id, flag_type, message, severity, metric_key, observed, threshold")
        .eq("report_id", latest.id)
        .returns<InsightRow[]>()
    : { data: [] as InsightRow[] };

  const insights = [...(insightRows ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );

  const title = hotel?.name ?? hotelId;

  if (!latest) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-14">
        <Header title={title} pmsType={hotel?.pms_type ?? null} subtitle="No reports yet" />
        <div
          className="rounded-xl border p-8 text-sm"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface)",
            color: "var(--text-secondary)",
          }}
        >
          <p className="mb-3">
            No manager&rsquo;s report has been ingested for this hotel yet.
          </p>
          <p>
            Point the property&rsquo;s night-audit email at its alias on the reports domain, or
            upload a report from the dashboard. The first report populates this page; the
            night-over-night rules need a second one.
          </p>
        </div>
      </main>
    );
  }

  const delta = (key: keyof DailyRow): number | null => {
    const a = latest[key];
    const b = previous?.[key];
    if (typeof a !== "number" || typeof b !== "number" || b === 0) return null;
    return ((a - b) / b) * 100;
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      <Header
        title={title}
        pmsType={hotel?.pms_type ?? null}
        subtitle={longDate(latest.report_date)}
      />

      {/* ── KPIs ───────────────────────────────────────────────────────── */}
      <section aria-label="Key performance indicators" className="mb-10">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Kpi
            label="Occupancy"
            value={percent(latest.occupancy_percent)}
            delta={delta("occupancy_percent")}
            footnote={
              latest.rooms_sold != null && latest.rooms_available != null
                ? `${latest.rooms_sold} of ${latest.rooms_available} rooms sold`
                : undefined
            }
          />
          <Kpi label="ADR" value={money(latest.adr)} delta={delta("adr")} footnote="Average daily rate" />
          <Kpi
            label="RevPAR"
            value={money(latest.revpar)}
            delta={delta("revpar")}
            footnote="Revenue per available room"
          />
        </div>
      </section>

      {/* ── Insights ───────────────────────────────────────────────────── */}
      <section aria-label="Daily insights" className="mb-10">
        <SectionHeading
          title="Daily Insights &amp; Manager&rsquo;s Report Analysis"
          note={`${insights.length} of 15 checks flagged for ${latest.report_date}`}
        />
        {insights.length === 0 ? (
          <div
            className="rounded-xl border p-6 text-sm"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface)",
              color: "var(--text-secondary)",
            }}
          >
            All fifteen checks passed, or their inputs were not present on this report. Nothing
            needs attention from the numbers alone.
          </div>
        ) : (
          <ul className="space-y-3">
            {insights.map((flag) => {
              const style = SEVERITY_STYLE[flag.severity] ?? SEVERITY_STYLE.info;
              return (
                <li
                  key={flag.id}
                  className="rounded-xl border p-4 sm:p-5"
                  style={{
                    borderColor: "var(--border)",
                    background: style.tint,
                    borderLeft: `3px solid ${style.color}`,
                  }}
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span
                      className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                      style={{ color: style.color }}
                    >
                      {style.label}
                    </span>
                    <span
                      className="text-[11px] uppercase tracking-[0.08em]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {flag.flag_type.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: "var(--text-primary)" }}>
                    {flag.message}
                  </p>
                  {flag.observed != null && flag.threshold != null && (
                    <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                      Observed {flag.observed} against a threshold of {flag.threshold}
                      {flag.metric_key ? ` on ${flag.metric_key.replace(/_/g, " ")}` : ""}.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Full report detail ─────────────────────────────────────────── */}
      <section aria-label="Reported figures" className="mb-10">
        <SectionHeading title="Reported figures" note="Straight from the night audit" />
        <div
          className="overflow-x-auto rounded-xl border"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          <table className="w-full min-w-[520px] text-sm">
            <tbody>
              {(
                [
                  ["Room revenue", money(latest.room_revenue)],
                  ["Total revenue", money(latest.total_revenue)],
                  ["Rooms sold", count(latest.rooms_sold)],
                  ["Rooms available", count(latest.rooms_available)],
                  ["Arrivals", count(latest.arrivals)],
                  ["Departures", count(latest.departures)],
                  ["Stayovers", count(latest.stayovers)],
                  ["Walk-ins", count(latest.walk_ins)],
                  ["No-shows", count(latest.no_shows)],
                  ["Cancellations", count(latest.cancellations)],
                  ["Early departures", count(latest.early_departures)],
                  ["Extended stays", count(latest.extended_stays)],
                  ["Comp / house use", count(latest.comp_rooms)],
                  ["Out of order", count(latest.out_of_order)],
                  ["Cash over / short", money(latest.cash_variance)],
                  ["Adjustments", money(latest.total_adjustments)],
                  ["Direct bill transfers", money(latest.direct_bill_transfers)],
                ] as const
              ).map(([label, value], i) => (
                <tr
                  key={label}
                  style={{ borderTop: i === 0 ? "none" : "1px solid var(--gridline)" }}
                >
                  <th
                    scope="row"
                    className="px-5 py-2.5 text-left font-normal"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {label}
                  </th>
                  <td
                    className="px-5 py-2.5 text-right tabular-nums"
                    style={{ color: value === "—" ? "var(--text-muted)" : "var(--text-primary)" }}
                  >
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
          A dash means the report did not carry that figure. Extracted by {latest.extractor}
          {latest.extractor_model ? ` (${latest.extractor_model})` : ""} from {latest.source}
          {latest.confidence != null
            ? `, extraction confidence ${(latest.confidence * 100).toFixed(0)}%`
            : ""}
          .
        </p>
      </section>

      {/* ── Recent history ─────────────────────────────────────────────── */}
      {history.length > 1 && (
        <section aria-label="Recent reports">
          <SectionHeading
            title="Recent reports"
            note={`Last ${history.length} nights held for this hotel`}
          />
          <div
            className="overflow-x-auto rounded-xl border"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Date", "Occupancy", "ADR", "RevPAR", "Room revenue"].map((h, i) => (
                    <th
                      key={h}
                      className={`px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] ${
                        i === 0 ? "text-left" : "text-right"
                      }`}
                      style={{ color: "var(--text-muted)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} style={{ borderTop: "1px solid var(--gridline)" }}>
                    <td className="px-5 py-2.5" style={{ color: "var(--text-primary)" }}>
                      {row.report_date}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                      {percent(row.occupancy_percent)}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                      {money(row.adr)}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                      {money(row.revpar)}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                      {money(row.room_revenue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

// ── Presentational pieces ─────────────────────────────────────────────────

function Header({
  title,
  subtitle,
  pmsType,
}: {
  title: string;
  subtitle: string;
  pmsType: string | null;
}) {
  return (
    <header className="mb-9">
      <Link
        href="/"
        className="text-xs uppercase tracking-[0.1em] no-underline"
        style={{ color: "var(--text-muted)" }}
      >
        Rate Beacon
      </Link>
      <h1
        className="mt-2 text-3xl font-semibold tracking-tight"
        style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
      >
        {title}
      </h1>
      <p className="mt-1.5 text-sm" style={{ color: "var(--text-secondary)" }}>
        {subtitle}
        {pmsType ? ` · ${pmsType.toUpperCase()} report` : ""}
      </p>
    </header>
  );
}

function SectionHeading({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-2">
      <h2
        className="text-base font-semibold tracking-tight"
        style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
        dangerouslySetInnerHTML={{ __html: title }}
      />
      {note && (
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {note}
        </span>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  delta,
  footnote,
}: {
  label: string;
  value: string;
  delta: number | null;
  footnote?: string;
}) {
  const up = delta != null && delta >= 0;
  return (
    <div
      className="rounded-xl border p-5"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface)",
        boxShadow: "var(--shadow-xs)",
      }}
    >
      <p
        className="text-[11px] font-semibold uppercase tracking-[0.1em]"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </p>
      <p
        className="mt-2 text-3xl font-semibold tabular-nums tracking-tight"
        style={{ color: "var(--text-primary)" }}
      >
        {value}
      </p>
      <div className="mt-2 flex items-baseline gap-2 text-xs">
        {delta != null && (
          <span
            className="tabular-nums font-medium"
            style={{ color: up ? "var(--status-good)" : "var(--status-critical)" }}
          >
            {up ? "+" : ""}
            {delta.toFixed(1)}% vs previous
          </span>
        )}
        {footnote && <span style={{ color: "var(--text-muted)" }}>{footnote}</span>}
      </div>
    </div>
  );
}
