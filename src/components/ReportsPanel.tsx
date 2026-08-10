"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Insight {
  id: string;
  title: string;
  value: string;
  detail: string;
  direction: "good" | "bad" | "neutral";
}

interface ReportHotel {
  hotelId: string;
  name: string;
  reportCount: number;
  latestDate: string | null;
  points: { date: string; metrics: Record<string, number> }[];
  insights: Insight[];
}

const TONE: Record<Insight["direction"], string> = {
  good: "var(--delta-good-text)",
  bad: "var(--status-critical)",
  neutral: "var(--text-secondary)",
};

export default function ReportsPanel({
  profileId,
  hotels,
}: {
  profileId: number | null;
  hotels: { hotel_id: string; name: string }[];
}) {
  const [data, setData] = useState<{ inboxToken: string; hotels: ReportHotel[] } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pickHotel, setPickHotel] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!profileId) return;
    const res = await fetch(`/api/reports/list?profileId=${profileId}`);
    if (!res.ok) return;
    const j = await res.json();
    setData(j);
    setActive((cur) => cur ?? j.hotels?.[0]?.hotelId ?? null);
  }, [profileId]);

  useEffect(() => {
    load();
  }, [load]);

  async function upload(file: File) {
    if (!profileId) return;
    setBusy(true);
    setMsg(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("profileId", String(profileId));
      if (pickHotel) form.set("hotelId", pickHotel);
      const res = await fetch("/api/reports/upload", { method: "POST", body: form });
      const j = await res.json();
      if (j.error) {
        setMsg(j.error);
      } else {
        setMsg(
          `Saved ${file.name}: ${j.metrics} metric${j.metrics === 1 ? "" : "s"} for ${j.reportDate}, matched by ${j.matchedBy}.`
        );
        await load();
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const current = data?.hotels.find((h) => h.hotelId === active) ?? null;

  return (
    <div>
      {/* Ingestion */}
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-[260px] flex-1">
          <div className="kicker">Add a report</div>
          <p className="mt-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
            Upload the manager&apos;s report as CSV, TSV or text — or forward the
            email automatically to the address below.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,.text,.eml,.htm,.html"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy || !profileId}
              className="btn-accent px-4 py-2 text-[13px]"
            >
              {busy ? "Reading…" : "Upload report"}
            </button>
            <select
              value={pickHotel}
              onChange={(e) => setPickHotel(e.target.value)}
              className="btn-ghost px-2.5 py-2 text-[12px]"
              title="Leave on auto unless the hotel is detected wrongly"
            >
              <option value="">Detect hotel automatically</option>
              {hotels.map((h) => (
                <option key={h.hotel_id} value={h.hotel_id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
          {msg && (
            <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
              {msg}
            </p>
          )}
        </div>

        <div className="min-w-[260px] flex-1">
          <div className="kicker">Forward by email</div>
          <p className="mt-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
            Point any inbound-email service at{" "}
            <code>/api/reports/inbound</code> and use this token as the address
            tag. Reports arriving there are parsed and filed automatically.
          </p>
          <code
            className="mt-2 block rounded px-2.5 py-2 text-[12px]"
            style={{ background: "var(--surface-2)", color: "var(--text-primary)" }}
          >
            reports+{data?.inboxToken ?? "…"}@your-domain
          </code>
        </div>
      </div>

      {/* Hotels holding reports */}
      {data && data.hotels.length > 0 ? (
        <>
          <div className="mt-6 flex flex-wrap gap-1.5">
            {data.hotels.map((h) => (
              <button
                key={h.hotelId}
                onClick={() => setActive(h.hotelId)}
                className="btn-ghost px-3 py-1.5 text-[12px]"
                style={
                  h.hotelId === active
                    ? {
                        borderColor: "var(--accent)",
                        background: "var(--accent-soft)",
                        color: "var(--accent)",
                      }
                    : undefined
                }
              >
                {h.name}
                <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {h.reportCount}
                </span>
              </button>
            ))}
          </div>

          {current && (
            <>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {current.insights.map((i) => (
                  <div key={i.id} className="card p-4">
                    <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {i.title}
                    </div>
                    <div
                      className="mt-1 tabular-nums"
                      style={{ font: "600 24px/1.1 var(--font-heading)", color: TONE[i.direction] }}
                    >
                      {i.value}
                    </div>
                    <p className="mt-1.5 text-xs leading-snug" style={{ color: "var(--text-secondary)" }}>
                      {i.detail}
                    </p>
                  </div>
                ))}
              </div>

              <MetricChart points={current.points} />
            </>
          )}
        </>
      ) : (
        <p className="mt-6 text-sm" style={{ color: "var(--text-muted)" }}>
          No manager&apos;s reports yet. Upload one to see the analysis.
        </p>
      )}
    </div>
  );
}

// Occupancy, ADR and RevPAR over the reported history.
function MetricChart({ points }: { points: { date: string; metrics: Record<string, number> }[] }) {
  const [metric, setMetric] = useState<"revpar" | "adr" | "occupancy">("revpar");
  const series = points
    .filter((p) => p.metrics[metric] != null)
    .map((p) => ({ date: p.date, value: p.metrics[metric] }));

  if (series.length < 2) {
    return (
      <p className="mt-5 text-xs" style={{ color: "var(--text-muted)" }}>
        Two or more reports are needed to chart a trend.
      </p>
    );
  }

  const W = 900;
  const H = 240;
  const padL = 52;
  const padB = 28;
  const padT = 14;
  const values = series.map((s) => s.value);
  const lo = Math.min(...values) * 0.92;
  const hi = Math.max(...values) * 1.08;
  const x = (i: number) => padL + (i / (series.length - 1)) * (W - padL - 14);
  const y = (v: number) => H - padB - ((v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const d = series.map((s, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join(" ");
  const fmtY = (v: number) =>
    metric === "occupancy"
      ? `${v.toFixed(0)}%`
      : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["revpar", "adr", "occupancy"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMetric(m)}
            className="btn-ghost px-3 py-1 text-[12px]"
            style={
              m === metric
                ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                : undefined
            }
          >
            {m === "revpar" ? "RevPAR" : m === "adr" ? "ADR" : "Occupancy"}
          </button>
        ))}
      </div>
      <div className="mt-3 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" role="img" aria-label={`${metric} across reported days`}>
          {[0, 1, 2, 3].map((k) => {
            const v = lo + ((k + 1) / 4) * (hi - lo);
            return (
              <g key={k}>
                <line x1={padL} y1={y(v)} x2={W - 14} y2={y(v)} stroke="var(--gridline)" strokeWidth="1" />
                <text x={padL - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
                  {fmtY(v)}
                </text>
              </g>
            );
          })}
          <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
          {series.map((s, i) => (
            <circle key={s.date} cx={x(i)} cy={y(s.value)} r="3.5" fill="var(--accent)">
              <title>{`${s.date}: ${fmtY(s.value)}`}</title>
            </circle>
          ))}
          {series.map((s, i) =>
            i % Math.max(1, Math.round(series.length / 8)) === 0 ? (
              <text key={`x${s.date}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
                {s.date.slice(5)}
              </text>
            ) : null
          )}
        </svg>
      </div>
    </div>
  );
}
