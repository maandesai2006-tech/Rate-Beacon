import assert from "node:assert/strict";
import { existsSync } from "node:fs";

// A missing engine is an intentional assertion failure in the first red run.
assert.ok(existsSync(new URL("../src/lib/forecast.ts", import.meta.url)), "the deterministic forecast engine exists");
const { computeForecast, backtestForecast, compressionSignal, marketMovementSignal, demandScoreFromSignals } = await import("../src/lib/forecast.ts");
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const day = (date, offset) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const snap = (hotel_id, check_in, captured_on, price = 100, available = true, extra = {}) => ({ hotel_id, check_in, captured_on, price, available, currency: "USD", ...extra });
const base = { hotelId: "mine", compHotelIds: ["a", "b", "c"], checkIn: "2026-07-08", asOf: "2026-07-01", currency: "USD", snapshots: [] };
function history(days = 40, ratio = 0.9) {
  const rows = [];
  for (let i = days; i >= 1; i--) {
    const stay = day(base.asOf, -i);
    for (const [id, p] of [["a", 90], ["b", 100], ["c", 110], ["mine", 100 * ratio]]) {
      rows.push(snap(id, stay, day(stay, -7), p));
      rows.push(snap(id, stay, stay, p * 1.1));
    }
  }
  return rows;
}
const current = (ratio = 0.9) => [snap("a", base.checkIn, base.asOf, 90), snap("b", base.checkIn, base.asOf, 100), snap("c", base.checkIn, base.asOf, 110), snap("mine", base.checkIn, base.asOf, 100 * ratio)];

test("empty market is exactly neutral without fabricated prices or hotel position", () => {
  const f = computeForecast(base);
  assert.equal(f.demandScore, 50);
  for (const k of ["currentMarketMedian", "forecastMedian", "normalRate", "hotelPositionRatio", "suggestedLow", "suggestedHigh"]) assert.equal(f[k], null, k);
  assert.equal(f.confidenceLabel, "low");
  assert.equal(f.pricingEnabled, false);
  assert.ok(f.signals.every(s => s.confidence === 0 && s.contribution === 0));
});

test("signal normalizations have known values and bounded contributions", () => {
  const c = compressionSignal({ unavailable: 3, observed: 6, totalCompetitors: 6, baseline: 0.25, baselineDates: 14, leadTime: 60 });
  assert.equal(c.normalized, 0.5);
  assert.equal(c.weight, 40);
  assert.equal(c.confidence, 1);
  assert.equal(c.contribution, 20);
  assert.match(c.evidence, /unavailable/i);
  assert.doesNotMatch(c.evidence, /sold out/i);
  const m = marketMovementSignal({ previousMedian: 100, currentMedian: 110, matchedCompetitors: 6, totalCompetitors: 6, comparisonDays: 7 });
  assert.ok(Math.abs(m.normalized - 0.5) < 1e-9);
  assert.ok(Math.abs(m.contribution - 12.5) < 1e-9);
  assert.equal(demandScoreFromSignals([]), 50);
  assert.equal(demandScoreFromSignals([{ ...c, normalized: 1, weight: 10000, confidence: 1 }]), 100);
  assert.equal(demandScoreFromSignals([{ ...c, normalized: -1, weight: 10000, confidence: 1 }]), 0);
});

test("invalid and missing signal inputs are neutral and finite", () => {
  for (const s of [compressionSignal({ unavailable: 10, observed: 2, totalCompetitors: 2, baseline: null, baselineDates: 0, leadTime: 7 }), marketMovementSignal({ previousMedian: 0, currentMedian: Infinity, matchedCompetitors: 6, totalCompetitors: 6, comparisonDays: 7 })]) {
    assert.equal(s.confidence, 0);
    assert.equal(s.contribution, 0);
    assert.ok(Number.isFinite(s.normalized));
  }
  assert.equal(demandScoreFromSignals([{ normalized: NaN, weight: 25, confidence: 1 }]), 50);
});

test("three collection days are a low confidence cold start with zero learned drift", () => {
  const rows = [];
  for (let i = 0; i < 3; i++) for (const id of base.compHotelIds) rows.push(snap(id, base.checkIn, day(base.asOf, -i), 100 + i));
  const f = computeForecast({ ...base, snapshots: rows });
  assert.equal(f.evidence.historyDays, 3);
  assert.equal(f.confidenceLabel, "low");
  assert.equal(f.evidence.drift.expected, 0);
  assert.equal(f.forecastMedian, 100);
  assert.equal(f.hotelPositionRatio, null);
  assert.match(f.confidenceReasons.join(" "), /30|history/i);
});

test("future capture injection changes no forecast value, quality count, baseline or evidence", () => {
  const rows = [...history(), ...current()];
  const expected = computeForecast({ ...base, snapshots: rows });
  const future = rows.map(r => ({ ...r, captured_on: day(base.asOf, 1), price: 999999, available: false }));
  future.push(snap("a", "2026-08-01", "2026-07-09", NaN, true, { is_anomaly: true }));
  assert.deepEqual(computeForecast({ ...base, snapshots: [...rows, ...future] }), expected);
});

