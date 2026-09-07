/**
 * Release 1: deterministic observations and a carry-forward market forecast.
 * No clock, database, PMS, external signals or model-generated numbers.
 * All training is restricted to information available on the supplied asOf.
 * Keep this module dependency-free so Node can run the same code in backtests.
 */
export interface ForecastSnapshot {
  hotel_id: string;
  check_in: string;
  captured_on: string;
  price: number | null;
  available: boolean | null;
  is_anomaly?: boolean | null;
  currency?: string;
}

export interface ForecastInput {
  hotelId: string;
  compHotelIds: string[];
  hotelNames?: Record<string, string>;
  checkIn: string;
  asOf: string;
  currency: string;
  snapshots: ForecastSnapshot[];
}

export interface Signal {
  key: string;
  value: number;
  normalized: number;
  weight: number;
  confidence: number;
  evidence: string;
  leadTimeValid: [number, number];
  contribution: number;
}

export interface ForecastCompetitorEvidence {
  hotelId: string;
  name: string;
  capturedOn: string | null;
  price: number | null;
  available: boolean | null;
  ageDays: number | null;
  status: "priced" | "unavailable" | "unknown" | "stale" | "missing";
}

export interface MovementComparison {
  hotelId: string;
  previousCapturedOn: string;
  currentCapturedOn: string;
  previousPrice: number;
  currentPrice: number;
}

export interface CompressionObservation {
  checkIn: string;
  capturedOn: string;
  leadTime: number;
  unavailable: number;
  observed: number;
  fraction: number;
  competitors: { hotelId: string; capturedOn: string; available: boolean }[];
}

export interface DriftObservation {
  checkIn: string;
  startCapturedOn: string;
  settledCapturedOn: string;
  startLeadTime: number;
  startMedian: number;
  settledMedian: number;
  fraction: number;
  competitors: MovementComparison[];
}

export interface PositionObservation {
  checkIn: string;
  capturedOn: string;
  hotelPrice: number;
  marketMedian: number;
  ratio: number;
  competitors: { hotelId: string; capturedOn: string; price: number }[];
}

export interface ForecastEvidence {
  historyDays: number;
  historyCaptureDays: number;
  historyStayDates: number;
  pricedCompetitors: number;
  observedCompetitors: number;
  totalCompetitors: number;
  currentCaptureOldest: string | null;
  currentCaptureNewest: string | null;
  freshnessDays: number;
  competitors: ForecastCompetitorEvidence[];
  compression: {
    current: number | null;
    baseline: number | null;
    baselineDates: number;
    leadBucket: [number, number];
    unavailable: number;
    observed: number;
    samples: CompressionObservation[];
  };
  movement: {
    fraction: number | null;
    previousCapturedOn: string | null;
    currentCapturedOn: string | null;
    matchedCompetitors: number;
    previousMedian: number | null;
    currentMedian: number | null;
    comparisons: MovementComparison[];
  };
  drift: { expected: number; pairs: number; stayDates: number; method: string; samples: DriftObservation[] };
  position: { ratio: number | null; samples: number; method: string; observations: PositionObservation[] };
  normalRate: { samples: number; method: string; observations: { checkIn: string; capturedOn: string; price: number }[] };
  uncertainty: { relativeWidth: number; method: string; priceDispersion: number };
  quality: {
    excludedAnomaly: number;
    excludedCurrency: number;
    excludedInvalid: number;
    excludedAfterCheckIn: number;
    staleCurrent: number;
  };
  limitations: string[];
}

export interface DemandForecast {
  version: 1;
  hotelId: string;
  checkIn: string;
  asOf: string;
  currency: string;
  leadTime: number;
  demandScore: number;
  currentMarketMedian: number | null;
  forecastMedian: number | null;
  marketLow: number | null;
  marketHigh: number | null;
  normalRate: number | null;
  hotelPositionRatio: number | null;
  demandMultiplier: number;
  suggestedLow: number | null;
  suggestedHigh: number | null;
  pricingEnabled: false;
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  confidenceReasons: string[];
  signals: Signal[];
  evidence: ForecastEvidence;
}

export interface BacktestPoint {
  cutoff: string;
  checkIn: string;
  leadTime: number;
  predictedMedian: number;
  actualMedian: number;
  baselineMedian: number;
  marketLow: number;
  marketHigh: number;
  suggestedLow: number | null;
  suggestedHigh: number | null;
  actualCompression: number | null;
  forecastCompression: number | null;
}

