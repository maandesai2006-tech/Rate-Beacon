// Exercises all fifteen rules against constructed reports, so a change to a
// threshold or a rule shows up as a failing assertion rather than as a silent
// change in what the dashboard flags.
//
//   node scripts/test-analysis-engine.mjs
//
// Runs the TypeScript source directly through Node's type stripping (Node 22.6+
// with --experimental-strip-types, or Node 23+ where it is on by default).

import { analyzeDailyReport, deriveMetrics } from "../src/lib/analysisEngine.ts";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function typesOf(flags) {
  return flags.map((f) => f.flag_type);
}

// A quiet, healthy night used as the baseline for the single-rule tests.
const baseline = {
  report_date: "2026-08-05", // Wednesday
  occupancy_percent: 78,
  adr: 128,
  revpar: 99.84,
  room_revenue: 9984,
  rooms_sold: 78,
  rooms_available: 100,
  out_of_order: 1,
  no_shows: 1,
  total_reservations: 80,
  comp_rooms: 1,
  early_departures: 0,
  walk_ins: 2,
  arrivals: 30,
  cash_variance: 0,
  total_adjustments: 25,
};

// Thirty prior nights so the history-dependent rules have something to stand on.
const history = Array.from({ length: 30 }, (_, i) => {
  const day = String(i + 1).padStart(2, "0");
  return {
    report_date: `2026-07-${day}`,
    occupancy_percent: 76,
    adr: 130,
    revpar: 98.8,
    room_revenue: 9880,
    rooms_sold: 76,
    rooms_available: 100,
  };
});

console.log("\nQuiet night raises nothing unexpected");
{
  const flags = analyzeDailyReport(baseline, history);
  check("no flags on a healthy night", flags.length === 0, typesOf(flags).join(", "));
}

console.log("\n1. RevPAR delta");
{
  const flags = analyzeDailyReport(
    { ...baseline, revpar: 60, room_revenue: 6000, adr: 100, rooms_sold: 60, occupancy_percent: 60 },
    [{ ...baseline, report_date: "2026-08-04", revpar: 100 }]
  );
  check("fires on a >5% night-over-night fall", typesOf(flags).includes("revpar_delta"));
}
{
  const flags = analyzeDailyReport({ ...baseline, revpar: 130 }, [
    { ...baseline, report_date: "2026-08-04", revpar: 100 },
  ]);
  const f = flags.find((x) => x.flag_type === "revpar_delta");
  check("marks a rise as positive", f?.severity === "positive");
}

console.log("\n2. ADR drop");
{
  const flags = analyzeDailyReport({ ...baseline, adr: 95 }, history);
  const f = flags.find((x) => x.flag_type === "adr_drop");
  check("fires against the property's own average", Boolean(f));
  check("cites the historical baseline, not the fixed floor", f?.threshold === 130);
}
{
  const flags = analyzeDailyReport({ ...baseline, adr: 80 }, []);
  const f = flags.find((x) => x.flag_type === "adr_drop");
  check("falls back to the $100 floor with no history", f?.threshold === 100);
}

console.log("\n3. Occupancy threshold");
{
  const flags = analyzeDailyReport({ ...baseline, occupancy_percent: 97 }, history);
  const f = flags.find((x) => x.flag_type === "near_sell_out");
  check("fires above 95%", Boolean(f));
  check("uses the required wording", f?.message.includes("Near Sell-Out (Maximize Rate)"));
}

console.log("\n4. Out-of-order spike");
{
  const flags = analyzeDailyReport({ ...baseline, out_of_order: 4 }, history);
  check("fires above 3 rooms", typesOf(flags).includes("out_of_order_spike"));
  const quiet = analyzeDailyReport({ ...baseline, out_of_order: 3 }, history);
  check("does not fire at exactly 3", !typesOf(quiet).includes("out_of_order_spike"));
}

console.log("\n5. No-show rate");
{
  const flags = analyzeDailyReport({ ...baseline, no_shows: 4, total_reservations: 80 }, history);
  check("fires above 3% of reservations", typesOf(flags).includes("no_show_rate"));
  const quiet = analyzeDailyReport({ ...baseline, no_shows: 4, total_reservations: 400 }, history);
  check("is a rate, not a count", !typesOf(quiet).includes("no_show_rate"));
}

console.log("\n6. Comp / house use");
{
  const flags = analyzeDailyReport({ ...baseline, comp_rooms: 6 }, history);
  check("fires above 5 comp rooms", typesOf(flags).includes("comp_rooms"));
}

console.log("\n7. Early departures");
{
  const flags = analyzeDailyReport({ ...baseline, early_departures: 3 }, history);
  check("fires above 2", typesOf(flags).includes("early_departures"));
}