test("movement compares the same competitors and cannot confuse composition with rate changes", () => {
  const rows = [snap("a", base.checkIn, day(base.asOf, -7), 100), snap("b", base.checkIn, day(base.asOf, -7), 200), snap("c", base.checkIn, day(base.asOf, -7), 900), snap("a", base.checkIn, base.asOf, 100), snap("b", base.checkIn, base.asOf, 200), snap("c", base.checkIn, base.asOf, null, false)];
  const f = computeForecast({ ...base, snapshots: rows });
  assert.equal(f.evidence.movement.matchedCompetitors, 2);
  assert.equal(f.evidence.movement.fraction, 0);
  assert.equal(f.signals.find(s => s.key === "market_movement").contribution, 0);
});

test("movement requires at least two matched hotels", () => {
  const f = computeForecast({ ...base, snapshots: [snap("a", base.checkIn, day(base.asOf, -7), 100), snap("a", base.checkIn, base.asOf, 200), snap("b", base.checkIn, base.asOf, 300)] });
  assert.equal(f.signals.find(s => s.key === "market_movement").confidence, 0);
});

test("anomalies, mismatched currency, nonpositive prices and stale captures do not become live prices", () => {
  const rows = [snap("a", base.checkIn, base.asOf, 9999, true, { is_anomaly: true }), snap("b", base.checkIn, base.asOf, 200, true, { currency: "EUR" }), snap("c", base.checkIn, base.asOf, -1)];
  const f = computeForecast({ ...base, snapshots: rows });
  assert.equal(f.currentMarketMedian, null);
  assert.equal(f.evidence.quality.excludedAnomaly, 1);
  assert.equal(f.evidence.quality.excludedCurrency, 1);
  assert.equal(f.evidence.quality.excludedInvalid, 1);
  const stale = computeForecast({ ...base, snapshots: base.compHotelIds.map(id => snap(id, base.checkIn, day(base.asOf, -10), 100)) });
  assert.equal(stale.currentMarketMedian, null);
  assert.equal(stale.evidence.quality.staleCurrent, 3);
});

test("null and unpriced availability are not inferred unavailable", () => {
  const f = computeForecast({ ...base, snapshots: [snap("a", base.checkIn, base.asOf, null, null), snap("b", base.checkIn, base.asOf, null, true), snap("c", base.checkIn, base.asOf, null, false)] });
  assert.equal(f.evidence.compression.observed, 2);
  assert.equal(f.evidence.compression.unavailable, 1);
  assert.equal(f.evidence.compression.current, 0.5);
});

test("learned drift and hotel position are backed by settled distinct stay dates", () => {
  const f = computeForecast({ ...base, snapshots: [...history(), ...current()] });
  assert.ok(Math.abs(f.evidence.drift.expected - 0.1) < 1e-9);
  assert.ok(Math.abs(f.forecastMedian - 110) < 1e-9);
  assert.ok(Math.abs(f.hotelPositionRatio - 0.9) < 1e-9);
  assert.equal(f.evidence.drift.stayDates, 40);
  assert.ok(f.evidence.compression.baselineDates >= 30);
  assert.ok(f.confidence > computeForecast({ ...base, snapshots: current() }).confidence);
});

test("repeated captures cannot manufacture distinct training stay dates", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) for (const id of base.compHotelIds) rows.push(snap(id, "2026-06-30", day("2026-06-30", -i), 100));
  const f = computeForecast({ ...base, snapshots: [...rows, ...current()] });
  assert.equal(f.evidence.compression.baselineDates, 1);
  assert.equal(f.evidence.drift.stayDates, 1);
  assert.equal(f.evidence.drift.expected, 0);
  assert.equal(f.confidenceLabel, "low");
});

test("own weekday history remains usable when competitor history is missing", () => {
  const rows = [7, 14, 21].map((offset, i) => {
    const stay = day(base.checkIn, -offset - 7);
    return snap("mine", stay, stay, 90 + i * 10);
  });
  const f = computeForecast({ ...base, snapshots: rows });
  assert.equal(f.normalRate, 100);
  assert.equal(f.hotelPositionRatio, null);
  assert.equal(f.evidence.normalRate.samples, 3);
});

test("one priced competitor remains low confidence even after a long history", () => {
  const f = computeForecast({ ...base, compHotelIds: ["a"], snapshots: [...history(60), ...current()] });
  assert.equal(f.confidenceLabel, "low");
});

test("long history with no usable demand signals cannot claim confident neutral demand", () => {
  const comps = ["a", "b", "c", "d", "e", "f"];
  const rows = [];
  for (let i = 1; i <= 60; i++) for (const id of comps) rows.push(snap(id, day(base.asOf, -i), day(base.asOf, -i), 100));
  for (const id of comps) rows.push(snap(id, base.checkIn, base.asOf, 100));
  const f = computeForecast({ ...base, compHotelIds: comps, snapshots: rows });
  assert.equal(f.signals.filter(s => s.confidence > 0).length, 0);
  assert.equal(f.confidenceLabel, "low");
});