export interface BacktestLeadTime {
  leadTime: number;
  samples: number;
  mae: number | null;
  baselineMae: number | null;
  marketCoverage: number | null;
  suggestedCoverage: number | null;
  compressionMae: number | null;
}

export interface BacktestResult {
  version: 1;
  asOf: string;
  currency: string;
  hotelId: string;
  byLeadTime: BacktestLeadTime[];
  points: BacktestPoint[];
  limitations: string[];
}

const DAY = 86_400_000;
const clamp = (n: number, low = 0, high = 1) => Number.isNaN(n) ? low : Math.max(low, Math.min(high, n));
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  // These distributions are positive prices/ratios, or drift bounded below by
  // -1. This midpoint avoids overflow from addition and subnormal underflow.
  return sorted.length % 2 ? sorted[half] : sorted[half - 1] + (sorted[half] - sorted[half - 1]) / 2;
};
const mean = (values: number[]) => values.length ? values.reduce((sum, n) => sum + n / values.length, 0) : null;
const validDate = (value: string): boolean => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};
const epoch = (date: string) => Date.parse(`${date}T00:00:00Z`);
const days = (later: string, earlier: string) => Math.round((epoch(later) - epoch(earlier)) / DAY);
const addDays = (date: string, offset: number) => new Date(epoch(date) + offset * DAY).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const rate = (row: ForecastSnapshot | undefined): number | null => row && row.available !== false && row.price != null && Number.isFinite(row.price) && row.price > 0 ? row.price : null;
const freshness = (lead: number) => lead <= 14 ? 2 : lead <= 45 ? 4 : 8;
const leadBucket = (lead: number): [number, number] => {
  for (const bucket of [[0, 3], [4, 7], [8, 14], [15, 30], [31, 45], [46, 75], [76, 365]] as [number, number][]) if (lead <= bucket[1]) return bucket;
  return [366, 730];
};
const extent = (values: string[]): [string | null, string | null] => values.length ? [values.toSorted()[0], values.toSorted().at(-1)!] : [null, null];
const product = (a: number, b: number): number | null => Number.isFinite(a * b) && a * b > 0 ? a * b : null;

export interface CompressionSignalInput {
  unavailable: number;
  observed: number;
  totalCompetitors: number;
  baseline: number | null;
  baselineDates: number;
  leadTime: number;
}

export function compressionSignal(input: CompressionSignalInput): Signal {
  const { unavailable, observed, totalCompetitors, baseline, baselineDates, leadTime } = input;
  const measured = Number.isInteger(observed) && observed > 0 && Number.isInteger(unavailable) && unavailable >= 0 && unavailable <= observed && totalCompetitors >= observed;
  const value = measured ? unavailable / observed : 0;
  const usable = measured && baseline != null && Number.isFinite(baseline) && baseline >= 0 && baseline <= 1 && baselineDates >= 3 && leadTime >= 0 && leadTime <= 365;
  const normalized = usable ? clamp((value - baseline) / 0.5, -1, 1) : 0;
  const weight = 25 + 15 * clamp(leadTime / 60);
  const confidence = usable ? clamp(observed / 6) * clamp(baselineDates / 14) * clamp(observed / totalCompetitors) : 0;
  return {
    key: "compression", value, normalized, weight, confidence,
    contribution: normalized * weight * confidence,
    leadTimeValid: [0, 365],
    evidence: measured
      ? `${unavailable} of ${observed} observed competitors unavailable in the rate feed; ${usable ? `${Math.round(value * 100)}% versus a ${Math.round(baseline! * 100)}% median across ${baselineDates} historical stay dates in this lead-time bucket.` : "insufficient comparable history to score unusual compression."} Feed unavailability does not establish a sellout.`
      : "No fresh availability observations; compression is unmeasured.",
  };
}

export interface MarketMovementSignalInput {
  previousMedian: number | null;
  currentMedian: number | null;
  matchedCompetitors: number;
  totalCompetitors: number;
  comparisonDays: number;
}

