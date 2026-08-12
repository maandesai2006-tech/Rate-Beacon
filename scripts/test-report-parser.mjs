// Parses the two real manager's-report layouts and asserts every figure
// against the printed report. The expected values below were read off the
// PDFs by hand, so a regression shows up as a wrong number, not a missing one.
//
//   node --experimental-strip-types scripts/test-report-parser.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractMetrics, extractReportDate, matchHotel } from "../src/lib/reports.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, "fixtures", name), "utf8");

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok =
    typeof expected === "number" && typeof actual === "number"
      ? Math.abs(actual - expected) < 0.011
      : actual === expected;
  if (ok) {
    passed++;
    console.log(`  ok   ${name} = ${actual}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}: got ${actual}, expected ${expected}`);
  }
}

function asMap(text) {
  return Object.fromEntries(extractMetrics(text).map((m) => [m.metric, m.value]));
}

// ── IHG General Manager Report (Candlewood Suites Pensacola) ──────────────
console.log("\nIHG General Manager Report");
{
  const text = read("ihg-gm-report.txt");
  const m = asMap(text);

  check("report date is the night, not the run date", extractReportDate(text, "1999-01-01"), "2026-08-10");

  check("occupancy", m.occupancy, 76.84);
  check("adr", m.adr, 105.69);
  check("revpar", m.revpar, 81.22);
  check("rooms_sold", m.rooms_sold, 73);
  check("rooms_available (Total Rooms, not the 22 unsold)", m.rooms_available, 95);
  check("room_revenue", m.room_revenue, 7715.51);
  check("total_revenue", m.total_revenue, 7826.01);
  check("other_revenue", m.other_revenue, 110.5);
  check("arrivals", m.arrivals, 31);
  check("departures", m.departures, 28);
  check("no_shows", m.no_shows, 0);
  check("cancellations", m.cancellations, 4);
  check("out_of_order", m.out_of_order, 0);
  check("early_departures", m.early_departures, 1);
  check("extended_stays", m.extended_stays, 1);
  check("guests", m.guests, 106);

  // The arithmetic the report itself implies must hold, or a column was misread.
  check("sold/available reproduces printed occupancy", Number(((73 / 95) * 100).toFixed(2)), 76.84);
  check("revenue/sold reproduces printed ADR", Number((7715.51 / 73).toFixed(2)), 105.69);
  check("revenue/available reproduces printed RevPAR", Number((7715.51 / 95).toFixed(2)), 81.22);

  // Columns that must NOT be read.
  check("MTD ADR (107.26) was not taken", m.adr === 107.26, false);
  check("Occupancy Tomorrow (53.68) was not taken", m.occupancy === 53.68, false);
  check("Transient Room Revenue was not taken as room revenue", m.room_revenue === 7715.51, true);
  check("Available Rooms (22) was not read as inventory", m.rooms_available === 22, false);
}

// ── Hilton Hotel Statistics (Hampton Inn Pensacola) ───────────────────────
console.log("\nHilton Hotel Statistics");
{
  const text = read("hilton-hotel-statistics.txt");
  const m = asMap(text);

  check("report date", extractReportDate(text, "1999-01-01"), "2026-03-26");

  check("occupancy (label wrapped over four lines)", m.occupancy, 90.59);
  check("adr (label wrapped over three lines)", m.adr, 145.43);
  check("revpar (not the With-Out-Of-Order variant)", m.revpar, 131.74);
  check("rooms_sold", m.rooms_sold, 77);
  check("rooms_available", m.rooms_available, 85);
  check("out_of_order", m.out_of_order, 0);
  check("stayovers", m.stayovers, 36);
  check("comp_rooms", m.comp_rooms, 0);

  check("sold/available reproduces printed occupancy", Number(((77 / 85) * 100).toFixed(2)), 90.59);
  check("RevPar With Out Of Order (131.74) is the same here, REVPAR still matched", m.revpar, 131.74);
  check("MTD occupancy (85.52) was not taken", m.occupancy === 85.52, false);
  check("ROOM SOLD EXCLUDING (78) was not taken", m.rooms_sold === 78, false);
}

// ── Formats that already worked must keep working ─────────────────────────
console.log("\nRegression: delimited layouts");
{
  const csv = [
    "Business Date,08/09/2026",
    "Occupancy,83.5%",
    'Room Revenue,"$8,843.05"',
    "Rooms Sold,67",
    "Rooms Available,80",
    "No Shows,2",
  ].join("\n");
  const m = asMap(csv);
  check("csv date", extractReportDate(csv, "1999-01-01"), "2026-08-09");
  check("csv occupancy", m.occupancy, 83.5);
  check("csv room revenue keeps its thousands separator", m.room_revenue, 8843.05);
  check("csv rooms sold", m.rooms_sold, 67);
  check("csv rooms available", m.rooms_available, 80);
  check("csv derives adr", m.adr, Number((8843.05 / 67).toFixed(10)));
}

// ── Hotel matching ────────────────────────────────────────────────────────
console.log("\nHotel matching");
{
  const owned = [
    { hotel_id: "cw", name: "Candlewood Suites Pensacola University Area by IHG" },
    { hotel_id: "hiex", name: "Holiday Inn Express & Suites Destin E - Commons Mall" },
  ];
  const hiex = read("ihg-gm-report.txt").replace(
    /Candlewood Suites Pensacola - University Area/,
    "Holiday Inn Express and Suites Destin E - Commons Mall Area"
  );
  check(
    "Destin report goes to the Holiday Inn Express",
    matchHotel(hiex, "HIEx-Destin_Managers Flash", owned)?.hotelId,
    "hiex"
  );

  // The exact mis-file that happened in production: a one-word competitor
  // name outscoring the real, longer property name.
  const withDecoy = [...owned, { hotel_id: "decoy", name: "Destin Inn & Suites" }];
  check(
    "a one-word competitor name does not steal it",
    matchHotel(hiex, "HIEx-Destin_Managers Flash", withDecoy)?.hotelId,
    "hiex"
  );

  check(
    "Pensacola report still goes to Candlewood",
    matchHotel(read("ihg-gm-report.txt"), "Candlewood Suites_Managers Flash", owned)?.hotelId,
    "cw"
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
