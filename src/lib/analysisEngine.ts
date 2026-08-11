// The hardwired analysis engine.
//
// Fifteen deterministic rules over one night's manager's report plus the
// hotel's own history. No model runs here: the same numbers in always produce
// the same flags out, every threshold is stated on the flag it raised, and a
// rule whose inputs are missing is skipped rather than assumed.
//
// The engine is pure — it reads data and returns flags. Persisting them is the
// caller's job (see src/app/api/ingest-report/route.ts).

export type Severity = "critical" | "warning" | "info" | "positive";

export interface DailyReportData {
  report_date: string; // YYYY-MM-DD
  occupancy_percent?: number | null;
  adr?: number | null;
  revpar?: number | null;
  room_revenue?: number | null;
  total_revenue?: number | null;
  rooms_sold?: number | null;
  rooms_available?: number | null;
  out_of_order?: number | null;
  no_shows?: number | null;
  cancellations?: number | null;
  total_reservations?: number | null;
  comp_rooms?: number | null;
  early_departures?: number | null;
  extended_stays?: number | null;
  walk_ins?: number | null;
  arrivals?: number | null;
  departures?: number | null;
  stayovers?: number | null;
  cash_variance?: number | null;
  total_adjustments?: number | null;
  direct_bill_transfers?: number | null;
}

export interface AnalysisContext {
  /**
   * Mean of today's competitive-set rates, from the rate pipeline. Undefined
   * when the compset has not been priced for this date — rule 13 is then
   * skipped rather than compared against a stand-in.
   */
  compsetAverageAdr?: number | null;
  /** How many compset hotels that average came from, for the flag text. */
  compsetSize?: number | null;
  /** Currency for formatting. */
  currency?: string;
}

export interface InsightFlag {
  flag_type: string;
  message: string;
  severity: Severity;
  metric_key: string | null;
  observed: number | null;
  threshold: number | null;
}