export function marketMovementSignal(input: MarketMovementSignalInput): Signal {
  const { previousMedian, currentMedian, matchedCompetitors, totalCompetitors, comparisonDays } = input;
  const ratio = previousMedian != null && currentMedian != null && previousMedian > 0 && currentMedian > 0 ? currentMedian / previousMedian - 1 : NaN;
  const usable = Number.isFinite(ratio) && matchedCompetitors >= 2 && totalCompetitors >= matchedCompetitors && comparisonDays >= 1 && comparisonDays <= 14;
  const value = usable ? ratio : 0;
  const normalized = usable ? clamp(value / 0.2, -1, 1) : 0;
  const confidence = usable ? clamp(matchedCompetitors / 6) * clamp(matchedCompetitors / totalCompetitors) * clamp(comparisonDays / 7) : 0;
  const weight = 25;
  return {
    key: "market_movement", value, normalized, weight, confidence,
    contribution: normalized * weight * confidence,
    leadTimeValid: [0, 365],
    evidence: usable
      ? `Median ${value >= 0 ? "up" : "down"} ${Math.abs(value * 100).toFixed(1)}% across the same ${matchedCompetitors} competitors over ${comparisonDays.toFixed(0)} days.`
      : "Fewer than two competitors have comparable fresh prices in both captures; market movement is unmeasured.",
  };
}

export function demandScoreFromSignals(signals: Pick<Signal, "normalized" | "weight" | "confidence">[]): number {
  const usable = signals.filter(signal => [signal.normalized, signal.weight, signal.confidence].every(Number.isFinite) && signal.weight > 0);
  const scale = usable.reduce((largest, signal) => Math.max(largest, signal.weight), 1);
  const contribution = usable.reduce((sum, signal) => sum + clamp(signal.normalized, -1, 1) * (signal.weight / scale) * clamp(signal.confidence), 0) * scale;
  return Math.round(50 + clamp(contribution, -50, 50));
}

type Quality = ForecastEvidence["quality"];
function cleanSnapshots(input: Omit<ForecastInput, "checkIn">): { rows: ForecastSnapshot[]; quality: Quality; comps: string[] } {
  if (!validDate(input.asOf)) throw new Error("asOf must be a valid ISO date (YYYY-MM-DD)");
  if (!input.hotelId || !input.currency) throw new Error("A hotel and currency are required");
  const comps = [...new Set(input.compHotelIds.filter(id => id && id !== input.hotelId))].sort();
  const ids = new Set([input.hotelId, ...comps]);
  const quality: Quality = { excludedAnomaly: 0, excludedCurrency: 0, excludedInvalid: 0, excludedAfterCheckIn: 0, staleCurrent: 0 };
  const unique = new Map<string, ForecastSnapshot>();
  const conflicts = new Set<string>();
  for (const row of input.snapshots) {
    if (!ids.has(row.hotel_id)) continue;
    // Filter the future before all counters: even evidence must be cutoff-invariant.
    if (validDate(row.captured_on) && row.captured_on > input.asOf) continue;
    if (!validDate(row.captured_on) || !validDate(row.check_in)) { quality.excludedInvalid++; continue; }
    if (row.captured_on > row.check_in) { quality.excludedAfterCheckIn++; continue; }
    if (row.is_anomaly === true) { quality.excludedAnomaly++; continue; }
    if (row.currency != null && row.currency.toUpperCase() !== input.currency.toUpperCase()) { quality.excludedCurrency++; continue; }
    if ((row.price != null && (!Number.isFinite(row.price) || row.price <= 0)) || ![true, false, null].includes(row.available)) { quality.excludedInvalid++; continue; }
    const key = `${row.hotel_id}|${row.check_in}|${row.captured_on}`;
    const previous = unique.get(key);
    if (previous && (previous.available !== row.available || previous.price !== row.price)) conflicts.add(key);
    else unique.set(key, row);
  }
  // Conflicting duplicate primary keys are unusable; never pick by input order.
  for (const key of conflicts) { unique.delete(key); quality.excludedInvalid++; }
  const rows = [...unique.values()].sort((a, b) => a.check_in.localeCompare(b.check_in) || a.captured_on.localeCompare(b.captured_on) || a.hotel_id.localeCompare(b.hotel_id));
  return { rows, quality, comps };
}

/** Index once per invocation; the forecast never rereads an external source. */
function indexRows(rows: ForecastSnapshot[]) {
  const index = new Map<string, ForecastSnapshot[]>();
  for (const row of rows) {
    const list = index.get(row.check_in) ?? [];
    list.push(row);
    index.set(row.check_in, list);
  }
  return index;
}

