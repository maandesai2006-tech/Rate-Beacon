# Demand Forecast release 1 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Each owner edits only its assigned files; integration and independent review follow.

**Goal:** Ship the brief's steps 1–3: an explainable two-signal demand forecast, evidence drawer, and honest walk-forward evaluation.

**Architecture:** A dependency-free deterministic engine is shared by production and backtesting. Persist its entire result, not only headline numbers. Authenticated requests read through the existing scoped client; the cross-account collector computes after its rate run completes. Future pricing candidates remain experimental, withheld from actionable UI pending evidence. Additional external signals and PMS calibration follow this release, as explicitly sequenced by the brief.

**Tech Stack:** Existing Next.js/React/TypeScript, Supabase Postgres with account RLS, Node strip-types tests. No new AI provider or runtime dependency.

## Interfaces

`src/lib/forecast.ts` exports `ForecastSnapshot`, `ForecastInput`, `Signal`, `DemandForecast`, `BacktestResult`, `computeForecast(input)`, and `backtestForecast(input)`.

`ForecastSnapshot`: hotel_id, check_in, captured_on (ISO date), price (number|null), available (boolean|null), is_anomaly (optional boolean|null), currency (optional string). `ForecastInput`: hotelId, compHotelIds, hotelNames (optional name map), checkIn, asOf, currency, snapshots. Backtest input omits checkIn, adds optional leadTimes (default [1,3,7,14,30]), maxDates (30).

`DemandForecast`: version, hotelId, checkIn, asOf, currency, leadTime, demandScore, currentMarketMedian, forecastMedian, marketLow, marketHigh, normalRate, hotelPositionRatio, demandMultiplier, suggestedLow, suggestedHigh, pricingEnabled (false in release 1), confidence, confidenceLabel, confidenceReasons, signals, evidence (full input rows/curve/learning sample summaries). Null prices/ratios are meaningful missing data. Signal includes the brief's seven fields plus contribution computed by the engine.

`BacktestResult`: version, asOf, currency, hotelId, byLeadTime summaries, points, limitations. Summaries provide leadTime, samples, mae, baselineMae (carry current median forward), marketCoverage, suggestedCoverage, compressionMae. Points carry cutoff, checkIn, leadTime, predictedMedian, actualMedian, marketLow, marketHigh, suggestedLow/High, actualCompression and forecastCompression. Exact type additions may be coordinated by message.

## Task 1: Deterministic engine (engine owner)

Files: `src/lib/forecast.ts`, `src/lib/signals/compression.ts`, `src/lib/signals/market-movement.ts`, `scripts/test-forecast.mjs`.

- [ ] Write and run failing tests for normalization, 50 with no signals, bounds, thin-history confidence, unavailable vs unknown data, currency/anomaly exclusion, stale data, matched competitors, and cutoff leakage.
- [ ] Implement compression relative to observed market history in the same lead bucket; no invented normal for cold starts. Use availability only when observed, label it feed unavailability rather than confirmed bookings.
- [ ] Implement market movement across captures for the same stay date and matched competitors, excluding anomaly rows. Preserve named inputs and capture dates.
- [ ] Learn hotel weekday normal/market ratio and market drift from settled historical stays only, using only captures known by asOf. Drift is zero absent enough examples; intervals widen for sparse/distant/variable evidence. Cap the entire candidate range at 1.25 × forecastMedian and withhold it when hotel position cannot be measured.
- [ ] Reconstruct walk-forward inputs using captured_on <= cutoff. Outcomes use near-check-in captures (never post-stay captures), no future external or PMS data. Require adequate comp coverage; skip missing outcomes explicitly. Retention means missing historical captures cannot be invented. Evaluate only unique dates with sufficient capture history, and report sample counts and a no-drift comparator. Market coverage and hotel-range coverage are separate, neither is a claimed probability.
- [ ] Run `node --experimental-strip-types scripts/test-forecast.mjs` and inspect results.

## Task 2: Storage and application integration (root owner)

Files: `src/lib/forecast-service.ts`, `src/lib/forecast-market.ts`, `src/lib/hydration.ts`, `src/app/api/grid/route.ts`, `src/app/api/forecast/backtest/route.ts`, `src/lib/assistant.ts`, `src/lib/types.ts`, `supabase/migrations/023_demand_forecast.sql`, `scripts/audit-tenant-scope.mjs`, `package.json`.

- [ ] Use the same explicit compset/location/radius selection as grid for forecasts; never substitute every tracked hotel.
- [ ] Add forecast storage with full payload, checks, foreign keys, RLS via app_profile_ids(), and explicit GRANTs. Use the brief's 023 sequential migration convention.
- [ ] Load captures with bounded paginated reads (not PostgREST's default 1000-row truncation), restricted to relevant hotels, currency, capture/stay dates. Return a visible data-limit condition if work cannot be complete.
- [ ] Compute next 45 nights at collection completion after anomaly flagging. Reserve execution budget; preserve retryable forecast progress until all profiles are done. Upsert idempotently and avoid marking forecast success after failure.
- [ ] Attach fresh stored forecasts in grid; do not relabel the old demand score as a new forecast, and avoid old advice thresholds treating neutral 50 as hot. Handle pre-migration/uncomputed forecasts explicitly.
- [ ] Implement authenticated backtest endpoint validating ownership and selected baseline; use the same engine, never current external context.
- [ ] Add assistant demand_forecast tool returning stored evidence. Do not generate new model-calculated prices or confidence. Extend tenant audit with demand_forecasts.
- [ ] Add backend tests for scoped queries, pagination, missing storage, and retry behavior; run with npm test.

## Task 3: Interface (UI owner)

Files: `src/components/Dashboard.tsx`, `src/components/ForecastEvidence.tsx`, `src/components/ForecastBacktest.tsx`.

- [ ] Render a compact demand score button with low/medium/high confidence and an explicit unavailable state. Use consistent new score thresholds wherever displayed.
- [ ] Render accessible evidence drawer directly from stored DemandForecast, including signal contributions, named competitors, timestamps, excluded/missing data and confidence reasons. Show experimental market interval; do not suggest an unvalidated selling range.
- [ ] Add a backtest section reachable from dashboard, with lead-time MAE, carry-forward baseline, market interval coverage and separately labelled experimental hotel-range coverage, sample warnings, and predicted/actual scatter. Provide loading, retry, empty, missing-history states and an accessible textual equivalent to the chart.
- [ ] Check responsive layout and keyboard interaction, baseline/profile changes, and stale fetch handling.

## Task 4: Verification and handoff

- [ ] Independent plan review before implementation and independent spec/correctness review after integration. Resolve material findings.
- [ ] Run `npm test`, `npm run build`, and `git diff --check`.
- [ ] Exercise engine and backtest on read-only live rate data. Record observed coverage, limitations and timing without exposing credentials or report contents.
- [ ] Verify migration locally if Postgres is available; remote migration/deployment only after the reviewable build is ready and appropriately authorized. Explain any unperformed deployment steps.
- [ ] Add release notes with the exact steps 1–3 delivered and steps 4–6 deferred by the brief. Commit the tested release on codex/demand-forecast.
