"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { BacktestResult } from "@/lib/forecast";
import { moneyFormatter, percentFormatter } from "@/lib/format";

type LoadState =
  | { status: "loading"; context: string }
  | { status: "error"; context: string; message: string }
  | { status: "ready"; context: string; result: BacktestResult };

export default function ForecastBacktest({ profileId, baselineId, hotelName }: {
  profileId: number;
  baselineId: string | null;
  hotelName: string;
}) {
  const [retry, setRetry] = useState(0);
  const [leadTime, setLeadTime] = useState("all");
  const context = `${profileId}:${baselineId ?? ""}`;
  const [state, setState] = useState<LoadState>({ status: "loading", context });
  const leadId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", context });
    setLeadTime("all");
    if (!baselineId) return () => controller.abort();

    async function load() {
      try {
        const query = new URLSearchParams({ profileId: String(profileId), baselineId: baselineId! });
        const response = await fetch(`/api/forecast/backtest?${query}`, { signal: controller.signal });
        const payload = await response.json() as { backtest?: BacktestResult; error?: string };
        if (!response.ok) throw new Error(payload.error ?? `Backtest could not be loaded (${response.status}).`);
        if (!payload.backtest || payload.backtest.version !== 1 || !Array.isArray(payload.backtest.byLeadTime) || !Array.isArray(payload.backtest.points)) {
          throw new Error("The server returned an incomplete backtest. Please retry.");
        }
        if (!controller.signal.aborted) setState({ status: "ready", context, result: payload.backtest });
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: "error", context, message: error instanceof Error ? error.message : "Backtest could not be loaded." });
      }
    }
    void load();
    return () => controller.abort();
  }, [profileId, baselineId, context, retry]);

  const result = state.context === context && state.status === "ready" ? state.result : null;
  const money = useMemo(() => moneyFormatter(result?.currency ?? "USD"), [result?.currency]);
  const percent = percentFormatter(1);
  const selected = result?.byLeadTime.filter((row) => leadTime === "all" || String(row.leadTime) === leadTime) ?? [];
  const points = result?.points.filter((point) => leadTime === "all" || String(point.leadTime) === leadTime) ?? [];
  const smallSamples = selected.filter((row) => row.samples > 0 && row.samples < 30);

  return (
    <section className="card fade p-4 sm:p-5" aria-labelledby="forecast-backtest-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="forecast-backtest-title" className="text-lg">How did the forecast compare with the market?</h2>
          <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{hotelName} · past check-in dates reconstructed from the captures available at each forecast cutoff. Each forecast uses only captures on or before its cutoff; the comparison is the final observed competitor median, not this hotel&apos;s achieved rate or occupancy.</p>
        </div>
        <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setRetry((value) => value + 1)} disabled={!baselineId || state.status === "loading"}>Refresh backtest</button>
      </div>

      {!baselineId ? (
        <p className="mt-5 text-sm" role="status">Choose a baseline hotel to evaluate its market forecast.</p>
      ) : state.context !== context || state.status === "loading" ? (
        <p className="mt-5 text-sm" role="status" aria-live="polite" style={{ color: "var(--text-secondary)" }}>Reconstructing forecasts from historical captures…</p>
      ) : state.status === "error" ? (
        <div className="mt-5 rounded border p-4" role="alert" style={{ borderColor: "var(--status-critical)" }}>
          <p className="font-semibold">The backtest could not be loaded</p>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{state.message}</p>
          <button type="button" className="btn-ghost mt-3 px-3 py-1.5 text-xs" onClick={() => setRetry((value) => value + 1)}>Retry</button>
        </div>
      ) : result && (
        <>
          <p className="mt-4 text-xs" style={{ color: "var(--text-secondary)" }}>Evaluated as of {result.asOf} · all monetary figures in {result.currency} · model version {result.version}</p>

          {result.points.length === 0 ? (
            <div className="mt-4 rounded-lg p-4" role="status" style={{ background: "var(--surface-2)" }}>
              <h3 className="text-lg">More captured history is needed</h3>
              <p className="mt-2 text-sm">There are no eligible forecast / final-market pairs yet. A past stay date needs a capture before the selected lead time and a usable final observation. Longer lead times take longer to become testable.</p>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <label htmlFor={leadId} className="text-xs font-semibold">Lead time</label>
              <select id={leadId} className="input max-w-56" value={leadTime} onChange={(event) => setLeadTime(event.target.value)}>
                <option value="all">All evaluated lead times</option>
                {result.byLeadTime.map((row) => <option key={row.leadTime} value={row.leadTime}>{row.leadTime} nights before check-in</option>)}
              </select>
            </div>
          )}

          {smallSamples.length > 0 && (
            <div className="mt-4 rounded-lg border p-3 text-sm" role="note" style={{ borderColor: "var(--status-warning)", background: "var(--surface-2)" }}>
              <strong>Small samples: results are preliminary.</strong>{" "}
              {smallSamples.map((row) => `${row.leadTime}-night lead: ${row.samples} sample${row.samples === 1 ? "" : "s"}`).join("; ")}. Each has fewer than 30 observations. Shared stay dates across lead times are not independent evidence, and these results do not establish reliable accuracy.
            </div>
          )}

          {selected.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[940px] border-collapse text-left text-xs">
                <caption className="pb-2 text-left text-sm font-semibold">Accuracy and observed coverage by lead time</caption>
                <thead><tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                  <th scope="col" className="p-3">Nights out</th>
                  <th scope="col" className="p-3">Samples</th>
                  <th scope="col" className="p-3">Forecast MAE</th>
                  <th scope="col" className="p-3">Carry-forward MAE</th>
                  <th scope="col" className="p-3">Market band coverage</th>
                  <th scope="col" className="p-3">Suggested-range coverage <span className="block font-normal">See Demand Forecast overview</span></th>
                  <th scope="col" className="p-3">Unavailable-share MAE</th>
                </tr></thead>
                <tbody>{selected.map((row) => <tr key={row.leadTime} style={{ borderBottom: "1px solid var(--gridline)" }}>
                  <th scope="row" className="p-3 font-normal">{row.leadTime}</th>
                  <td className="p-3 tabular-nums">{row.samples}{row.samples === 0 && <span className="block" style={{ color: "var(--text-secondary)" }}>Needs history</span>}</td>
                  <td className="p-3 tabular-nums">{money(row.mae)}</td>
                  <td className="p-3 tabular-nums">{money(row.baselineMae)}</td>
                  <td className="p-3 tabular-nums">{percent(row.marketCoverage)}</td>
                  <td className="p-3 tabular-nums">{percent(row.suggestedCoverage)}</td>
                  <td className="p-3 tabular-nums">{row.compressionMae == null ? "—" : `${percent(row.compressionMae).replace("%", "")} pp`}</td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
          <p className="mt-3 max-w-4xl text-xs" style={{ color: "var(--text-secondary)" }}>MAE is mean absolute error in {result.currency}; lower means closer to the final observed market median. Market band coverage counts final medians inside the market dispersion band. Suggested-range coverage checks that same market median against the hotel-specific range shown on the Demand Forecast overview; it does not validate a hotel selling price, only how often the market landed inside it. Coverage is observed frequency, not confidence. “pp” means percentage points; “—” means no eligible measurements.</p>

          {result.points.length > 0 && points.length === 0 && <p className="mt-5 text-sm" role="status">No eligible observations at this lead time yet.</p>}
          {points.length > 0 && (
            <>
              <ForecastScatter points={points} currency={result.currency} />
              <details className="mt-4 rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                <summary className="cursor-pointer text-sm font-semibold">View {points.length} predicted and actual observations</summary>
                <div className="mt-3 max-h-[440px] overflow-auto">
                  <table className="w-full min-w-[1000px] border-collapse text-left text-xs">
                    <caption className="sr-only">Data behind the predicted versus actual chart</caption>
                    <thead><tr style={{ background: "var(--surface-2)" }}>
                      <th scope="col" className="p-2">Check-in</th><th scope="col" className="p-2">Forecast cutoff</th><th scope="col" className="p-2">Nights out</th>
                      <th scope="col" className="p-2">Predicted median</th><th scope="col" className="p-2">Actual median</th><th scope="col" className="p-2">Carry-forward median</th>
                      <th scope="col" className="p-2">Market band</th><th scope="col" className="p-2">Forecast / actual unavailable share</th>
                    </tr></thead>
                    <tbody>{points.map((point) => <tr key={`${point.cutoff}:${point.checkIn}:${point.leadTime}`} style={{ borderBottom: "1px solid var(--gridline)" }}>
                      <th scope="row" className="whitespace-nowrap p-2 font-normal">{point.checkIn}</th><td className="whitespace-nowrap p-2">{point.cutoff}</td><td className="p-2">{point.leadTime}</td>
                      <td className="p-2 tabular-nums">{money(point.predictedMedian)}</td><td className="p-2 tabular-nums">{money(point.actualMedian)}</td><td className="p-2 tabular-nums">{money(point.baselineMedian)}</td>
                      <td className="whitespace-nowrap p-2 tabular-nums">{money(point.marketLow)}–{money(point.marketHigh)}</td>
                      <td className="p-2 tabular-nums">{percent(point.forecastCompression)} / {percent(point.actualCompression)}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              </details>
            </>
          )}

          {result.limitations.length > 0 && <div className="mt-5">
            <h3 className="text-lg">What this test can and cannot tell us</h3>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs" style={{ color: "var(--text-secondary)" }}>{result.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
          </div>}
        </>
      )}
    </section>
  );
}

function ForecastScatter({ points, currency }: { points: BacktestResult["points"]; currency: string }) {
  const chartId = useId();
  // This is chart geometry only. Forecast values and accuracy measurements are
  // consumed unchanged from the deterministic engine's backtest response.
  const maximum = Math.max(1, ...points.flatMap((point) => [point.predictedMedian, point.actualMedian])) * 1.05;
  const x = (value: number) => 90 + value / maximum * 490;
  const y = (value: number) => 340 - value / maximum * 300;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => maximum * fraction);
  const format = moneyFormatter(currency, 0);

  return (
    <figure className="mt-5 max-w-3xl" aria-labelledby={`${chartId}-title`}>
      <figcaption id={`${chartId}-title`} className="text-sm font-semibold">Predicted vs final observed market median</figcaption>
      <p id={`${chartId}-description`} className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{points.length} forecast observations. The diagonal marks equal predicted and actual values; points above it mean the market finished higher than predicted. The table below contains every plotted observation.</p>
      <svg className="mt-3 h-auto w-full" viewBox="0 0 640 405" role="img" aria-labelledby={`${chartId}-title`} aria-describedby={`${chartId}-description`}>
        {ticks.map((tick, index) => <g key={index}>
          <line x1="90" y1={y(tick)} x2="580" y2={y(tick)} stroke="var(--gridline)" />
          <line x1={x(tick)} y1="40" x2={x(tick)} y2="340" stroke="var(--gridline)" />
          <text x="80" y={y(tick) + 4} textAnchor="end" fill="var(--text-secondary)" fontSize="11">{format(tick)}</text>
          <text x={x(tick)} y="360" textAnchor="middle" fill="var(--text-secondary)" fontSize="11">{format(tick)}</text>
        </g>)}
        <line x1="90" y1="340" x2="580" y2="40" stroke="var(--text-muted)" strokeDasharray="5 4" />
        {points.map((point) => <circle key={`${point.cutoff}:${point.checkIn}:${point.leadTime}`} cx={x(point.predictedMedian)} cy={y(point.actualMedian)} r="4" fill="var(--series-1)" opacity="0.65">
          <title>{point.checkIn}, {point.leadTime} nights out: predicted {format(point.predictedMedian)}, actual {format(point.actualMedian)}</title>
        </circle>)}
        <text x="335" y="392" textAnchor="middle" fill="var(--text-secondary)" fontSize="12">Predicted market median ({currency})</text>
        <text x="17" y="190" transform="rotate(-90 17 190)" textAnchor="middle" fill="var(--text-secondary)" fontSize="12">Actual market median ({currency})</text>
      </svg>
    </figure>
  );
}