function at(rows: ForecastSnapshot[], ids: string[], cutoff: string, maxAge: number): Map<string, ForecastSnapshot> {
  const wanted = new Set(ids);
  const latest = new Map<string, ForecastSnapshot>();
  for (const row of rows) if (wanted.has(row.hotel_id) && row.captured_on <= cutoff && days(cutoff, row.captured_on) <= maxAge) {
    const previous = latest.get(row.hotel_id);
    if (!previous || previous.captured_on < row.captured_on) latest.set(row.hotel_id, row);
  }
  return latest;
}

function prices(rows: Map<string, ForecastSnapshot>): number[] {
  return [...rows.values()].flatMap(row => { const p = rate(row); return p == null ? [] : [p]; });
}

function availability(rows: Map<string, ForecastSnapshot>) {
  const observed = [...rows.values()].filter(row => row.available === true || row.available === false);
  const unavailable = observed.filter(row => row.available === false).length;
  return { observed: observed.length, unavailable, fraction: observed.length ? unavailable / observed.length : null };
}

function sufficient(count: number, total: number) { return count >= 2 && count >= Math.ceil(total / 2); }

function matched(start: Map<string, ForecastSnapshot>, finish: Map<string, ForecastSnapshot>): MovementComparison[] {
  return [...start.keys()].sort().flatMap(hotelId => {
    const a = start.get(hotelId)!;
    const b = finish.get(hotelId);
    const before = rate(a), after = rate(b);
    return b && before != null && after != null ? [{ hotelId, previousCapturedOn: a.captured_on, currentCapturedOn: b.captured_on, previousPrice: before, currentPrice: after }] : [];
  });
}

