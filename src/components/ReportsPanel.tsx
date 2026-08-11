"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TrendLine, WeekdayBars } from "./ReportCharts";

type Severity = "critical" | "warning" | "info" | "positive";

interface Insight {
  flag_type: string;
  message: string;
  severity: Severity;
  metric_key: string | null;
  observed: number | null;
  threshold: number | null;
}

/** One night, as stored in daily_manager_reports. */
type Point = { date: string } & Record<string, number | null | string>;

interface ReportHotel {
  hotelId: string;
  name: string;
  reportCount: number;
  firstDate: string | null;
  latestDate: string | null;
  extractor: string | null;
  confidence: number | null;
  points: Point[];
  insights: Insight[];
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  positive: 3,
};

const SEVERITY_STYLE: Record<Severity, { label: string; color: string }> = {
  critical: { label: "Critical", color: "var(--status-critical)" },
  warning: { label: "Warning", color: "var(--status-warning)" },
  info: { label: "Note", color: "var(--accent)" },
  positive: { label: "Positive", color: "var(--status-good)" },
};

const money = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n);
const moneyAxis = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const percent = (n: number) => `${n.toFixed(1)}%`;
const percentAxis = (n: number) => `${n.toFixed(0)}%`;

function num(p: Point, key: string): number | null {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function seriesOf(points: Point[], key: string) {
  return points
    .map((p) => ({ date: p.date, value: num(p, key) }))
    .filter((s): s is { date: string; value: number } => s.value != null);
}

export default function ReportsPanel({
  profileId,
  hotels,
}: {
  profileId: number | null;
  hotels: { hotel_id: string; name: string }[];
}) {
  const [data, setData] = useState<{ inboxToken: string; hotels: ReportHotel[] } | null>(null);
  // null means "all my hotels" — the overview across every property
  // holding reports, which is what the tab opens on.
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pickHotel, setPickHotel] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [mail, setMail] = useState<{
    host: string;
    port: number;
    username: string;
    mailbox: string;
    subject_filter: string | null;
    from_filter: string | null;
    last_sync_at: string | null;
    last_status: string | null;
  } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    host: "imap.one.com",
    port: 993,
    username: "",
    password: "",
    mailbox: "INBOX",
    subjectFilter: "",
  });
  const [mailBusy, setMailBusy] = useState(false);
  const [mailMsg, setMailMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profileId) return;
    const res = await fetch(`/api/reports/list?profileId=${profileId}`);
    if (!res.ok) return;
    const j = await res.json();
    setData(j);
    // Deliberately not auto-selecting a hotel: the overview comes first.
  }, [profileId]);

  const loadMail = useCallback(async () => {
    if (!profileId) return;
    const res = await fetch(`/api/reports/email?profileId=${profileId}`);
    if (!res.ok) return;
    const j = await res.json();
    setMail(j.source ?? null);
    if (j.source) setShowForm(false);
  }, [profileId]);

  useEffect(() => {
    load();
    loadMail();
  }, [load, loadMail]);

  async function connectMail() {
    if (!profileId) return;
    setMailBusy(true);
    setMailMsg(null);
    try {
      const res = await fetch("/api/reports/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, profileId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not connect");
      setMailMsg(j.detail ?? "Connected.");
      setForm((f) => ({ ...f, password: "" }));
      await loadMail();
      await syncMail();
    } catch (e) {
      setMailMsg((e as Error).message);
    } finally {
      setMailBusy(false);
    }
  }

  async function syncMail() {
    if (!profileId) return;
    setMailBusy(true);
    // A mailbox holding years of reports takes more than one 60-second
    // function call, so keep resuming until the server says it is done.
    let scanned = 0;
    let filed = 0;
    let firstSkip: string | null = null;
    try {
      for (let pass = 0; pass < 200; pass++) {
        const res = await fetch(`/api/reports/email/sync?profileId=${profileId}`, {
          method: "POST",
        });
        const j = await res.json();
        if (j.error) {
          setMailMsg(j.error);
          break;
        }
        scanned += j.scanned ?? 0;
        filed += j.filed ?? 0;
        if (!firstSkip && j.skipped?.length) firstSkip = j.skipped[0];
        setMailMsg(
          `Checked ${scanned} message${scanned === 1 ? "" : "s"}, filed ${filed} report${filed === 1 ? "" : "s"}${
            j.hasMore ? " — still working through the mailbox…" : "."
          }` + (firstSkip ? ` Skipped: ${firstSkip}` : "")
        );
        if (!j.hasMore) break;
      }
      await load();
      await loadMail();
    } catch (e) {
      setMailMsg((e as Error).message);
    } finally {
      setMailBusy(false);
    }
  }

  async function disconnectMail() {
    if (!profileId) return;
    await fetch(`/api/reports/email?profileId=${profileId}`, { method: "DELETE" });
    setMail(null);
    setMailMsg(null);
  }

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

  const current = data?.hotels.find((h) => h.hotelId === focus) ?? null;

  return (
    <div>
      {/* Ingestion */}
      <div className="card rise mt-4 flex flex-wrap items-start gap-4 p-5">
        <div className="min-w-[260px] flex-1">
          <div className="kicker">Add a report</div>
          <p className="mt-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
            Upload the manager&apos;s report — PDF, CSV or text. Or connect the
            mailbox once and every new report files itself.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.csv,.tsv,.txt,.text,.eml,.htm,.html"
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

        <div className="min-w-[300px] flex-1">
          <div className="kicker">Automatic collection</div>
          {mail ? (
            <>
              <p className="mt-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                Connected to <b>{mail.username}</b> on {mail.host}. New reports
                are collected daily; nothing else to do.
              </p>
              {mail.last_status && (
                <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                  {mail.last_sync_at
                    ? `Last checked ${new Date(mail.last_sync_at).toLocaleString()} — `
                    : ""}
                  {mail.last_status}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={syncMail} disabled={mailBusy} className="btn-accent px-3 py-1.5 text-[13px]">
                  {mailBusy ? "Checking…" : "Check now"}
                </button>
                <button onClick={() => setShowForm(true)} className="btn-ghost px-3 py-1.5 text-[13px]">
                  Change
                </button>
                <button onClick={disconnectMail} className="btn-ghost px-3 py-1.5 text-[13px]">
                  Disconnect
                </button>
              </div>
            </>
          ) : (
            <p className="mt-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
              Connect the mailbox that receives the manager&apos;s reports once,
              and every new one is collected, read and filed automatically.
              Works with one.com, Gmail, Outlook — anything with IMAP.
            </p>
          )}

          {(showForm || !mail) && (
            <div className="mt-3 grid gap-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  Mail server
                  <input
                    className="input mt-1 text-[13px]"
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                    placeholder="imap.one.com"
                  />
                </label>
                <label className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  Port
                  <input
                    type="number"
                    className="input mt-1 text-[13px]"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                Email address
                <input
                  className="input mt-1 text-[13px]"
                  autoComplete="off"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="reports@yourhotel.com"
                />
              </label>
              <label className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                Password
                <input
                  type="password"
                  className="input mt-1 text-[13px]"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </label>
              <label className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                Only messages whose subject contains (optional)
                <input
                  className="input mt-1 text-[13px]"
                  value={form.subjectFilter}
                  onChange={(e) => setForm({ ...form, subjectFilter: e.target.value })}
                  placeholder="Manager Report"
                />
              </label>
              <button
                onClick={connectMail}
                disabled={mailBusy || !form.host || !form.username || !form.password}
                className="btn-accent mt-1 px-4 py-2 text-[13px]"
              >
                {mailBusy ? "Connecting…" : "Connect mailbox"}
              </button>
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                The password is encrypted before it is stored and is only used to
                read this mailbox. A dedicated or app-specific password is best.
              </p>
            </div>
          )}

          {mailMsg && (
            <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
              {mailMsg}
            </p>
          )}
        </div>
      </div>

      {/* Visuals and analyses. The focus picker floats above them so the
          hotel can be changed without scrolling back up. */}
      {data && data.hotels.length > 0 ? (
        <>
          <FocusHeader
            hotels={data.hotels}
            focus={focus}
            onChange={setFocus}
          />

          {current ? (
            <HotelReport hotel={current} />
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.hotels.map((h) => (
                <HotelSummary key={h.hotelId} hotel={h} onOpen={() => setFocus(h.hotelId)} />
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="mt-6 text-sm" style={{ color: "var(--text-muted)" }}>
          No manager&apos;s reports yet. Upload one, or connect the mailbox, to
          see the analysis.
        </p>
      )}
    </div>
  );
}

// ── Focus picker ──────────────────────────────────────────────────────────
// Sticks below the app header so the hotel can be changed at any scroll
// position. "All hotels" is a real choice, not an empty state: it is the
// overview across every property holding reports.
function FocusHeader({
  hotels,
  focus,
  onChange,
}: {
  hotels: ReportHotel[];
  focus: string | null;
  onChange: (id: string | null) => void;
}) {
  const chip = (on: boolean) =>
    on
      ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
      : undefined;

  return (
    <div
      className="sticky z-20 -mx-1 mt-6 flex flex-wrap items-center gap-1.5 px-1 py-2.5"
      style={{
        top: 64,
        background: "color-mix(in srgb, var(--page) 88%, transparent)",
        backdropFilter: "blur(8px)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span className="kicker mr-1" style={{ color: "var(--text-muted)" }}>
        Focus
      </span>
      <button
        onClick={() => onChange(null)}
        className="btn-ghost px-3 py-1.5 text-[12px]"
        style={chip(focus == null)}
      >
        All hotels
      </button>
      {hotels.map((h) => (
        <button
          key={h.hotelId}
          onClick={() => onChange(h.hotelId)}
          className="btn-ghost px-3 py-1.5 text-[12px]"
          style={chip(h.hotelId === focus)}
          title={`${h.reportCount} report${h.reportCount === 1 ? "" : "s"} held`}
        >
          {h.name}
          <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
            {h.reportCount}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Overview card, one per hotel ──────────────────────────────────────────
function HotelSummary({ hotel, onOpen }: { hotel: ReportHotel; onOpen: () => void }) {
  const latest = hotel.points[hotel.points.length - 1] ?? null;
  const prior = hotel.points[hotel.points.length - 2] ?? null;
  const counts = hotel.insights.reduce<Record<Severity, number>>(
    (acc, i) => ({ ...acc, [i.severity]: (acc[i.severity] ?? 0) + 1 }),
    { critical: 0, warning: 0, info: 0, positive: 0 }
  );

  const delta = (key: string): number | null => {
    const a = latest ? num(latest, key) : null;
    const b = prior ? num(prior, key) : null;
    if (a == null || b == null || b === 0) return null;
    return ((a - b) / b) * 100;
  };

  const kpi = (label: string, key: string, fmt: (n: number) => string) => {
    const v = latest ? num(latest, key) : null;
    const d = delta(key);
    return (
      <div>
        <div className="text-[10px] uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>
          {label}
        </div>
        <div
          className="tabular-nums"
          style={{ font: "600 20px/1.15 var(--font-heading)", color: v == null ? "var(--text-muted)" : "var(--text-primary)" }}
        >
          {v == null ? "—" : fmt(v)}
        </div>
        {d != null && (
          <div
            className="text-[11px] tabular-nums"
            style={{ color: d >= 0 ? "var(--status-good)" : "var(--status-critical)" }}
          >
            {d >= 0 ? "+" : ""}
            {d.toFixed(1)}%
          </div>
        )}
      </div>
    );
  };

  return (
    <button
      onClick={onOpen}
      className="card card--lift p-4 text-left"
      style={{ display: "block", width: "100%" }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {hotel.name}
        </span>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {hotel.latestDate ?? "no reports"}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        {kpi("Occupancy", "occupancy_percent", percent)}
        {kpi("ADR", "adr", money)}
        {kpi("RevPAR", "revpar", money)}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
        {(["critical", "warning", "info", "positive"] as Severity[])
          .filter((s) => counts[s] > 0)
          .map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: SEVERITY_STYLE[s].color }}
                aria-hidden
              />
              <span style={{ color: "var(--text-secondary)" }}>
                {counts[s]} {SEVERITY_STYLE[s].label.toLowerCase()}
              </span>
            </span>
          ))}
        {hotel.insights.length === 0 && (
          <span style={{ color: "var(--text-muted)" }}>Nothing flagged</span>
        )}
        <span className="ml-auto" style={{ color: "var(--accent)" }}>
          Open
        </span>
      </div>
    </button>
  );
}

// ── One hotel in full ─────────────────────────────────────────────────────
function HotelReport({ hotel }: { hotel: ReportHotel }) {
  const points = hotel.points;
  const latest = points[points.length - 1] ?? null;
  const prior = points[points.length - 2] ?? null;

  const insights = useMemo(
    () => [...hotel.insights].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    [hotel.insights]
  );

  // RevPAR by weekday, averaged across everything held. Magnitude by
  // category, so bars rather than a line.
  const weekday = useMemo(() => {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const buckets = new Map<number, number[]>();
    for (const p of points) {
      const v = num(p, "revpar");
      if (v == null) continue;
      const d = new Date(`${p.date}T00:00:00Z`).getUTCDay();
      buckets.set(d, [...(buckets.get(d) ?? []), v]);
    }
    return [1, 2, 3, 4, 5, 6, 0].map((d) => {
      const vals = buckets.get(d) ?? [];
      return {
        label: names[d],
        value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      };
    });
  }, [points]);

  const delta = (key: string): number | null => {
    const a = latest ? num(latest, key) : null;
    const b = prior ? num(prior, key) : null;
    if (a == null || b == null || b === 0) return null;
    return ((a - b) / b) * 100;
  };

  const Kpi = ({ label, metric: k, fmt, note }: { label: string; metric: string; fmt: (n: number) => string; note?: string }) => {
    const v = latest ? num(latest, k) : null;
    const d = delta(k);
    return (
      <div className="card p-4">
        <div className="kicker">{label}</div>
        <div
          className="mt-1.5 tabular-nums"
          style={{ font: "600 28px/1.1 var(--font-heading)", color: v == null ? "var(--text-muted)" : "var(--text-primary)" }}
        >
          {v == null ? "—" : fmt(v)}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-2 text-xs">
          {d != null && (
            <span
              className="tabular-nums font-medium"
              style={{ color: d >= 0 ? "var(--status-good)" : "var(--status-critical)" }}
            >
              {d >= 0 ? "+" : ""}
              {d.toFixed(1)}% vs previous
            </span>
          )}
          {note && <span style={{ color: "var(--text-muted)" }}>{note}</span>}
        </div>
      </div>
    );
  };

  const soldNote =
    latest && num(latest, "rooms_sold") != null && num(latest, "rooms_available") != null
      ? `${num(latest, "rooms_sold")} of ${num(latest, "rooms_available")} rooms`
      : undefined;

  return (
    <div className="mt-4">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}>
          {hotel.name}
        </h3>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {hotel.reportCount} report{hotel.reportCount === 1 ? "" : "s"}
          {hotel.firstDate && hotel.latestDate ? `, ${hotel.firstDate} to ${hotel.latestDate}` : ""}
          {hotel.extractor ? ` · read by ${hotel.extractor}` : ""}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Occupancy" metric="occupancy_percent" fmt={percent} note={soldNote} />
        <Kpi label="ADR" metric="adr" fmt={money} note="Average daily rate" />
        <Kpi label="RevPAR" metric="revpar" fmt={money} note="Revenue per available room" />
      </div>

      {/* Three measures on two different scales, so three charts. Putting
          occupancy and money on one pair of axes would invite reading the
          crossings as meaning something. */}
      <div className="card mt-4 grid gap-6 p-5 lg:grid-cols-2">
        <TrendLine title="Occupancy" points={seriesOf(points, "occupancy_percent")} format={percentAxis} />
        <TrendLine title="ADR" points={seriesOf(points, "adr")} format={moneyAxis} />
        <TrendLine title="RevPAR" points={seriesOf(points, "revpar")} format={moneyAxis} />
        <TrendLine title="Room revenue" points={seriesOf(points, "room_revenue")} format={moneyAxis} zeroBased />
      </div>

      <div className="card mt-4 p-5">
        <WeekdayBars title="Average RevPAR by weekday" data={weekday} format={moneyAxis} />
      </div>

      <div className="mt-6">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Daily insights &amp; manager&rsquo;s report analysis
          </h4>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {insights.length} of 15 checks flagged for {hotel.latestDate}
          </span>
        </div>
        {insights.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            All fifteen checks passed, or their inputs were not on this report.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {insights.map((f) => {
              const style = SEVERITY_STYLE[f.severity] ?? SEVERITY_STYLE.info;
              return (
                <li
                  key={f.flag_type}
                  className="card p-4"
                  style={{ borderLeft: `3px solid ${style.color}` }}
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span
                      className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                      style={{ color: style.color }}
                    >
                      {style.label}
                    </span>
                    <span className="text-[11px] uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>
                      {f.flag_type.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: "var(--text-primary)" }}>
                    {f.message}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="card mt-6 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Date", "Occupancy", "ADR", "RevPAR", "Room revenue", "Rooms sold"].map((h, i) => (
                <th
                  key={h}
                  className={`px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] ${i === 0 ? "text-left" : "text-right"}`}
                  style={{ color: "var(--text-muted)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...points].reverse().slice(0, 30).map((p) => (
              <tr key={p.date} style={{ borderTop: "1px solid var(--gridline)" }}>
                <td className="px-4 py-2" style={{ color: "var(--text-primary)" }}>
                  {p.date}
                </td>
                {(
                  [
                    ["occupancy_percent", percent],
                    ["adr", money],
                    ["revpar", money],
                    ["room_revenue", money],
                  ] as const
                ).map(([k, fmt]) => {
                  const v = num(p, k);
                  return (
                    <td
                      key={k}
                      className="px-4 py-2 text-right tabular-nums"
                      style={{ color: v == null ? "var(--text-muted)" : "var(--text-secondary)" }}
                    >
                      {v == null ? "—" : fmt(v)}
                    </td>
                  );
                })}
                <td
                  className="px-4 py-2 text-right tabular-nums"
                  style={{ color: num(p, "rooms_sold") == null ? "var(--text-muted)" : "var(--text-secondary)" }}
                >
                  {num(p, "rooms_sold") ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