console.log("\n8. Extended stays");
{
  const flags = analyzeDailyReport({ ...baseline, extended_stays: 5 }, history);
  check("fires when the report carries the field", typesOf(flags).includes("extended_stays"));
  const quiet = analyzeDailyReport(baseline, history);
  check("is skipped when the field is absent", !typesOf(quiet).includes("extended_stays"));
}

console.log("\n9. Cash variance");
{
  const short = analyzeDailyReport({ ...baseline, cash_variance: -20 }, history);
  const f = short.find((x) => x.flag_type === "cash_variance");
  check("fires on any non-zero variance", Boolean(f));
  check("reads a negative as short", f?.message.includes("short"));
  const over = analyzeDailyReport({ ...baseline, cash_variance: 12 }, history);
  check("reads a positive as over", over.find((x) => x.flag_type === "cash_variance")?.message.includes("over"));
  const quiet = analyzeDailyReport({ ...baseline, cash_variance: 0 }, history);
  check("stays quiet at exactly zero", !typesOf(quiet).includes("cash_variance"));
}

console.log("\n10. Walk-in volume");
{
  const flags = analyzeDailyReport({ ...baseline, walk_ins: 6 }, history);
  const f = flags.find((x) => x.flag_type === "walk_in_volume");
  check("fires above 5 walk-ins", Boolean(f));
  check("uses the required wording", f?.message.includes("High Walk-in Demand - Check Rate"));
}

console.log("\n11. Refunds and adjustments");
{
  const flags = analyzeDailyReport({ ...baseline, total_adjustments: 250 }, history);
  check("fires above $100", typesOf(flags).includes("adjustments"));
}

console.log("\n12. Room revenue reconciliation");
{
  const flags = analyzeDailyReport(
    { ...baseline, adr: 128, rooms_sold: 78, room_revenue: 9000 },
    history
  );
  check("fires when ADR × rooms sold misses room revenue", typesOf(flags).includes("revenue_reconciliation"));
  const quiet = analyzeDailyReport(
    { ...baseline, adr: 128, rooms_sold: 78, room_revenue: 9984 },
    history
  );
  check("tolerates a $5 rounding gap", !typesOf(quiet).includes("revenue_reconciliation"));
}

console.log("\n13. Compset position");
{
  const flags = analyzeDailyReport(
    { ...baseline, adr: 110, occupancy_percent: 94 },
    history,
    { compsetAverageAdr: 145, compsetSize: 12 }
  );
  check("fires when underpriced at high occupancy", typesOf(flags).includes("compset_underpriced"));
  const noCompset = analyzeDailyReport({ ...baseline, adr: 110, occupancy_percent: 94 }, history);
  check(
    "is skipped when the compset was not priced",
    !typesOf(noCompset).includes("compset_underpriced")
  );
}

console.log("\n14. Weekday pacing");
{
  // 2026-08-06 is a Thursday. Give it five strong Thursdays of history.
  const thursdays = ["2026-07-02", "2026-07-09", "2026-07-16", "2026-07-23", "2026-07-30"].map(
    (d) => ({ report_date: d, occupancy_percent: 82 })
  );
  const flags = analyzeDailyReport(
    { ...baseline, report_date: "2026-08-06", occupancy_percent: 44 },
    thursdays
  );
  const f = flags.find((x) => x.flag_type === "pacing_weakness");
  check("fires on a soft Thursday", Boolean(f));
  check("compares against Thursdays, not the whole week", f?.message.includes("Thursday"));
}
{
  const flags = analyzeDailyReport(
    { ...baseline, report_date: "2026-08-06", occupancy_percent: 44 },
    []
  );
  const f = flags.find((x) => x.flag_type === "pacing_weakness");
  check("falls back to the 50% rule with no weekday history", f?.threshold === 50);
}

console.log("\n15. Direct bill / city ledger");
{
  const flags = analyzeDailyReport({ ...baseline, direct_bill_transfers: 900 }, history);
  check("fires above the transfer threshold", typesOf(flags).includes("direct_bill"));
}

console.log("\nDerivation");
{
  const d = deriveMetrics({
    report_date: "2026-08-05",
    room_revenue: 10000,
    rooms_sold: 80,
    rooms_available: 100,
  });
  check("derives occupancy", d.occupancy_percent === 80);
  check("derives ADR", d.adr === 125);
  check("derives RevPAR", d.revpar === 100);
}
{
  const d = deriveMetrics({ report_date: "2026-08-05", adr: 120, occupancy_percent: 0 });
  check("treats zero occupancy as a value, not a gap", d.revpar === 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
