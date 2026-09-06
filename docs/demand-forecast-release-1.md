# Demand Forecast release 1

Implemented the supplied brief's steps 1–3: compression relative to the market's historical lead-time bucket, matched-competitor rate movement, stored deterministic forecasts, a demand column/evidence drawer, and walk-forward validation with an unchanged-median comparator. The existing assistant can read the stored evidence. No new model, API key or PMS connection is required by the engine.

## Current state

Code is on `codex/demand-forecast`. Canonical local checkout: `/Users/maandesai/.codex/workspaces/RateBeacon-forecast`. Documents-based working copies were replaced for verification because macOS offloaded their files and stalled Git/build reads.

The production database and Vercel deployment have not been changed by this release. Apply `supabase/migrations/023_demand_forecast.sql` before deploying the application. This adds forecast storage with authenticated own-account SELECT only, explicit grants, and a retry cursor on collection runs. The existing collector automatically starts the forecast stage on an already-completed rate run, and resumes individual hotels across ticks. Forecasts cover at most 45 nights.

## Evidence from the real data

Read-only validation on September 6, 2026 exported 18,577 shared rate observations through the existing Supabase connection. Validation used each baseline's exact configured/location-filtered/radius-filtered compset, excluding anomalous, stale, missing, or wrong-currency observations. No manager reports were read or written.

| Market | Usable capture days | Configured competitors | Nights with a priced market forecast | One-night-ahead backtest |
| --- | ---: | ---: | ---: | --- |
| Holiday Inn Express, Destin | 34 | 2 | 44 of 45 | 28 samples; median-price MAE $5.59 |
| Candlewood Suites, Pensacola | 36 | 15 | 45 of 45 | 29 samples; median-price MAE $3.66 |

Across lead times 1, 3, 7, 14 and 30, there were 51 and 54 eligible date/lead-time comparisons respectively. Shared dates across lead times are not independent samples. Each market had only two 30-night comparisons. Outcomes are later observed asking prices, not achieved ADR, occupancy or revenue.

One-night forecasts matched the unchanged-median baseline; most longer-lead forecasts also matched it. These results do not demonstrate a pricing advantage. All observed outcomes fell inside the broad experimental market bands, which is not a calibrated confidence probability. Actionable selling-price suggestions remain disabled. Confidence is capped at low below 30 capture days, medium below 60, and low with fewer than three priced competitors.

Replacing post-cutoff rates with extreme contradictory values left reconstructed predictions and their evidence unchanged in both live markets. Runtime for 45 forecasts was approximately 0.3 seconds for Destin and 1.5 seconds for Pensacola; historical evaluation took under one second each, excluding database reads.

## Verification

- `npm test`: existing regressions plus 21 engine scenarios and storage/pagination/scope/retry tests.
- `npm run build`: production compilation and TypeScript validation.
- `supabase/tests/demand_forecasts_rls.sql`: passed on isolated PostgreSQL 16 using the supplied minimal predecessor-schema fixture; own-account read allowed, other-account/anonymous access denied, authenticated writes denied, service writes allowed, constraints and cascade tested. Everything in the RLS test rolls back.
- `scripts/check-forecast-live.mjs`: reproducible read-only validation, accepts an ignored exported JSON fixture or a configured server environment.
- Browser-based visual QA and production migration/deployment remain to be performed. Existing npm audit reports seven high-severity findings in the baseline dependency tree; dependencies were not changed in this release.

## Deliberately deferred under the brief's sequence

Additional event/holiday/weather/airport/seasonality signals, actionable property selling ranges, and PMS calibration/accuracy comparisons follow this first validated release. Ticketmaster still requires a key. Airport observations are never supplied to historical evaluation. Property candidate bands are explicitly experimental and do not measure property-rate accuracy.

Historical membership changes are not reconstructed; backtests use the current selected compset. Full daily captures are retained for about 30 days, after which retention can remove historical pairs. Missing observations stay missing. The current demand weights and market uncertainty bands are interpretable heuristics, not trained probability estimates.
