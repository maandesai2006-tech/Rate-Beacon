"use client";

import { useEffect, useId, useRef } from "react";
import type { DemandForecast } from "@/lib/forecast";

function dateLabel(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function pressureLabel(score: number) {
  return score >= 65 ? "Higher pressure" : score <= 35 ? "Lower pressure" : "Near neutral";
}

export function DemandScoreButton({ forecast, date, onOpen }: {
  forecast?: DemandForecast | null;
  date: string;
  onOpen: () => void;
}) {
  if (!forecast) {
    return <span className="inline-block min-w-24 text-[11px]" style={{ color: "var(--text-secondary)" }} title="A stored forecast will appear after a completed collection run has usable observations for this date.">
      Needs forecast data
    </span>;
  }

  return (
    <button
      type="button"
      className="btn-ghost flex-col items-start gap-1 px-2 py-1 text-xs"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Why? Demand pressure ${forecast.demandScore} of 100 for ${dateLabel(date)}. ${pressureLabel(forecast.demandScore)}. ${forecast.confidenceLabel} confidence.`}
    >
      <span className="inline-flex items-center gap-2">
        <span className="min-w-7 text-right tabular-nums">{forecast.demandScore}</span>
        <span className="relative inline-block h-1.5 w-12 overflow-hidden rounded-full" style={{ background: "var(--gridline)" }} aria-hidden="true">
          <span className="block h-full" style={{ width: `${forecast.demandScore}%`, background: "var(--series-1)" }} />
          <span className="absolute inset-y-0 left-1/2 w-px" style={{ background: "var(--text-secondary)" }} />
        </span>
        <span style={{ color: "var(--accent)" }}>Why?</span>
      </span>
      <span className="text-[10px] font-normal capitalize" style={{ color: "var(--text-secondary)" }}>{forecast.confidenceLabel} confidence</span>
    </button>
  );
}

const SIGNAL_NAMES: Record<string, string> = {
  compression: "Competitor availability", movement: "Market rate movement", market_movement: "Market rate movement",
  event: "Events", events: "Events", holiday: "Holiday window", weather: "Weather",
  airport: "Airport traffic", airport_traffic: "Airport traffic", seasonality: "Learned weekday pattern",
};

export default function ForecastEvidence({ forecast, hotelName, onClose }: {
  forecast: DemandForecast;
  hotelName: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { evidence } = forecast;
  const moneyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: forecast.currency, maximumFractionDigits: 2 });
  const money = (value: number | null) => value == null ? "Not available" : moneyFormat.format(value);
  const percent = (value: number | null) => value == null ? "Not available" : new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 }).format(value);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  return (
    <>
      <style>{`.forecast-evidence::backdrop { background: rgb(0 0 0 / 45%); }`}</style>
      <dialog
        ref={dialogRef}
        className="forecast-evidence slide-in fixed inset-y-0 right-0 w-full max-w-2xl overflow-y-auto border-l p-0"
        style={{ height: "100dvh", maxHeight: "100dvh", margin: "0 0 0 auto", background: "var(--surface)", color: "var(--text-primary)", borderColor: "var(--border)", boxShadow: "var(--shadow-lg)" }}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => { event.preventDefault(); onClose(); }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
        }}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <div>
            <p className="kicker mb-1">Forecast evidence · experimental</p>
            <h2 id={titleId} className="text-xl">Why this demand score?</h2>
            <p id={descriptionId} className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{hotelName} · {dateLabel(forecast.checkIn)}</p>
          </div>
          <button type="button" autoFocus className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose}>Close</button>
        </div>

        <div className="space-y-6 p-5 text-[13px]">
          <section aria-label="Demand pressure and confidence">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-semibold tabular-nums">{forecast.demandScore}<span className="text-base font-normal" style={{ color: "var(--text-secondary)" }}>/100</span></span>
              <span>{pressureLabel(forecast.demandScore)}</span>
              <span className="rounded px-2 py-1 text-xs capitalize" style={{ background: "var(--surface-2)" }}>{forecast.confidenceLabel} confidence</span>
            </div>
            <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>50 is neutral. Higher pressure starts at 65; lower pressure is 35 or below. This measures pressure in advertised rates and feed availability, not occupancy.</p>
            <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>As of {forecast.asOf} · {forecast.leadTime} nights before check-in · model version {forecast.version}</p>
            <ul className="mt-3 list-disc space-y-1 pl-4" aria-label="Confidence reasons">
              {forecast.confidenceReasons.map((reason, index) => <li key={index}>{reason}</li>)}
            </ul>
          </section>

          <section aria-labelledby={`${titleId}-signals`}>
            <h3 id={`${titleId}-signals`} className="text-lg">What contributes to the score</h3>
            <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>The engine starts at 50, adds these stored contributions and bounds the result to 0–100. A zero contribution means that signal adds no pressure.</p>
            <ul className="mt-3 divide-y" style={{ borderColor: "var(--border)" }}>
              {forecast.signals.map((signal) => (
                <li key={signal.key} className="py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h4 className="text-base">{SIGNAL_NAMES[signal.key] ?? signal.key.replaceAll("_", " ")}</h4>
                    <span className="whitespace-nowrap font-semibold tabular-nums">{signal.contribution > 0 ? "+" : ""}{signal.contribution.toLocaleString("en-US", { maximumFractionDigits: 2 })} points</span>
                  </div>
                  <p className="mt-1" style={{ color: "var(--text-secondary)" }}>{signal.evidence}</p>
                  <details className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                    <summary className="cursor-pointer">Exact signal inputs</summary>
                    <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
                      <dt>Measured value</dt><dd>{signal.value}</dd>
                      <dt>Normalized value (−1 to 1)</dt><dd>{signal.normalized}</dd>
                      <dt>Weight</dt><dd>{signal.weight}</dd>
                      <dt>Signal trust coefficient (0 to 1)</dt><dd>{signal.confidence}</dd>
                      <dt>Exact contribution in points</dt><dd>{signal.contribution}</dd>
                      <dt>Valid lead time</dt><dd>{signal.leadTimeValid[0]}–{signal.leadTimeValid[1]} nights</dd>
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby={`${titleId}-market`} className="rounded-lg p-4" style={{ background: "var(--surface-2)" }}>
            <h3 id={`${titleId}-market`} className="text-lg">Experimental market projection</h3>
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
              <dt>Current competitor median</dt><dd className="text-right tabular-nums">{money(forecast.currentMarketMedian)}</dd>
              <dt>Forecast competitor median</dt><dd className="text-right tabular-nums">{money(forecast.forecastMedian)}</dd>
              <dt>Market dispersion band</dt><dd className="text-right tabular-nums">{forecast.marketLow == null || forecast.marketHigh == null ? "Not available" : `${money(forecast.marketLow)}–${money(forecast.marketHigh)}`}</dd>
              <dt>Hotel&apos;s typical weekday rate</dt><dd className="text-right tabular-nums">{money(forecast.normalRate)}</dd>
              <dt>Measured hotel / market ratio</dt><dd className="text-right tabular-nums">{forecast.hotelPositionRatio ?? "Not available"}</dd>
            </dl>
            <p className="mt-3 text-xs" style={{ color: "var(--text-secondary)" }}>The band describes possible market rates using a heuristic spread; it has no claimed probability. It is not a recommended selling range. Forecast pricing recommendations are not enabled in this release.</p>
          </section>

          <section aria-labelledby={`${titleId}-captures`}>
            <h3 id={`${titleId}-captures`} className="text-lg">Competitors and captures used</h3>
            <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{evidence.pricedCompetitors} priced · {evidence.observedCompetitors} observed · {evidence.totalCompetitors} in the competitive set. Current captures: {evidence.currentCaptureOldest ?? "none"} to {evidence.currentCaptureNewest ?? "none"}.</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[470px] text-left text-xs">
                <caption className="sr-only">Stored competitor observations for {forecast.checkIn}</caption>
                <thead><tr style={{ borderBottom: "1px solid var(--border)" }}><th scope="col" className="py-2 pr-3">Competitor</th><th scope="col" className="pr-3">Capture</th><th scope="col" className="pr-3">Rate</th><th scope="col">Feed status</th></tr></thead>
                <tbody>{evidence.competitors.map((competitor) => <tr key={competitor.hotelId} style={{ borderBottom: "1px solid var(--gridline)" }}>
                  <th scope="row" className="py-2 pr-3 font-normal"><span className="block">{competitor.name}</span><span className="text-[10px]" style={{ color: "var(--text-secondary)" }}>{competitor.hotelId}</span></th>
                  <td className="whitespace-nowrap pr-3">{competitor.capturedOn ?? "No capture"}{competitor.ageDays != null && <span className="block" style={{ color: "var(--text-secondary)" }}>{competitor.ageDays} days old</span>}</td>
                  <td className="whitespace-nowrap pr-3 tabular-nums">{money(competitor.price)}</td>
                  <td className="capitalize">{competitor.status}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>Unavailable means the feed returned no availability; it does not establish that a hotel is sold out. Missing, unknown and stale observations are identified separately.</p>
          </section>

          <section aria-labelledby={`${titleId}-method`}>
            <h3 id={`${titleId}-method`} className="text-lg">History and calculation provenance</h3>
            <dl className="mt-3 space-y-3">
              <div><dt className="font-semibold">History available</dt><dd>{evidence.historyDays} days, {evidence.historyCaptureDays} capture dates, {evidence.historyStayDates} stay dates.</dd></div>
              <div><dt className="font-semibold">Availability comparison</dt><dd>{evidence.compression.unavailable} unavailable of {evidence.compression.observed} observed. Current {percent(evidence.compression.current)}, usual {percent(evidence.compression.baseline)}, from {evidence.compression.baselineDates} dates at {evidence.compression.leadBucket[0]}–{evidence.compression.leadBucket[1]} nights out.</dd></div>
              <div><dt className="font-semibold">Matched market movement</dt><dd>{percent(evidence.movement.fraction)} across {evidence.movement.matchedCompetitors} matched competitors. {evidence.movement.previousCapturedOn ?? "No previous capture"}: {money(evidence.movement.previousMedian)}; {evidence.movement.currentCapturedOn ?? "no current capture"}: {money(evidence.movement.currentMedian)}.</dd></div>
              <div><dt className="font-semibold">Learned drift</dt><dd>{percent(evidence.drift.expected)} · {evidence.drift.pairs} pairs across {evidence.drift.stayDates} stay dates. {evidence.drift.method}</dd></div>
              <div><dt className="font-semibold">Hotel position</dt><dd>{evidence.position.samples} samples. {evidence.position.method}</dd></div>
              <div><dt className="font-semibold">Typical weekday rate</dt><dd>{evidence.normalRate.samples} samples. {evidence.normalRate.method}</dd></div>
              <div><dt className="font-semibold">Market band</dt><dd>Relative width: {percent(evidence.uncertainty.relativeWidth)}. {evidence.uncertainty.method}</dd></div>
              <div><dt className="font-semibold">Data exclusions</dt><dd>{evidence.quality.excludedAnomaly} anomalies; {evidence.quality.excludedCurrency} wrong-currency rows; {evidence.quality.excludedInvalid} invalid rows; {evidence.quality.excludedAfterCheckIn} captures after check-in; {evidence.quality.staleCurrent} stale current observations.</dd></div>
            </dl>
          </section>

          <section aria-labelledby={`${titleId}-limits`}>
            <h3 id={`${titleId}-limits`} className="text-lg">Limits of this forecast</h3>
            <ul className="mt-3 list-disc space-y-1 pl-4">{evidence.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
          </section>

          <details className="rounded border p-3 text-xs" style={{ borderColor: "var(--border)" }}>
            <summary className="cursor-pointer font-semibold">Full stored evidence and exact calculation values</summary>
            <p className="mt-2" style={{ color: "var(--text-secondary)" }}>Includes capture-level samples. Experimental hotel candidate fields are diagnostic model values, not selling recommendations.</p>
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(forecast, null, 2)}</pre>
          </details>
        </div>
      </dialog>
    </>
  );
}
