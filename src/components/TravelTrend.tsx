"use client";

import { useEffect, useState } from "react";

// Whether the market is filling up, from the air.
//
// Arrivals and departures at the nearest airport, day over day or week over
// week. Deliberately small — it sits beside the forecast and answers one
// question at a glance, and the honest caveat travels with it: these are
// flights seen, not passengers, so the movement is the signal.

interface Point {
  label: string;
  arrivals: number;
  departures: number;
}

interface Payload {
  airport?: { icao: string; name: string; milesAway: number };
  grouping?: "day" | "week";
  points?: Point[];
  changePct?: number | null;
  note?: string | null;
  error?: string;
}

export default function TravelTrend({
  profileId,
  baselineHotelId,
}: {
  profileId: number | null;
  baselineHotelId: string | null;
}) {
  const [grouping, setGrouping] = useState<"day" | "week">("day");
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    setFailed(false);
    const qs = new URLSearchParams({ profileId: String(profileId), grouping });
    if (baselineHotelId) qs.set("baselineHotelId", baselineHotelId);

    fetch(`/api/conditions/flights?${qs}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as Payload;
        if (cancelled) return;
        if (!r.ok || j.error) {
          setFailed(true);
          return;
        }
        setData(j);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, baselineHotelId, grouping]);

  // A panel that cannot load says nothing rather than showing an error.
  if (failed) return null;

  const points = data?.points ?? [];
  const max = Math.max(1, ...points.flatMap((p) => [p.arrivals, p.departures]));
  const change = data?.changePct ?? null;

  return (
    <section className="mt-6" aria-label="Travel trend">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="kicker mr-1">Travel into the market</h3>
        {(["day", "week"] as const).map((g) => (
          <button
            key={g}
            onClick={() => setGrouping(g)}
            className="btn-ghost px-3 py-1 text-[12px]"
            aria-pressed={grouping === g}
            style={
              grouping === g
                ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                : undefined
            }
          >
            {g === "day" ? "Day to day" : "Week to week"}
          </button>
        ))}
        {data?.airport && (
          <span className="ml-auto text-[11px]" style={{ color: "var(--text-muted)" }}>
            {data.airport.name} ({data.airport.icao}) · {data.airport.milesAway} mi
          </span>
        )}
      </div>

      <div className="card p-4">
        {points.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            {data?.note ?? "Loading…"}
          </p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span
                className="tabular-nums"
                style={{ font: "600 20px/1.1 var(--font-heading)", color: "var(--text-primary)" }}
              >
                {points[points.length - 1].arrivals.toLocaleString()}
              </span>
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                arrivals {grouping === "day" ? "yesterday" : "last week"}
              </span>
              {change != null && (
                <span
                  className="ml-auto text-[13px] tabular-nums"
                  style={{ color: change >= 0 ? "var(--delta-good-text)" : "var(--status-critical)" }}
                >
                  {change >= 0 ? "+" : ""}
                  {change}% vs {grouping === "day" ? "the day before" : "the week before"}
                </span>
              )}
            </div>

            {/* Paired bars per period: arrivals solid, departures outlined, so
                a market filling up reads as arrivals pulling ahead. */}
            <div className="mt-3 flex h-20 items-end gap-2">
              {points.map((p) => (
                <div key={p.label} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex h-16 w-full items-end justify-center gap-[2px]">
                    <div
                      className="w-1/2 rounded-t"
                      style={{ height: `${Math.max(3, (p.arrivals / max) * 100)}%`, background: "var(--series-1)" }}
                      title={`${p.label}: ${p.arrivals} arrivals`}
                    />
                    <div
                      className="w-1/2 rounded-t"
                      style={{
                        height: `${Math.max(3, (p.departures / max) * 100)}%`,
                        background: "var(--accent-soft)",
                        border: "1px solid var(--series-1)",
                      }}
                      title={`${p.label}: ${p.departures} departures`}
                    />
                  </div>
                  <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                    {p.label}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--series-1)" }} />
                arrivals
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: "var(--accent-soft)", border: "1px solid var(--series-1)" }}
                />
                departures
              </span>
              <span>· flights seen by public receivers, not passengers — the change is the signal</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