// Thresholds live in one place so a property can be tuned without hunting
// through the rules. Defaults are the industry rules of thumb for a
// limited-service US property.
export interface Thresholds {
  revparDropPct: number;
  adrFloor: number;
  nearSellOutOccupancy: number;
  outOfOrderMax: number;
  noShowRatePct: number;
  compRoomsMax: number;
  earlyDeparturesMax: number;
  extendedStaysMax: number;
  walkInsMin: number;
  adjustmentsMax: number;
  revenueReconciliationTolerance: number;
  compsetHighOccupancy: number;
  weekPacingOccupancy: number;
  directBillMax: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  revparDropPct: 5,
  adrFloor: 100,
  nearSellOutOccupancy: 95,
  outOfOrderMax: 3,
  noShowRatePct: 3,
  compRoomsMax: 5,
  earlyDeparturesMax: 2,
  extendedStaysMax: 3,
  walkInsMin: 5,
  adjustmentsMax: 100,
  revenueReconciliationTolerance: 5,
  compsetHighOccupancy: 90,
  weekPacingOccupancy: 50,
  directBillMax: 500,
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function money(n: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function mean(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** Present and numeric. `0` is a real value, so a plain falsy check will not do. */
function has(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/**
 * Run all fifteen rules.
 *
 * @param current    the night just reported
 * @param historical earlier reports for the same hotel, any order; the engine
 *                   sorts and never includes `current` in its own baselines
 */
export function analyzeDailyReport(
  current: DailyReportData,
  historical: DailyReportData[] = [],
  context: AnalysisContext = {},
  thresholds: Partial<Thresholds> = {}
): InsightFlag[] {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const cur = context.currency ?? "USD";
  const flags: InsightFlag[] = [];

  const history = [...historical]
    .filter((h) => h.report_date < current.report_date)
    .sort((a, b) => a.report_date.localeCompare(b.report_date));
  const previous = history[history.length - 1] ?? null;

  const historyOf = (key: keyof DailyReportData, n = 30): number[] =>
    history
      .slice(-n)
      .map((h) => h[key])
      .filter((v): v is number => has(v as number));

  const push = (f: InsightFlag) => flags.push(f);

  // ── 1. RevPAR delta ─────────────────────────────────────────────────────
  // A RevPAR fall of more than 5% night over night is the single earliest
  // sign that something changed — rate, mix, or inventory.
  if (previous && has(current.revpar) && has(previous.revpar) && previous.revpar > 0) {
    const change = ((current.revpar - previous.revpar) / previous.revpar) * 100;
    if (change <= -t.revparDropPct) {
      push({
        flag_type: "revpar_delta",
        message: `RevPAR fell ${pct(Math.abs(change))} night over night, from ${money(previous.revpar, cur)} on ${previous.report_date} to ${money(current.revpar, cur)}.`,
        severity: change <= -15 ? "critical" : "warning",
        metric_key: "revpar",
        observed: Number(change.toFixed(2)),
        threshold: -t.revparDropPct,
      });
    } else if (change >= t.revparDropPct) {
      push({
        flag_type: "revpar_delta",
        message: `RevPAR rose ${pct(change)} night over night, from ${money(previous.revpar, cur)} to ${money(current.revpar, cur)}.`,
        severity: "positive",
        metric_key: "revpar",
        observed: Number(change.toFixed(2)),
        threshold: t.revparDropPct,
      });
    }
  }

  // ── 2. ADR drop ─────────────────────────────────────────────────────────
  // Compared against the property's own 30-report average once there is
  // enough history for that to mean anything; against the fixed floor before.
  if (has(current.adr)) {
    const adrHistory = historyOf("adr", 30);
    const baseline = adrHistory.length >= 7 ? mean(adrHistory) : null;
    if (baseline != null) {
      const change = ((current.adr - baseline) / baseline) * 100;
      if (change <= -5) {
        push({
          flag_type: "adr_drop",
          message: `ADR of ${money(current.adr, cur)} is ${pct(Math.abs(change))} below the ${money(baseline, cur)} average of the last ${adrHistory.length} reports.`,
          severity: change <= -15 ? "critical" : "warning",
          metric_key: "adr",
          observed: Number(current.adr.toFixed(2)),
          threshold: Number(baseline.toFixed(2)),
        });
      }
    } else if (current.adr < t.adrFloor) {
      push({
        flag_type: "adr_drop",
        message: `ADR of ${money(current.adr, cur)} is below the ${money(t.adrFloor, cur)} floor. Not enough history yet to compare against this property's own average.`,
        severity: "warning",
        metric_key: "adr",
        observed: Number(current.adr.toFixed(2)),
        threshold: t.adrFloor,
      });
    }
  }

  // ── 3. Occupancy threshold ──────────────────────────────────────────────
  if (has(current.occupancy_percent) && current.occupancy_percent > t.nearSellOutOccupancy) {
    push({
      flag_type: "near_sell_out",
      message: `Near Sell-Out (Maximize Rate) — ${pct(current.occupancy_percent)} occupancy${
        has(current.rooms_sold) && has(current.rooms_available)
          ? `, ${current.rooms_sold} of ${current.rooms_available} rooms sold`
          : ""
      }. Last rooms should be held at the highest rate the market will take.`,
      severity: "info",
      metric_key: "occupancy_percent",
      observed: Number(current.occupancy_percent.toFixed(2)),
      threshold: t.nearSellOutOccupancy,
    });
  }

  // ── 4. Out-of-order spike ───────────────────────────────────────────────
  if (has(current.out_of_order) && current.out_of_order > t.outOfOrderMax) {
    const cost = has(current.revpar) ? current.out_of_order * current.revpar : null;
    push({
      flag_type: "out_of_order_spike",
      message: `${current.out_of_order} rooms out of order, above the ${t.outOfOrderMax}-room tolerance${
        cost != null ? `, roughly ${money(cost, cur)} of unsellable capacity at today's RevPAR` : ""
      }.`,
      severity: current.out_of_order > t.outOfOrderMax * 2 ? "critical" : "warning",
      metric_key: "out_of_order",
      observed: current.out_of_order,
      threshold: t.outOfOrderMax,
    });
  }

  // ── 5. No-show rate ─────────────────────────────────────────────────────
  // Rate, not count: 4 no-shows on 30 reservations is a problem, on 300 it is
  // not. Falls back to arrivals + stayovers when the report omits the total.
  {
    const denominator = has(current.total_reservations)
      ? current.total_reservations
      : has(current.arrivals) && has(current.stayovers)
        ? current.arrivals + current.stayovers
        : has(current.rooms_sold) && has(current.no_shows)
          ? current.rooms_sold + current.no_shows
          : null;
    if (has(current.no_shows) && denominator != null && denominator > 0) {
      const rate = (current.no_shows / denominator) * 100;
      if (rate > t.noShowRatePct) {
        const lost = has(current.adr) ? current.no_shows * current.adr : null;
        push({
          flag_type: "no_show_rate",
          message: `${current.no_shows} no-show${current.no_shows === 1 ? "" : "s"} against ${denominator} reservations is ${pct(rate)}, above the ${t.noShowRatePct}% tolerance${
            lost != null ? `, worth ${money(lost, cur)} at today's ADR` : ""
          }. Check guarantee and cancellation policy enforcement.`,
          severity: rate > t.noShowRatePct * 2 ? "critical" : "warning",
          metric_key: "no_shows",
          observed: Number(rate.toFixed(2)),
          threshold: t.noShowRatePct,
        });
      }
    }
  }

  // ── 6. Comp and house-use rooms ─────────────────────────────────────────
  if (has(current.comp_rooms) && current.comp_rooms > t.compRoomsMax) {
    const cost = has(current.adr) ? current.comp_rooms * current.adr : null;
    push({
      flag_type: "comp_rooms",
      message: `${current.comp_rooms} comp or house-use rooms, above the ${t.compRoomsMax}-room tolerance${
        cost != null ? `, ${money(cost, cur)} of rooms given away at today's ADR` : ""
      }. Each should have an authorisation behind it.`,
      severity: "warning",
      metric_key: "comp_rooms",
      observed: current.comp_rooms,
      threshold: t.compRoomsMax,
    });
  }

  // ── 7. Early departures ─────────────────────────────────────────────────
  if (has(current.early_departures) && current.early_departures > t.earlyDeparturesMax) {
    push({
      flag_type: "early_departures",
      message: `${current.early_departures} early departures, above the ${t.earlyDeparturesMax}-guest tolerance. Repeated early check-outs usually trace to a room-quality or service problem rather than to guest plans.`,
      severity: "warning",
      metric_key: "early_departures",
      observed: current.early_departures,
      threshold: t.earlyDeparturesMax,
    });
  }

  // ── 8. Extended stays ───────────────────────────────────────────────────
  // Only fires when the report actually carries the field; most do not.
  if (has(current.extended_stays) && current.extended_stays > t.extendedStaysMax) {
    const value = has(current.adr) ? current.extended_stays * current.adr : null;
    push({
      flag_type: "extended_stays",
      message: `${current.extended_stays} stays extended${
        value != null ? `, ${money(value, cur)} of unplanned room nights at today's ADR` : ""
      }. Confirm the extensions were repriced rather than carried at the original rate.`,
      severity: "info",
      metric_key: "extended_stays",
      observed: current.extended_stays,
      threshold: t.extendedStaysMax,
    });
  }

  // ── 9. Cash variance ────────────────────────────────────────────────────
  // Any non-zero variance is worth naming — small ones are the pattern that
  // precedes large ones.
  if (has(current.cash_variance) && Math.abs(current.cash_variance) >= 0.01) {
    const over = current.cash_variance > 0;
    push({
      flag_type: "cash_variance",
      message: `Cash drawer ${over ? "over" : "short"} by ${money(Math.abs(current.cash_variance), cur)}. Any variance should be signed off by the manager on duty the same day.`,
      severity: Math.abs(current.cash_variance) >= 50 ? "critical" : "warning",
      metric_key: "cash_variance",
      observed: Number(current.cash_variance.toFixed(2)),
      threshold: 0,
    });
  }

  // ── 10. Walk-in volume ──────────────────────────────────────────────────
  if (has(current.walk_ins) && current.walk_ins > t.walkInsMin) {
    const share =
      has(current.arrivals) && current.arrivals > 0
        ? (current.walk_ins / current.arrivals) * 100
        : null;
    push({
      flag_type: "walk_in_volume",
      message: `High Walk-in Demand - Check Rate — ${current.walk_ins} walk-ins${
        share != null ? `, ${pct(share)} of the day's arrivals` : ""
      }. Unbooked demand at the door usually means the online rate was left below what the market would pay.`,
      severity: "info",
      metric_key: "walk_ins",
      observed: current.walk_ins,
      threshold: t.walkInsMin,
    });
  }

  // ── 11. Refunds and adjustments ─────────────────────────────────────────
  if (has(current.total_adjustments) && Math.abs(current.total_adjustments) > t.adjustmentsMax) {
    const amount = Math.abs(current.total_adjustments);
    const shareOfRevenue =
      has(current.room_revenue) && current.room_revenue > 0
        ? (amount / current.room_revenue) * 100
        : null;
    push({
      flag_type: "adjustments",
      message: `${money(amount, cur)} in adjustments, allowances or refunds${
        shareOfRevenue != null ? `, ${pct(shareOfRevenue)} of room revenue` : ""
      }, above the ${money(t.adjustmentsMax, cur)} threshold. Each should carry a reason code.`,
      severity: shareOfRevenue != null && shareOfRevenue > 5 ? "critical" : "warning",
      metric_key: "total_adjustments",
      observed: Number(amount.toFixed(2)),
      threshold: t.adjustmentsMax,
    });
  }

  // ── 12. Room revenue reconciliation ─────────────────────────────────────
  // ADR × rooms sold should equal room revenue. When it does not, one of the
  // three is wrong — either the audit or the extraction — and every rule
  // downstream of them is unreliable for the night.
  if (has(current.adr) && has(current.rooms_sold) && has(current.room_revenue)) {
    const expected = current.adr * current.rooms_sold;
    const gap = current.room_revenue - expected;
    if (Math.abs(gap) > t.revenueReconciliationTolerance) {
      push({
        flag_type: "revenue_reconciliation",
        message: `Room revenue does not reconcile: ${money(current.adr, cur)} ADR × ${current.rooms_sold} rooms sold is ${money(expected, cur)}, but the report shows ${money(current.room_revenue, cur)} — a gap of ${money(Math.abs(gap), cur)}. Comp rooms, packages or a rounded ADR explain small gaps; a large one means the figures should not be trusted for the night.`,
        severity: Math.abs(gap) > expected * 0.02 ? "critical" : "warning",
        metric_key: "room_revenue",
        observed: Number(gap.toFixed(2)),
        threshold: t.revenueReconciliationTolerance,
      });
    }
  }

  // ── 13. Compset position ────────────────────────────────────────────────
  // Uses the real compset average from the rate pipeline. When the compset has
  // not been priced for this date the rule is skipped — comparing against a
  // placeholder would put a number on the dashboard that came from nowhere.
  if (
    has(current.adr) &&
    has(current.occupancy_percent) &&
    context.compsetAverageAdr != null &&
    Number.isFinite(context.compsetAverageAdr)
  ) {
    const compAvg = context.compsetAverageAdr;
    if (current.adr < compAvg && current.occupancy_percent > t.compsetHighOccupancy) {
      const gap = compAvg - current.adr;
      const upside = has(current.rooms_sold) ? gap * current.rooms_sold : null;
      push({
        flag_type: "compset_underpriced",
        message: `Underpriced against the compset: ${money(current.adr, cur)} ADR at ${pct(current.occupancy_percent)} occupancy, while the ${context.compsetSize ?? "tracked"} competitors averaged ${money(compAvg, cur)}${
          upside != null ? `. Closing the ${money(gap, cur)} gap on ${current.rooms_sold} rooms is ${money(upside, cur)}` : ""
        }. Selling out below the market is rate left on the table, not a win.`,
        severity: "warning",
        metric_key: "adr",
        observed: Number(current.adr.toFixed(2)),
        threshold: Number(compAvg.toFixed(2)),
      });
    }
  }

  // ── 14. Weekday pacing ──────────────────────────────────────────────────
  // A soft weekday against that weekday's own history, not against the week as
  // a whole — a 45% Sunday is normal, a 45% Thursday at a corporate property
  // is not.
  if (has(current.occupancy_percent) && current.occupancy_percent < t.weekPacingOccupancy) {
    const day = weekdayOf(current.report_date);
    const sameDay = history
      .filter((h) => weekdayOf(h.report_date) === day && has(h.occupancy_percent))
      .map((h) => h.occupancy_percent as number);
    const dayAverage = sameDay.length >= 3 ? mean(sameDay) : null;
    const isBusinessNight = day >= 1 && day <= 4; // Mon–Thu
    if (dayAverage != null) {
      if (current.occupancy_percent < dayAverage - 10) {
        push({
          flag_type: "pacing_weakness",
          message: `${WEEKDAYS[day]} occupancy of ${pct(current.occupancy_percent)} is well under the ${pct(dayAverage)} this property normally runs on a ${WEEKDAYS[day]} across ${sameDay.length} reports. Check the booking window for the next few ${WEEKDAYS[day]}s.`,
          severity: "warning",
          metric_key: "occupancy_percent",
          observed: Number(current.occupancy_percent.toFixed(2)),
          threshold: Number(dayAverage.toFixed(2)),
        });
      }
    } else if (isBusinessNight) {
      push({
        flag_type: "pacing_weakness",
        message: `${WEEKDAYS[day]} occupancy of ${pct(current.occupancy_percent)} is below ${t.weekPacingOccupancy}% on a midweek night. Not enough ${WEEKDAYS[day]} history yet to say whether that is normal for this property.`,
        severity: "info",
        metric_key: "occupancy_percent",
        observed: Number(current.occupancy_percent.toFixed(2)),
        threshold: t.weekPacingOccupancy,
      });
    }
  }

  // ── 15. Direct bill / city ledger ───────────────────────────────────────
  if (has(current.direct_bill_transfers) && current.direct_bill_transfers > t.directBillMax) {
    const share =
      has(current.room_revenue) && current.room_revenue > 0
        ? (current.direct_bill_transfers / current.room_revenue) * 100
        : null;
    push({
      flag_type: "direct_bill",
      message: `${money(current.direct_bill_transfers, cur)} transferred to direct bill / city ledger${
        share != null ? `, ${pct(share)} of room revenue` : ""
      }, above the ${money(t.directBillMax, cur)} threshold. Revenue booked today but not collected today — confirm the accounts are current before more is extended.`,
      severity: share != null && share > 25 ? "warning" : "info",
      metric_key: "direct_bill_transfers",
      observed: Number(current.direct_bill_transfers.toFixed(2)),
      threshold: t.directBillMax,
    });
  }

  return flags;
}

/**
 * Fill in what the report implied but did not print. Kept separate from
 * extraction so a derived figure is always distinguishable from a reported
 * one, and separate from the rules so every rule sees the same inputs.
 */
export function deriveMetrics<T extends DailyReportData>(row: T): T {
  const out = { ...row };
  if (!has(out.occupancy_percent) && has(out.rooms_sold) && has(out.rooms_available) && out.rooms_available > 0) {
    out.occupancy_percent = (out.rooms_sold / out.rooms_available) * 100;
  }
  if (!has(out.adr) && has(out.room_revenue) && has(out.rooms_sold) && out.rooms_sold > 0) {
    out.adr = out.room_revenue / out.rooms_sold;
  }
  if (!has(out.revpar) && has(out.room_revenue) && has(out.rooms_available) && out.rooms_available > 0) {
    out.revpar = out.room_revenue / out.rooms_available;
  }
  if (!has(out.revpar) && has(out.adr) && has(out.occupancy_percent)) {
    out.revpar = out.adr * (out.occupancy_percent / 100);
  }
  if (!has(out.rooms_sold) && has(out.occupancy_percent) && has(out.rooms_available)) {
    out.rooms_sold = Math.round((out.occupancy_percent / 100) * out.rooms_available);
  }
  return out;
}

export const RULE_COUNT = 15;
