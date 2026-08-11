"use client";

// Charts for the manager's-report history.
//
// Occupancy is a percentage and ADR/RevPAR are money, so they are three
// separate charts rather than one chart with two y-scales — a dual axis lets
// the reader infer a relationship from where the lines happen to cross, which
// is an artefact of the scaling and not a fact about the hotel.
//
// Each chart carries a single series, so it needs no legend (the title names
// it) and no categorical palette: one hue, --series-1, straight from the app's
// tokens in both themes.

import { useCallback, useId, useMemo, useRef, useState } from "react";

export interface ChartPoint {
  date: string;
  value: number;
}

const PAD = { top: 12, right: 14, bottom: 22, left: 46 };

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const rawStep = span / count;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Line chart with a crosshair and tooltip. A chart in a browser is an
 * interactive object; shipping one without a hover layer throws away the only
 * way to read an exact value off it.
 */
export function TrendLine({
  title,
  points,
  format,
  height = 190,
  zeroBased = false,
}: {
  title: string;
  points: ChartPoint[];
  format: (n: number) => string;
  height?: number;
  zeroBased?: boolean;
}) {
  const gradientId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(640);

  const measure = useCallback((node: HTMLDivElement | null) => {
    wrapRef.current = node;
    if (!node) return;
    const set = () => setWidth(Math.max(280, node.clientWidth));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(node);
  }, []);

  const geom = useMemo(() => {
    const clean = points.filter((p) => Number.isFinite(p.value));
    if (clean.length === 0) return null;
    const values = clean.map((p) => p.value);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (zeroBased) lo = Math.min(0, lo);
    if (lo === hi) {
      lo = lo - Math.max(1, Math.abs(lo) * 0.05);
      hi = hi + Math.max(1, Math.abs(hi) * 0.05);
    } else {
      const pad = (hi - lo) * 0.12;
      lo -= pad;
      hi += pad;
    }
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    const x = (i: number) =>
      PAD.left + (clean.length === 1 ? innerW / 2 : (i / (clean.length - 1)) * innerW);
    const y = (v: number) => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH;
    return { clean, lo, hi, x, y, innerW, innerH };
  }, [points, width, height, zeroBased]);

  if (!geom) {
    return (
      <figure className="m-0">
        <figcaption className="kicker mb-2">{title}</figcaption>
        <div
          className="flex items-center justify-center rounded-lg text-xs"
          style={{ height, border: "1px dashed var(--gridline)", color: "var(--text-muted)" }}
        >
          Not reported
        </div>
      </figure>
    );
  }

  const { clean, lo, hi, x, y } = geom;
  const line = clean.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ");
  const area = `${line} L${x(clean.length - 1).toFixed(2)},${(height - PAD.bottom).toFixed(2)} L${x(0).toFixed(2)},${(height - PAD.bottom).toFixed(2)} Z`;
  const ticks = niceTicks(lo, hi);
  const active = hover != null ? clean[hover] : null;

  // Only the endpoints get a date label; a label under every point is noise.
  const xLabels = clean.length > 1 ? [0, clean.length - 1] : [0];

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < clean.length; i++) {
      const d = Math.abs(x(i) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  }

  return (
    <figure className="m-0" ref={measure}>
      <figcaption className="kicker mb-2">{title}</figcaption>
      <div className="relative">
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${title}: ${clean.length} reports from ${clean[0].date} to ${clean[clean.length - 1].date}`}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          style={{ display: "block", overflow: "visible" }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Recessive gridlines, behind the data */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--gridline)"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 8}
                y={y(t)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize="10"
                fill="var(--text-muted)"
              >
                {format(t)}
              </text>
            </g>
          ))}

          <path d={area} fill={`url(#${gradientId})`} />
          <path
            d={line}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* A single point would otherwise draw nothing visible. */}
          {clean.length === 1 && (
            <circle cx={x(0)} cy={y(clean[0].value)} r="4" fill="var(--series-1)" />
          )}

          {xLabels.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={height - 6}
              textAnchor={i === 0 ? "start" : "end"}
              fontSize="10"
              fill="var(--text-muted)"
            >
              {shortDate(clean[i].date)}
            </text>
          ))}

          {active && hover != null && (
            <g pointerEvents="none">
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={height - PAD.bottom}
                stroke="var(--baseline)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              {/* A surface ring keeps the marker legible over the line. */}
              <circle cx={x(hover)} cy={y(active.value)} r="5" fill="var(--surface)" />
              <circle cx={x(hover)} cy={y(active.value)} r="4" fill="var(--series-1)" />
            </g>
          )}
        </svg>

        {active && hover != null && (
          <div
            className="pointer-events-none absolute z-10 rounded-md px-2.5 py-1.5 text-xs"
            style={{
              left: `${Math.min(Math.max((x(hover) / width) * 100, 4), 78)}%`,
              top: 0,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow)",
              whiteSpace: "nowrap",
            }}
          >
            <div style={{ color: "var(--text-muted)" }}>{shortDate(active.date)}</div>
            <div className="tabular-nums font-semibold" style={{ color: "var(--text-primary)" }}>
              {format(active.value)}
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}

/** Magnitude by category — one hue, direct-labelled, no legend. */
export function WeekdayBars({
  title,
  data,
  format,
}: {
  title: string;
  data: { label: string; value: number | null }[];
  format: (n: number) => string;
}) {
  const max = Math.max(...data.map((d) => d.value ?? 0), 1);
  return (
    <figure className="m-0">
      <figcaption className="kicker mb-2">{title}</figcaption>
      <div className="flex h-[150px] items-end gap-2">
        {data.map((d) => (
          <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
            <span
              className="text-[10px] tabular-nums"
              style={{ color: d.value == null ? "var(--text-muted)" : "var(--text-secondary)" }}
            >
              {d.value == null ? "—" : format(d.value)}
            </span>
            <div
              className="w-full rounded-t"
              style={{
                height: d.value == null ? 3 : `${Math.max(4, (d.value / max) * 100)}%`,
                background: d.value == null ? "var(--gridline)" : "var(--series-1)",
                minHeight: 3,
              }}
              title={`${d.label}: ${d.value == null ? "not reported" : format(d.value)}`}
            />
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              {d.label}
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}