export function computeForecast(input: ForecastInput): DemandForecast {
  if (!validDate(input.checkIn)) throw new Error("checkIn must be a valid ISO date (YYYY-MM-DD)");
  const { rows, quality, comps } = cleanSnapshots(input);
  const leadTime = days(input.checkIn, input.asOf);
  if (leadTime < 0 || leadTime > 730) throw new Error("Forecast date must be between asOf and 730 days ahead");
  const bucket = leadBucket(leadTime);
  const maxAge = freshness(leadTime);
  const index = indexRows(rows);
  const targetRows = index.get(input.checkIn) ?? [];
  const latest = at(targetRows, comps, input.asOf, Infinity);
  const current = at(targetRows, comps, input.asOf, maxAge);
  const currentPrices = prices(current);
  const currentMarketMedian = median(currentPrices);
  const currentAvailability = availability(current);
  const captureExtent = extent([...current.values()].map(row => row.captured_on));
  const competitors: ForecastCompetitorEvidence[] = comps.map(hotelId => {
    const row = latest.get(hotelId);
    const ageDays = row ? days(input.asOf, row.captured_on) : null;
    const stale = ageDays != null && ageDays > maxAge;
    if (stale) quality.staleCurrent++;
    return { hotelId, name: input.hotelNames?.[hotelId] ?? hotelId, capturedOn: row?.captured_on ?? null, price: stale ? null : rate(row), available: stale ? null : row?.available ?? null, ageDays, status: !row ? "missing" : stale ? "stale" : row.available === false ? "unavailable" : rate(row) != null ? "priced" : "unknown" };
  });

  const compRows = rows.filter(row => comps.includes(row.hotel_id) && (rate(row) != null || row.available != null));
  const historyDays = new Set(compRows.map(row => row.captured_on)).size;
  const pastDates = [...new Set(compRows.filter(row => row.check_in < input.asOf).map(row => row.check_in))].sort();
  const compressionSamples: CompressionObservation[] = [];
  const driftSamples: DriftObservation[] = [];
  const positionSamples: PositionObservation[] = [];
  const normalSamples: ForecastEvidence["normalRate"]["observations"] = [];

  const trainingDates = [...index.keys()].filter(date => date < input.asOf).sort();
  for (const checkIn of trainingDates) {
    const stayRows = index.get(checkIn)!;
    // Use an actual historical capture, choosing one per stay date in the same bucket.
    const candidateDates = [...new Set(stayRows.filter(row => comps.includes(row.hotel_id) && days(checkIn, row.captured_on) >= bucket[0] && days(checkIn, row.captured_on) <= bucket[1]).map(row => row.captured_on))]
      .sort((a, b) => Math.abs(days(checkIn, a) - leadTime) - Math.abs(days(checkIn, b) - leadTime) || b.localeCompare(a));
    const capture = candidateDates[0];
    if (capture) {
      const startLead = days(checkIn, capture);
      const start = at(stayRows, comps, capture, freshness(startLead));
      const av = availability(start);
      if (sufficient(av.observed, comps.length) && av.fraction != null) compressionSamples.push({ checkIn, capturedOn: capture, leadTime: startLead, unavailable: av.unavailable, observed: av.observed, fraction: av.fraction, competitors: [...start.values()].filter(row => row.available != null).map(row => ({ hotelId: row.hotel_id, capturedOn: row.captured_on, available: row.available! })) });
      const settled = at(stayRows, comps, checkIn, 2);
      const pairs = matched(start, settled).filter(pair => pair.currentCapturedOn > pair.previousCapturedOn);
      if (sufficient(pairs.length, comps.length)) {
        const startMedian = median(pairs.map(pair => pair.previousPrice))!;
        const settledMedian = median(pairs.map(pair => pair.currentPrice))!;
        const fraction = settledMedian / startMedian - 1;
        if (Number.isFinite(fraction)) driftSamples.push({ checkIn, startCapturedOn: capture, settledCapturedOn: extent(pairs.map(pair => pair.currentCapturedOn))[1]!, startLeadTime: startLead, startMedian, settledMedian, fraction, competitors: pairs });
      }
    }
    // Hotel position is measured against competitors quoted on the same capture.
    // A retained old row remains usable only if its paired market capture exists.
    const own = stayRows.filter(row => row.hotel_id === input.hotelId && rate(row) != null).at(-1);
    if (!own) continue;
    const ownPrice = rate(own)!;
    const market = at(stayRows, comps, own.captured_on, 0);
    const marketMedian = median(prices(market));
    if (marketMedian != null && sufficient(prices(market).length, comps.length) && Number.isFinite(ownPrice / marketMedian)) positionSamples.push({ checkIn, capturedOn: own.captured_on, hotelPrice: ownPrice, marketMedian, ratio: ownPrice / marketMedian, competitors: [...market.values()].flatMap(row => { const p = rate(row); return p == null ? [] : [{ hotelId: row.hotel_id, capturedOn: row.captured_on, price: p }]; }) });
    // Typical weekday rate uses near-check-in observations, never stale retained asks.
    if (weekday(checkIn) === weekday(input.checkIn) && days(checkIn, own.captured_on) <= 2) normalSamples.push({ checkIn, capturedOn: own.captured_on, price: ownPrice });
  }

  const baseline = median(compressionSamples.map(sample => sample.fraction));
  const comparisons: MovementComparison[] = [];
  for (const [hotelId, row] of current) {
    if (rate(row) == null) continue;
    const previous = targetRows.filter(candidate => candidate.hotel_id === hotelId && candidate.captured_on < row.captured_on && days(input.asOf, candidate.captured_on) <= 14 && rate(candidate) != null)
      .sort((a, b) => Math.abs(days(input.asOf, a.captured_on) - 7) - Math.abs(days(input.asOf, b.captured_on) - 7) || b.captured_on.localeCompare(a.captured_on))[0];
    if (previous) comparisons.push({ hotelId, previousCapturedOn: previous.captured_on, currentCapturedOn: row.captured_on, previousPrice: rate(previous)!, currentPrice: rate(row)! });
  }
  comparisons.sort((a, b) => a.hotelId.localeCompare(b.hotelId));
  const previousMedian = median(comparisons.map(pair => pair.previousPrice));
  const matchedCurrentMedian = median(comparisons.map(pair => pair.currentPrice));
  const comparisonDays = median(comparisons.map(pair => days(pair.currentCapturedOn, pair.previousCapturedOn))) ?? 0;
  const compression = compressionSignal({ unavailable: currentAvailability.unavailable, observed: currentAvailability.observed, totalCompetitors: comps.length, baseline, baselineDates: compressionSamples.length, leadTime });
  const movement = marketMovementSignal({ previousMedian, currentMedian: matchedCurrentMedian, matchedCompetitors: comparisons.length, totalCompetitors: comps.length, comparisonDays });
  // Signal validity is explicit even if a caller requests beyond the product horizon.
  if (leadTime > movement.leadTimeValid[1]) { movement.confidence = 0; movement.contribution = 0; }
  const signals = [compression, movement];
  const demandScore = demandScoreFromSignals(signals);

  const driftLearned = historyDays >= 30 && driftSamples.length >= 8;
  const expectedDrift = driftLearned ? median(driftSamples.map(sample => sample.fraction))! : 0;
  const forecastMedian = currentMarketMedian == null ? null : product(currentMarketMedian, 1 + expectedDrift);
  const hotelPositionRatio = positionSamples.length >= 3 ? median(positionSamples.map(sample => sample.ratio)) : null;
  const normalRate = normalSamples.length >= 3 ? median(normalSamples.map(sample => sample.price)) : currentMarketMedian != null && hotelPositionRatio != null ? product(currentMarketMedian, hotelPositionRatio) : null;
  const demandMultiplier = 1 + (demandScore - 50) / 50 * 0.15;
  const dispersion = currentMarketMedian == null ? 0 : median(currentPrices.map(p => Math.abs(p / currentMarketMedian - 1))) ?? 0;
  const activeSignals = signals.filter(signal => signal.confidence > 0).length;
  const relativeWidth = clamp(0.1 + Math.min(leadTime, 90) / 90 * 0.2 + clamp(dispersion) * 0.5 + (1 - clamp(historyDays / 60)) * 0.15 + (1 - clamp(currentPrices.length / 6)) * 0.15, 0.1, 0.8);
  const marketLow = forecastMedian == null ? null : product(forecastMedian, 1 - relativeWidth);
  const marketHigh = forecastMedian == null ? null : product(forecastMedian, 1 + relativeWidth);
  // Internal candidates only. Cap each endpoint, including the uncertainty band;
  // cap the center first so an extreme measured position cannot invert the band.
  const candidateCenter = forecastMedian != null && hotelPositionRatio != null ? product(forecastMedian, Math.min(1.25, hotelPositionRatio * demandMultiplier)) : null;
  const candidateCap = forecastMedian == null ? null : product(forecastMedian, 1.25);
  const suggestedLow = candidateCenter != null && candidateCap != null ? Math.min(candidateCap, candidateCenter * (1 - relativeWidth)) : null;
  const suggestedHigh = candidateCenter != null && candidateCap != null ? Math.min(candidateCap, candidateCenter * (1 + relativeWidth)) : null;

  const confidenceReasons: string[] = [];
  let confidence = clamp(currentPrices.length / Math.max(1, comps.length)) * (0.2 + 0.25 * clamp(historyDays / 60) + 0.15 * clamp(pastDates.length / 30) + 0.2 * clamp(currentPrices.length / 6) + 0.1 * activeSignals / 2 + 0.1 * (1 - clamp(leadTime / 90))) * (1 - 0.5 * clamp(dispersion));
  if (historyDays < 30) { confidence = Math.min(confidence, 0.34); confidenceReasons.push(`Only ${historyDays} usable capture days; at least 30 are needed before learning historical drift.`); }
  else if (historyDays < 60) { confidence = Math.min(confidence, 0.59); confidenceReasons.push(`Only ${historyDays} usable capture days; confidence stays at most medium until 60 days of history are available.`); }
  if (pastDates.length < 14) { confidence = Math.min(confidence, 0.34); confidenceReasons.push(`Only ${pastDates.length} distinct past stay dates; repeated captures do not create independent training dates.`); }
  if (currentPrices.length < 4) { confidence = Math.min(confidence, currentPrices.length < 3 ? 0.34 : 0.59); confidenceReasons.push(`Only ${currentPrices.length} of ${comps.length} competitors have fresh usable prices.`); }
  if (leadTime > 45) { confidence = Math.min(confidence, 0.39); confidenceReasons.push(`${leadTime} nights ahead: distant rates and availability can change substantially.`); }
  if (!driftLearned) confidenceReasons.push(`Learned drift is zero: ${driftSamples.length} settled historical pairs are available; at least 8 distinct stay dates and 30 capture days are required.`);
  if (activeSignals < 2) { confidence = Math.min(confidence, activeSignals === 0 ? 0.34 : 0.59); confidenceReasons.push(`${activeSignals} of 2 demand signals have enough evidence to contribute; a neutral score with no signals is an absence of evidence.`); }
  if (dispersion > 0.2) confidenceReasons.push("Competitor prices are widely dispersed, widening the market band.");
  if (quality.staleCurrent) confidenceReasons.push(`${quality.staleCurrent} stale competitor captures were excluded from current signals.`);
  if (hotelPositionRatio == null) confidenceReasons.push("This hotel's usual market position is unmeasured; no property rate candidate is calculated.");
  if (!confidenceReasons.length) confidenceReasons.push(`${historyDays} capture days, ${pastDates.length} historical stay dates and ${currentPrices.length} fresh competitor prices support this estimate.`);
  confidence = clamp(confidence);
  const limitations = [
    "Feed unavailability is not proof that a hotel is sold out; unknown and missing observations are excluded from compression.",
    "The market band is a heuristic allowance for lead time, rate dispersion and missing history, not a calibrated probability interval.",
    "Only compression and matched-competitor price movement are enabled. Events, holidays, weather, flights and PMS calibration are not included.",
    "Retention preserves full captures for about 30 days, then one row per hotel-night; missing historical pairs are not reconstructed.",
    "Property rate candidates are a model estimate, not a validated selling price; treat the suggested range as a starting point for a pricing decision.",
  ];
  return {
    version: 1, hotelId: input.hotelId, checkIn: input.checkIn, asOf: input.asOf, currency: input.currency, leadTime,
    demandScore, currentMarketMedian, forecastMedian, marketLow, marketHigh, normalRate, hotelPositionRatio, demandMultiplier,
    suggestedLow, suggestedHigh, pricingEnabled: false, confidence, confidenceLabel: confidence < 0.4 ? "low" : confidence < 0.75 ? "medium" : "high", confidenceReasons, signals,
    evidence: {
      historyDays, historyCaptureDays: historyDays, historyStayDates: pastDates.length, pricedCompetitors: currentPrices.length, observedCompetitors: currentAvailability.observed, totalCompetitors: comps.length,
      currentCaptureOldest: captureExtent[0], currentCaptureNewest: captureExtent[1], freshnessDays: maxAge, competitors,
      compression: { current: currentAvailability.fraction, baseline, baselineDates: compressionSamples.length, leadBucket: bucket, unavailable: currentAvailability.unavailable, observed: currentAvailability.observed, samples: compressionSamples },
      movement: { fraction: movement.confidence > 0 ? movement.value : null, previousCapturedOn: extent(comparisons.map(pair => pair.previousCapturedOn))[1], currentCapturedOn: extent(comparisons.map(pair => pair.currentCapturedOn))[1], matchedCompetitors: comparisons.length, previousMedian, currentMedian: matchedCurrentMedian, comparisons },
      drift: { expected: expectedDrift, pairs: driftSamples.length, stayDates: driftSamples.length, method: driftLearned ? "Median matched-competitor change from this lead bucket to a capture within two days before check-in; one pair per settled stay date." : "Zero drift until 30 usable capture days and 8 settled stay-date pairs exist.", samples: driftSamples },
      position: { ratio: hotelPositionRatio, samples: positionSamples.length, method: hotelPositionRatio == null ? "Unmeasured: at least three distinct past stay dates with same-day hotel and market prices are required." : "Median hotel-to-market ratio across distinct past stay dates with same-day paired captures.", observations: positionSamples },
      normalRate: { samples: normalSamples.length, method: normalSamples.length >= 3 ? "Median own rate for this weekday from captures within two days before historical check-in." : normalRate != null ? "Current market median multiplied by the measured historical hotel-to-market ratio." : "Unmeasured: insufficient weekday history and no measured hotel-to-market fallback.", observations: normalSamples },
      uncertainty: { relativeWidth, priceDispersion: dispersion, method: "Heuristic width = 10% + lead-time allowance (up to 20%) + half the median relative price dispersion + thin-history allowance (up to 15%) + sparse-competitor allowance (up to 15%); bounded to 10–80%." },
      quality, limitations,
    },
  };
}

