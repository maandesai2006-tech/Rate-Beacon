"use client";

// Plain-language forecast at each of your own hotels, matching whichever range
// the map's timeline is set to. Data is Open-Meteo — free, keyless, one request
// covering every hotel.
//
// Deliberately simple: a row per hotel, a card per hour or per day. No chart,
// because the question this answers is "what is it doing at my property on
// Thursday", and a strip of readings answers that faster than a plot.

import { useEffect, useState } from "react";

export type ForecastRange = "12h" | "24h" | "7d";

interface ForecastPoint {
  time: string;
  code: number | null;
  temperature: number | null;
  temperatureMin: number | null;
  precipitationChance: number | null;
  windSpeed: number | null;
}

interface HotelForecastRow {
  hotelId: string;
  name: string;
  points: ForecastPoint[];
}

/**
 * WMO weather codes, which is what Open-Meteo reports. Grouped to the
 * distinctions a hotel actually cares about — is it wet, is it violent, can
 * people be outside — rather than reproducing all 28 codes.
 */
function describe(code: number | null): { label: string; glyph: string } {
  if (code == null) return { label: "—", glyph: "·" };
  if (code === 0) return { label: "Clear", glyph: "☀" };
  if (code <= 2) return { label: "Partly cloudy", glyph: "⛅" };
  if (code === 3) return { label: "Overcast", glyph: "☁" };
  if (code <= 48) return { label: "Fog", glyph: "≡" };
  if (code <= 57) return { label: "Drizzle", glyph: "☂" };
  if (code <= 67) return { label: "Rain", glyph: "☂" };
  if (code <= 77) return { label: "Snow", glyph: "❄" };
  if (code <= 82) return { label: "Showers", glyph: "☂" };
  if (code <= 86) return { label: "Snow showers", glyph: "❄" };
  return { label: "Thunderstorm", glyph: "⚡" };
}

function label(iso: string, range: ForecastRange): string {
  const d = new Date(range === "7d" ? `${iso}T12:00:00` : iso);
  if (range === "7d") return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
}

function temp(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)}°`;
}

export default function HotelForecast({
  profileId,
  range,
}: {
  profileId: number | null;
  range: ForecastRange;
}) {
  const [rows, setRows] = useState<HotelForecastRow[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    setBusy(true);
    fetch(`/api/map/forecast?profileId=${profileId}&range=${range}`)
      .then((r) => r.json())
      .then((j: { hotels?: HotelForecastRow[]; note?: string; error?: string }) => {
        if (cancelled) return;
        setRows(j.hotels ?? []);
        setNote(j.error ?? j.note ?? null);
      })
      .catch((e) => {
        if (!cancelled) setNote((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, range]);

  const heading =
    range === "7d" ? "Next 7 days" : range === "24h" ? "Next 24 hours" : "Next 12 hours";

  return (
    <section className="mt-6" aria-label="Forecast at your hotels">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="kicker">Forecast at your hotels</h3>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {heading} · Open-Meteo
        </span>
      </div>

      {busy && !rows && (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Loading forecast…
        </p>
      )}

      {note && (
        <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
          {note}
        </p>
      )}

      <div className="space-y-3">
        {(rows ?? []).map((hotel) => (
          <div key={hotel.hotelId} className="card p-4">
            <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                {hotel.name}
              </span>
              <Summary points={hotel.points} range={range} />
            </div>

            {hotel.points.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                No forecast returned for this location.
              </p>
            ) : (
              <div className="-mx-1 overflow-x-auto pb-1">
                <div className="flex gap-1.5 px-1">
                  {hotel.points.map((p) => {
                    const d = describe(p.code);
                    const wet = (p.precipitationChance ?? 0) >= 40;
                    return (
                      <div
                        key={p.time}
                        className="shrink-0 rounded-lg px-2.5 py-2 text-center"
                        style={{
                          minWidth: 62,
                          background: "var(--surface-2)",
                          border: "1px solid var(--border)",
                        }}
                        title={`${d.label}${
                          p.windSpeed != null ? ` · wind ${Math.round(p.windSpeed)} mph` : ""
                        }`}
                      >
                        <div
                          className="text-[10px] uppercase tracking-[0.06em]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {label(p.time, range)}
                        </div>
                        <div className="my-0.5 text-base leading-none" aria-hidden>
                          {d.glyph}
                        </div>
                        <div
                          className="text-[13px] font-semibold tabular-nums"
                          style={{ color: "var(--text-primary)" }}
                        >
                          {temp(p.temperature)}
                          {p.temperatureMin != null && (
                            <span
                              className="ml-1 font-normal"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {temp(p.temperatureMin)}
                            </span>
                          )}
                        </div>
                        <div
                          className="text-[10px] tabular-nums"
                          style={{
                            color: wet ? "var(--accent)" : "var(--text-muted)",
                            fontWeight: wet ? 600 : 400,
                          }}
                        >
                          {p.precipitationChance == null ? "—" : `${p.precipitationChance}%`}
                        </div>
                        <span className="sr-only">{d.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {rows != null && rows.length === 0 && !note && (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          No hotels with coordinates yet.
        </p>
      )}
    </section>
  );
}

/** The one line a manager would actually read: how hot, and will it rain. */
function Summary({ points, range }: { points: ForecastPoint[]; range: ForecastRange }) {
  const temps = points.map((p) => p.temperature).filter((t): t is number => t != null);
  const lows = points.map((p) => p.temperatureMin).filter((t): t is number => t != null);
  const rain = points.map((p) => p.precipitationChance).filter((t): t is number => t != null);
  if (temps.length === 0) return null;

  const hi = Math.round(Math.max(...temps));
  const lo = Math.round(lows.length ? Math.min(...lows) : Math.min(...temps));
  const maxRain = rain.length ? Math.max(...rain) : null;
  const wetPeriods = rain.filter((r) => r >= 40).length;

  return (
    <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
      {lo}°–{hi}°F
      {maxRain != null && maxRain >= 40
        ? ` · rain likely in ${wetPeriods} of ${points.length} ${range === "7d" ? "days" : "hours"}, peaking at ${maxRain}%`
        : maxRain != null
          ? ` · rain chance stays under ${Math.max(maxRain, 1)}%`
          : ""}
    </span>
  );
}
