"use client";

// The user-facing home for the demand model: one plain question — how much
// more could this hotel charge than what the compset is already asking — and
// a per-night answer. The hard numbers behind that answer (accuracy against
// past checkouts, raw signal inputs) live one click away, not on this screen;
// someone deciding tonight's rate does not need to read a MAE table first.

import { useMemo, useState } from "react";
import type { GridRow } from "@/lib/types";
import { Metric } from "@/components/Dashboard";
import ForecastBacktest from "@/components/ForecastBacktest";
import { dateLabel, moneyFormatter, percentFormatter } from "@/lib/format";
import { demandPressureLabel } from "@/lib/demand";
import { pricingHeadroom } from "@/lib/forecast-headroom";

type SubTab = "overview" | "accuracy";

export default function DemandForecast({
  rows,
  hotelName,
  currency,
  profileId,
  baselineId,
  onOpenEvidence,
}: {
  rows: GridRow[];
  hotelName: string;
  currency: string;
  profileId: number;
  baselineId: string | null;
  onOpenEvidence: (date: string) => void;
}) {
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const money = useMemo(() => moneyFormatter(currency, 0), [currency]);
  const percent = percentFormatter(0);

  const nights = useMemo(() => rows.filter((row) => row.forecast != null), [rows]);
  const headrooms = useMemo(() => nights.map((row) => pricingHeadroom(row.forecast!)), [nights]);
  const withRoom = headrooms.filter((h) => (h.pct ?? -Infinity) > 0.02).length;
  const measuredPcts = headrooms.map((h) => h.pct).filter((p): p is number => p != null).toSorted((a, b) => a - b);
  const medianHeadroom = measuredPcts.length ? measuredPcts[Math.floor(measuredPcts.length / 2)] : null;

  return (
    <div className="fade">
      <p className="kicker mb-1">Demand forecast</p>
      <h2 className="text-xl">How much more could {hotelName} charge than the compset?</h2>
      <p className="mt-1 max-w-3xl text-sm" style={{ color: "var(--text-secondary)" }}>
        Based on how this hotel has historically priced against the market, and today&apos;s demand signals — competitor availability and matched-competitor rate movement.
      </p>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Demand forecast views">
        {([["overview", "Overview"], ["accuracy", "Model accuracy"]] as [SubTab, string][]).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={subTab === value}
            className="btn-ghost px-3 py-1.5 text-[12px]"
            style={subTab === value ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
            onClick={() => setSubTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {subTab === "overview" ? (
        <div className="mt-4">
          {nights.length === 0 ? (
            <div className="card p-4 text-sm" role="status">Demand forecasts appear here once a collection run finishes for this hotel.</div>
          ) : (
            <>
              <div className="card flex flex-wrap gap-x-8 gap-y-3 p-4">
                <Metric value={String(withRoom)} label={`of ${nights.length} upcoming nights show pricing room`} hint="Nights where the suggested range sits more than 2% above the compset's current median." />
                <Metric value={medianHeadroom == null ? "—" : `${medianHeadroom >= 0 ? "+" : ""}${percent(medianHeadroom)}`} label="median headroom vs. today's compset rate" />
              </div>

              <div className="card mt-4 divide-y overflow-hidden" style={{ borderColor: "var(--border)" }}>
                {nights.map((row) => {
                  const headroom = pricingHeadroom(row.forecast!);
                  return (
                    <button
                      key={row.date}
                      type="button"
                      onClick={() => onOpenEvidence(row.date)}
                      className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left"
                      style={{ borderColor: "var(--gridline)" }}
                      aria-label={`Why? ${dateLabel(row.date)}, demand pressure ${row.forecast!.demandScore} of 100`}
                    >
                      <span>
                        <span className="block text-sm font-semibold">{dateLabel(row.date)}</span>
                        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{demandPressureLabel(row.forecast!.demandScore)} · {row.forecast!.confidenceLabel} confidence</span>
                      </span>
                      <span className="text-right">
                        {headroom.center == null || headroom.basis == null ? (
                          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Not enough data yet</span>
                        ) : (
                          <>
                            <span className="block text-sm font-semibold tabular-nums">
                              {money(headroom.center)}{" "}
                              <span style={{ color: headroom.pct != null && headroom.pct >= 0 ? "var(--delta-good-text)" : "var(--status-warning)" }}>
                                ({headroom.pct != null && headroom.pct >= 0 ? "+" : ""}{percent(headroom.pct)})
                              </span>
                            </span>
                            <span className="text-xs" style={{ color: "var(--text-secondary)" }}>vs. {money(headroom.basis)} compset median</span>
                          </>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 text-xs" style={{ color: "var(--text-secondary)" }}>
                A model estimate, not a guarantee — a starting point for a pricing decision. Open a night for the full evidence behind its number.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="mt-4">
          <ForecastBacktest profileId={profileId} baselineId={baselineId} hotelName={hotelName} />
        </div>
      )}
    </div>
  );
}