export function backtestForecast(input: Omit<ForecastInput, "checkIn"> & { leadTimes?: number[]; maxDates?: number }): BacktestResult {
  const { rows, comps } = cleanSnapshots(input);
  const leadTimes = [...new Set((input.leadTimes ?? [1, 3, 7, 14, 30]).filter(lead => Number.isInteger(lead) && lead > 0 && lead <= 365))].sort((a, b) => a - b);
  const maxDates = Math.max(1, Math.min(180, Math.floor(input.maxDates ?? 90) || 90));
  const index = indexRows(rows);
  const allDates = [...index.keys()].filter(date => date < input.asOf && (index.get(date) ?? []).some(row => comps.includes(row.hotel_id))).sort();
  const dates = allDates.slice(-maxDates);
  const points: BacktestPoint[] = [];
  let missingOutcomes = 0, missingPredictions = 0;
  for (const checkIn of dates) {
    for (const leadTime of leadTimes) {
      const cutoff = addDays(checkIn, -leadTime);
      // Truth must be newly observed after the cutoff. At lead 1, only a
      // check-in-day capture qualifies; yesterday's quote cannot grade itself.
      const outcome = at(index.get(checkIn)!, comps, checkIn, Math.min(2, leadTime - 1));
      const outcomePrices = prices(outcome);
      if (!sufficient(outcomePrices.length, comps.length)) { missingOutcomes++; continue; }
      const actualMedian = median(outcomePrices)!;
      const actualCompression = availability(outcome).fraction;
      // Every baseline, confidence input and training pair receives the cutoff.
      // Passing only cutoff rows also makes a leak through future refactoring hard.
      const forecast = computeForecast({ ...input, snapshots: rows.filter(row => row.captured_on <= cutoff), checkIn, asOf: cutoff });
      if (forecast.forecastMedian == null || forecast.currentMarketMedian == null || forecast.marketLow == null || forecast.marketHigh == null || !sufficient(forecast.evidence.pricedCompetitors, comps.length)) { missingPredictions++; continue; }
      points.push({ cutoff, checkIn, leadTime, predictedMedian: forecast.forecastMedian, actualMedian, baselineMedian: forecast.currentMarketMedian, marketLow: forecast.marketLow, marketHigh: forecast.marketHigh, suggestedLow: forecast.suggestedLow, suggestedHigh: forecast.suggestedHigh, actualCompression, forecastCompression: forecast.evidence.compression.current });
    }
  }
  const byLeadTime = leadTimes.map(leadTime => {
    const group = points.filter(point => point.leadTime === leadTime);
    const suggestions = group.filter(point => point.suggestedLow != null && point.suggestedHigh != null);
    const compression = group.filter(point => point.forecastCompression != null && point.actualCompression != null);
    return { leadTime, samples: group.length, mae: mean(group.map(point => Math.abs(point.predictedMedian - point.actualMedian))), baselineMae: mean(group.map(point => Math.abs(point.baselineMedian - point.actualMedian))), marketCoverage: mean(group.map(point => +(point.actualMedian >= point.marketLow && point.actualMedian <= point.marketHigh))), suggestedCoverage: mean(suggestions.map(point => +(point.actualMedian >= point.suggestedLow! && point.actualMedian <= point.suggestedHigh!))), compressionMae: mean(compression.map(point => Math.abs(point.forecastCompression! - point.actualCompression!))) };
  });
  return {
    version: 1, asOf: input.asOf, currency: input.currency, hotelId: input.hotelId, byLeadTime, points,
    limitations: [
      `Evaluated ${points.length} usable date/lead-time points across ${new Set(points.map(point => point.checkIn)).size} distinct stay dates; fewer than 30 dates per lead time is a small sample.`,
      `Excluded ${missingOutcomes} date/lead-time outcomes that were missing, stale, sparse or already known at cutoff, and ${missingPredictions} predictions without sufficient fresh competitor prices. At least two priced competitors and half the comp set are required.`,
      "Outcomes are the latest observed market quotes at or within two days before check-in, strictly after the forecast cutoff and never after check-in; they are not realized booking rates or occupancy.",
      "Every prediction is rebuilt using captures on or before its cutoff, including all compression baselines, normal rates, hotel position and drift training.",
      "Full captures are retained for about 30 days, then one row per hotel-night. Retention gaps can prevent evaluation, especially at longer lead times; missing history stays missing.",
      "The carry-forward baseline is the market median known at the cutoff. Compression uses persistence of feed unavailability, not a learned occupancy forecast.",
      "Market band coverage is observed historical coverage of a heuristic band, not a promised probability. Hotel candidate-band coverage compares market outcomes with an unvalidated property-position band and is not property-rate accuracy; pricing remains disabled.",
      ...(allDates.length > maxDates ? [`Evaluation is bounded to the most recent ${maxDates} candidate stay dates.`] : []),
    ],
  };
}