test("positive numerical extremes saturate safely without nonfinite evidence", () => {
  assert.equal(demandScoreFromSignals(Array(2).fill({ normalized: 1, weight: Number.MAX_VALUE, confidence: 1 })), 100);
  const f = computeForecast({ ...base, snapshots: [snap("a", base.checkIn, base.asOf, Number.MIN_VALUE), snap("b", base.checkIn, base.asOf, Number.MIN_VALUE)] });
  assert.ok(f.currentMarketMedian > 0);
  function finite(value) {
    if (typeof value === "number") assert.ok(Number.isFinite(value));
    else if (Array.isArray(value)) value.forEach(finite);
    else if (value && typeof value === "object") Object.values(value).forEach(finite);
  }
  finite(f);
});

test("candidate upper endpoints are capped and bands ordered even for extreme measured hotel position", () => {
  for (const ratio of [0.001, 0.9, 5, 1000000]) {
    const f = computeForecast({ ...base, snapshots: [...history(40, ratio), ...current(ratio)] });
    assert.ok(f.suggestedLow <= f.suggestedHigh);
    assert.ok(f.suggestedLow >= 0);
    assert.ok(f.suggestedHigh <= 1.25 * f.forecastMedian);
    assert.ok(f.marketLow <= f.forecastMedian && f.marketHigh >= f.forecastMedian);
    assert.equal(f.pricingEnabled, false);
  }
});

test("invalid dates fail explicitly and duplicate input order is deterministic", () => {
  assert.throws(() => computeForecast({ ...base, asOf: "2026-02-30" }), /date/i);
  const rows = [...history(), ...current(), snap("a", base.checkIn, base.asOf, 150)];
  assert.deepEqual(computeForecast({ ...base, snapshots: rows }), computeForecast({ ...base, snapshots: rows.toReversed() }));
});

test("backtests walk forward with real near-check-in outcomes and a carry-forward baseline", () => {
  const b = backtestForecast({ ...base, snapshots: history(60), leadTimes: [7], maxDates: 100 });
  assert.ok(b.points.length > 20);
  assert.equal(b.byLeadTime.length, 1);
  assert.equal(b.byLeadTime[0].samples, b.points.length);
  assert.ok(b.byLeadTime[0].baselineMae > 0);
  assert.ok(b.byLeadTime[0].mae < b.byLeadTime[0].baselineMae);
  for (const p of b.points) {
    const f = computeForecast({ ...base, snapshots: history(60).filter(r => r.captured_on <= p.cutoff), asOf: p.cutoff, checkIn: p.checkIn });
    assert.equal(p.predictedMedian, f.forecastMedian);
    assert.equal(p.baselineMedian, f.currentMarketMedian);
  }
});

test("post-cutoff captures affect outcomes but cannot affect a reconstructed prediction", () => {
  const rows = history(40);
  const a = backtestForecast({ ...base, snapshots: rows, leadTimes: [7], maxDates: 100 });
  const target = a.points.at(-1);
  assert.ok(target);
  const inject = base.compHotelIds.map(id => snap(id, target.checkIn, day(target.cutoff, 1), 5000));
  const b = backtestForecast({ ...base, snapshots: [...rows, ...inject], leadTimes: [7], maxDates: 100 });
  assert.deepEqual(b.points.find(p => p.checkIn === target.checkIn), target);
  const beyondAsOf = base.compHotelIds.map(id => snap(id, target.checkIn, day(base.asOf, 1), 9999));
  assert.deepEqual(backtestForecast({ ...base, snapshots: [...rows, ...beyondAsOf], leadTimes: [7], maxDates: 100 }), a);
});

test("retention gaps, captures after check-in and sparse stale outcomes never become backtest truth", () => {
  const stay = "2026-06-25";
  for (const finalRows of [[], [snap("a", stay, stay, 110)], base.compHotelIds.map(id => snap(id, stay, day(stay, 1), 110)), base.compHotelIds.map(id => snap(id, stay, day(stay, -3), 110))]) {
    const rows = [...base.compHotelIds.map(id => snap(id, stay, day(stay, -7), 100)), ...finalRows];
    const b = backtestForecast({ ...base, snapshots: rows, leadTimes: [7] });
    assert.equal(b.points.length, 0);
    assert.equal(b.byLeadTime[0].mae, null);
    assert.match(b.limitations.join(" "), /retention|missing|sparse/i);
  }
});

test("backtests require genuinely later outcomes and cannot grade a forecast against its own capture", () => {
  const stay = "2026-06-25";
  for (const age of [1, 2]) {
    const rows = base.compHotelIds.map(id => snap(id, stay, day(stay, -age), 100));
    const b = backtestForecast({ ...base, snapshots: rows, leadTimes: [1] });
    assert.equal(b.points.length, 0);
  }
});

console.log(`\n${passed} forecast tests passed`);
