// Fixed analyses over a hotel's manager's-report history. Each one is a
// deterministic calculation over stored metrics — no interpretation beyond
// what the arithmetic supports, and each states the numbers it used so a
// reader can check it.

import type { MetricKey } from "./reports";

export interface ReportPoint {
  date: string;
  metrics: Partial<Record<MetricKey, number>>;
}

export type Direction = "good" | "bad" | "neutral";

export interface Insight {
  id: string;
  title: string;
  value: string;
  detail: string;
  direction: Direction;
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

function mean(v: number[]): number | null {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function series(points: ReportPoint[], key: MetricKey): { date: string; value: number }[] {
  return points
    .filter((p) => p.metrics[key] != null)
    .map((p) => ({ date: p.date, value: p.metrics[key] as number }));
}

function lastN(points: ReportPoint[], key: MetricKey, n: number): number[] {
  return series(points, key).slice(-n).map((s) => s.value);
}

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

// `points` must be sorted oldest → newest.
export function analyseReports(points: ReportPoint[]): Insight[] {
  const out: Insight[] = [];
  if (points.length === 0) return out;
  const latest = points[points.length - 1];
  const prior = points.length > 1 ? points[points.length - 2] : null;

  // 1. Occupancy, latest night
  const occ = latest.metrics.occupancy;
  if (occ != null) {
    out.push({
      id: "occupancy",
      title: "Occupancy",
      value: `${occ.toFixed(1)}%`,
      detail:
        latest.metrics.rooms_sold != null && latest.metrics.rooms_available != null
          ? `${latest.metrics.rooms_sold} of ${latest.metrics.rooms_available} rooms sold on ${latest.date}.`
          : `Reported for ${latest.date}.`,
      direction: occ >= 70 ? "good" : occ >= 50 ? "neutral" : "bad",
    });
  }

  // 2. ADR, latest
  const adr = latest.metrics.adr;
  if (adr != null) {
    const adr30 = mean(lastN(points, "adr", 30));
    out.push({
      id: "adr",
      title: "ADR",
      value: money(adr),
      detail:
        adr30 != null
          ? `${pct(((adr - adr30) / adr30) * 100)} against the ${money(adr30)} average of the last ${Math.min(points.length, 30)} reports.`
          : `Average daily rate on ${latest.date}.`,
      direction: adr30 == null ? "neutral" : adr >= adr30 ? "good" : "bad",
    });
  }

  // 3. RevPAR, latest
  const revpar = latest.metrics.revpar;
  if (revpar != null) {
    const rp30 = mean(lastN(points, "revpar", 30));
    out.push({
      id: "revpar",
      title: "RevPAR",
      value: money(revpar),
      detail:
        rp30 != null
          ? `${pct(((revpar - rp30) / rp30) * 100)} against the ${money(rp30)} running average.`
          : "Revenue per available room.",
      direction: rp30 == null ? "neutral" : revpar >= rp30 ? "good" : "bad",
    });
  }

  // 4. Night-over-night RevPAR move
  if (prior && latest.metrics.revpar != null && prior.metrics.revpar != null && prior.metrics.revpar > 0) {
    const change = ((latest.metrics.revpar - prior.metrics.revpar) / prior.metrics.revpar) * 100;
    out.push({
      id: "revpar_dod",
      title: "RevPAR vs previous report",
      value: pct(change),
      detail: `${money(prior.metrics.revpar)} on ${prior.date} → ${money(latest.metrics.revpar)} on ${latest.date}.`,
      direction: change >= 0 ? "good" : "bad",
    });
  }

  // 5. Rate vs volume: which side moved RevPAR
  if (prior && latest.metrics.adr != null && prior.metrics.adr != null && latest.metrics.occupancy != null && prior.metrics.occupancy != null) {
    const adrMove = latest.metrics.adr - prior.metrics.adr;
    const occMove = latest.metrics.occupancy - prior.metrics.occupancy;
    const driver =
      Math.abs(adrMove / (prior.metrics.adr || 1)) >= Math.abs(occMove / (prior.metrics.occupancy || 1))
        ? "rate"
        : "occupancy";
    out.push({
      id: "driver",
      title: "What moved the needle",
      value: driver === "rate" ? "Rate" : "Occupancy",
      detail: `ADR ${adrMove >= 0 ? "+" : ""}${money(adrMove)}, occupancy ${occMove >= 0 ? "+" : ""}${occMove.toFixed(1)} points since the previous report.`,
      direction: "neutral",
    });
  }

  // 6. Seven-report trend in occupancy
  const occ7 = lastN(points, "occupancy", 7);
  const occPrev7 = series(points, "occupancy").slice(-14, -7).map((s) => s.value);
  if (occ7.length >= 3 && occPrev7.length >= 3) {
    const a = mean(occ7)!;
    const b = mean(occPrev7)!;
    out.push({
      id: "occ_trend",
      title: "Occupancy trend",
      value: `${(a - b >= 0 ? "+" : "")}${(a - b).toFixed(1)} pts`,
      detail: `Last ${occ7.length} reports averaged ${a.toFixed(1)}%, the ${occPrev7.length} before that ${b.toFixed(1)}%.`,
      direction: a >= b ? "good" : "bad",
    });
  }

  // 7. Best and worst weekday by RevPAR
  const rpAll = series(points, "revpar");
  if (rpAll.length >= 7) {
    const byDay = new Map<number, number[]>();
    for (const s of rpAll) {
      const d = weekdayOf(s.date);
      byDay.set(d, [...(byDay.get(d) ?? []), s.value]);
    }
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const avgs = [...byDay.entries()]
      .map(([d, vals]) => ({ d, avg: mean(vals)! }))
      .sort((x, y) => y.avg - x.avg);
    if (avgs.length >= 2) {
      out.push({
        id: "weekday",
        title: "Strongest weekday",
        value: names[avgs[0].d],
        detail: `${names[avgs[0].d]} averages ${money(avgs[0].avg)} RevPAR; ${names[avgs[avgs.length - 1].d]} is weakest at ${money(avgs[avgs.length - 1].avg)}.`,
        direction: "neutral",
      });
    }
  }

  // 8. No-shows and cancellations as lost room-nights
  const ns = latest.metrics.no_shows ?? 0;
  const cx = latest.metrics.cancellations ?? 0;
  if (latest.metrics.no_shows != null || latest.metrics.cancellations != null) {
    const lost = ns + cx;
    const value = latest.metrics.adr != null ? money(lost * latest.metrics.adr) : `${lost} rooms`;
    out.push({
      id: "attrition",
      title: "Lost to no-shows and cancellations",
      value,
      detail: `${ns} no-show${ns === 1 ? "" : "s"} and ${cx} cancellation${cx === 1 ? "" : "s"} on ${latest.date}${latest.metrics.adr != null ? `, valued at the ${money(latest.metrics.adr)} ADR` : ""}.`,
      direction: lost === 0 ? "good" : lost >= 5 ? "bad" : "neutral",
    });
  }

  // 9. Out-of-order rooms as lost capacity
  if (latest.metrics.out_of_order != null && latest.metrics.out_of_order > 0) {
    const ooo = latest.metrics.out_of_order;
    const cost = latest.metrics.revpar != null ? money(ooo * latest.metrics.revpar) : null;
    out.push({
      id: "ooo",
      title: "Out-of-order rooms",
      value: `${ooo}`,
      detail: cost
        ? `Roughly ${cost} of unrealised revenue at the current RevPAR.`
        : `Rooms unavailable to sell on ${latest.date}.`,
      direction: ooo >= 3 ? "bad" : "neutral",
    });
  }

  // 10. Walk-ins as a share of arrivals
  if (latest.metrics.walk_ins != null && latest.metrics.arrivals) {
    const share = (latest.metrics.walk_ins / latest.metrics.arrivals) * 100;
    out.push({
      id: "walkins",
      title: "Walk-in share of arrivals",
      value: `${share.toFixed(0)}%`,
      detail: `${latest.metrics.walk_ins} of ${latest.metrics.arrivals} arrivals walked in — unbooked demand the rate strategy did not capture in advance.`,
      direction: "neutral",
    });
  }

  // 11. Turnover pressure: arrivals + departures against rooms
  if (latest.metrics.arrivals != null && latest.metrics.departures != null && latest.metrics.rooms_available) {
    const churn = ((latest.metrics.arrivals + latest.metrics.departures) / latest.metrics.rooms_available) * 100;
    out.push({
      id: "turnover",
      title: "Turnover pressure",
      value: `${churn.toFixed(0)}%`,
      detail: `${latest.metrics.arrivals} in and ${latest.metrics.departures} out against ${latest.metrics.rooms_available} rooms — the housekeeping and front-desk load for the day.`,
      direction: churn >= 90 ? "bad" : "neutral",
    });
  }

  // 12. Non-room revenue share
  if (latest.metrics.total_revenue && latest.metrics.room_revenue != null) {
    const other = latest.metrics.total_revenue - latest.metrics.room_revenue;
    const share = (other / latest.metrics.total_revenue) * 100;
    out.push({
      id: "ancillary",
      title: "Non-room revenue",
      value: `${share.toFixed(0)}%`,
      detail: `${money(other)} of ${money(latest.metrics.total_revenue)} came from outside the rooms ledger.`,
      direction: "neutral",
    });
  }

  // 13. Best and worst nights on record
  if (rpAll.length >= 3) {
    const sorted = [...rpAll].sort((a, b) => b.value - a.value);
    out.push({
      id: "records",
      title: "Best night on record",
      value: money(sorted[0].value),
      detail: `${sorted[0].date} is the strongest RevPAR of the ${rpAll.length} reports held; the weakest is ${money(sorted[sorted.length - 1].value)} on ${sorted[sorted.length - 1].date}.`,
      direction: "neutral",
    });
  }

  // 14. Period-to-date revenue
  const revSeries = series(points, "room_revenue");
  if (revSeries.length >= 2) {
    const month = latest.date.slice(0, 7);
    const inMonth = revSeries.filter((s) => s.date.startsWith(month));
    if (inMonth.length >= 2) {
      const total = inMonth.reduce((a, b) => a + b.value, 0);
      out.push({
        id: "mtd",
        title: "Room revenue, month to date",
        value: money(total),
        detail: `Across ${inMonth.length} reported day${inMonth.length === 1 ? "" : "s"} in ${month}, averaging ${money(total / inMonth.length)} a day.`,
        direction: "neutral",
      });
    }
  }

  // 15. Coverage caveat, so a thin history is never read as a full picture
  out.push({
    id: "coverage",
    title: "Reports held",
    value: `${points.length}`,
    detail:
      points.length < 7
        ? `Only ${points.length} report${points.length === 1 ? "" : "s"} so far — trends need about a week before they mean much.`
        : `Covering ${points[0].date} to ${latest.date}.`,
    direction: points.length < 7 ? "neutral" : "good",
  });

  return out;
}
