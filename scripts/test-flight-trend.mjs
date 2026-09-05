// Turning daily airport counts into the movement a revenue manager reads.
//
// The counts themselves come from a public feed whose coverage varies, so the
// number on its own means little — the change is the whole signal, and getting
// that arithmetic wrong would put a confident "+40%" under a chart that shows
// no such thing. That is what is pinned here.
//
//   node --experimental-strip-types scripts/test-flight-trend.mjs

import { trendOf } from "../src/lib/flights.ts";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const day = (n) => new Date(Date.UTC(2026, 8, n)).toISOString().slice(0, 10);
const series = (counts) => counts.map((arrivals, i) => ({ day: day(i + 1), arrivals, departures: arrivals - 1 }));

// ── Day over day ────────────────────────────────────────────────────────
{
  const { points, changePct } = trendOf(series([100, 120]), "day");
  check("one point per day", points.length === 2);
  check("a 20% rise reads as +20", Math.round(changePct) === 20, `got ${changePct}`);
  check("labels are weekdays", /^[A-Z][a-z]{2}$/.test(points[0].label), points[0].label);
  check("departures are carried", points[1].departures === 119);
}
{
  const { changePct } = trendOf(series([120, 90]), "day");
  check("a fall reads negative", Math.round(changePct) === -25, `got ${changePct}`);
}
{
  const { changePct } = trendOf(series([100]), "day");
  check("a single day has nothing to compare to", changePct === null);
}
{
  const { changePct } = trendOf(series([0, 40]), "day");
  check("a rise from zero is not infinity", changePct === null, `got ${changePct}`);
}
{
  const { points, changePct } = trendOf([], "day");
  check("no data gives no points", points.length === 0);
  check("no data gives no change", changePct === null);
}

// ── Week over week ──────────────────────────────────────────────────────
{
  // Fourteen days: the first seven sum to 700, the second to 1400.
  const counts = [...Array(7).fill(100), ...Array(7).fill(200)];
  const { points, changePct } = trendOf(series(counts), "week");
  check("fourteen days make two weeks", points.length === 2, `got ${points.length}`);
  check("a week sums its days", points[0].arrivals === 700, `got ${points[0].arrivals}`);
  check("the most recent week is last", points[1].arrivals === 1400);
  check("a doubling reads as +100", Math.round(changePct) === 100, `got ${changePct}`);
  check("week labels name their start", points[0].label.startsWith("w/c "), points[0].label);
}
{
  // Nine days is one complete week and two spare. Comparing two days against
  // seven would report a tripling that never happened, so the spare days are
  // dropped and there is simply nothing to compare against yet.
  const { points, changePct } = trendOf(series([...Array(7).fill(100), 50, 50]), "week");
  check("only complete weeks become bars", points.length === 1, `got ${points.length}`);
  check("the complete week is the most recent seven days", points[0].arrivals === 600, `got ${points[0].arrivals}`);
  check("one week alone has nothing to compare to", changePct === null, `got ${changePct}`);
}

{
  // Four weeks is what the chart asks for; all four are whole.
  const { points, changePct } = trendOf(series(Array(28).fill(10)), "week");
  check("28 days make four weeks", points.length === 4, `got ${points.length}`);
  check("a flat month reads as no change", changePct === 0, `got ${changePct}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
