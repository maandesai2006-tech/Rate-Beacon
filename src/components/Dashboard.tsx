"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { GridResponse, GridRow, HistoryPoint, Hotel } from "@/lib/types";
import Sparkline from "@/components/Sparkline";

type GridPayload = (GridResponse & { configured: true }) | { configured: false };

interface ProfileStub {
  id: number;
  name: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function binOf(price: number | null, mkt: number | null): string {
  if (price == null || mkt == null || mkt === 0) return "bin-na";
  const pct = ((price - mkt) / mkt) * 100;
  if (pct <= -15) return "bin--2";
  if (pct <= -5) return "bin--1";
  if (pct < 5) return "bin-0";
  if (pct < 15) return "bin-1";
  return "bin-2";
}

function dateLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

interface TooltipState {
  x: number;
  y: number;
  lines: string[];
}

type Tab = "grid" | "trends" | "ladder";

export default function Dashboard() {
  const [profiles, setProfiles] = useState<ProfileStub[]>([]);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [data, setData] = useState<GridPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("grid");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [drawerDate, setDrawerDate] = useState<string | null>(null);
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    fetch("/api/profiles")
      .then((r) => r.json())
      .then((j) => {
        const list: ProfileStub[] = j.profiles ?? [];
        setProfiles(list);
        if (list.length > 0) setProfileId((cur) => cur ?? list[0].id);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const qs = profileId ? `?profileId=${profileId}` : "";
      const res = await fetch(`/api/grid${qs}`);
      const text = await res.text();
      let j: GridPayload & { error?: string };
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(
          `The server returned an unexpected ${res.status} response. This usually means environment variables are missing on the deployment — in Vercel, check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set for Production, then redeploy.`
        );
      }
      if (!res.ok) throw new Error(j.error ?? `Failed to load (${res.status})`);
      setData(j);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [profileId]);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const text = await res.text();
      let j: { rowsWritten?: number; errors?: string[]; error?: string };
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(`server returned ${res.status} — try again, or check the Vercel function logs`);
      }
      if (!res.ok) throw new Error(j.error ?? "Refresh failed");
      setRefreshMsg(
        j.errors?.length
          ? `Fetched with ${j.errors.length} error(s): ${j.errors[0]}`
          : `Fetched ${j.rowsWritten} rates.`
      );
      await load();
    } catch (e) {
      setRefreshMsg(`Refresh failed: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function saveMyRate(date: string) {
    if (!profileId) return;
    const price = editValue.trim() === "" ? null : Number(editValue);
    if (price != null && (Number.isNaN(price) || price < 0)) return;
    setEditingDate(null);
    await fetch("/api/my-rates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId, checkIn: date, price }),
    });
    await load();
  }

  const fmt = useMemo(() => {
    const currency = data && data.configured ? data.profile.currency : "USD";
    const f = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    });
    return (n: number) => f.format(n);
  }, [data]);

  if (error) {
    return (
      <Shell>
        <div className="card mt-10 p-6" style={{ borderColor: "var(--status-critical)" }}>
          <h2 className="font-semibold">Something went wrong</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            {error}
          </p>
        </div>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell>
        <p className="mt-10 text-sm" style={{ color: "var(--text-muted)" }}>
          Loading…
        </p>
      </Shell>
    );
  }

  if (!data.configured) {
    return (
      <Shell>
        <div className="card mt-10 p-8 text-center">
          <h2 className="text-lg font-semibold">Welcome to Rate Beacon</h2>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--text-secondary)" }}>
            Create a hotel profile: pick the baseline hotel and the competitor
            set to shop against, night by night.
          </p>
          <Link href="/setup" className="btn-accent mt-5 inline-block px-5 py-2.5">
            Create a profile →
          </Link>
        </div>
      </Shell>
    );
  }

  const { profile, hotels, rows, weekdayAvg, lastCapturedAt } = data;
  const myHotel = hotels.find((h) => h.is_mine) ?? null;
  const comps = hotels.filter((h) => !h.is_mine);
  const hasAnyData = rows.some((r) => r.compCount > 0 || r.soldOutCount > 0);

  const next30 = rows.slice(0, 30);
  const parityRows = rows.filter((r) => r.signals?.parity != null);
  const stats = {
    raise: rows.filter((r) => r.advice === "raise").length,
    high: rows.filter((r) => r.advice === "review_high").length,
    hot: rows.filter((r) => (r.demand ?? 0) >= 40).length,
    parityCount: parityRows.length,
    parityAvg: parityRows.length
      ? parityRows.reduce((a, r) => a + (r.signals.parity?.undercut ?? 0), 0) / parityRows.length
      : null,
    avg30: (() => {
      const m = next30.filter((r) => r.median != null).map((r) => r.median as number);
      return m.length ? m.reduce((a, b) => a + b, 0) / m.length : null;
    })(),
  };
  const maxWeekday = Math.max(1, ...weekdayAvg.map((w) => w.avgMedian ?? 0));
  const drawerRow = drawerDate ? rows.find((r) => r.date === drawerDate) ?? null : null;

  return (
    <Shell
      header={
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <div className="flex items-center gap-2">
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-base"
                style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
                aria-hidden
              >
                ◆
              </span>
              {profiles.length > 1 ? (
                <select
                  value={profileId ?? profiles[0]?.id}
                  onChange={(e) => setProfileId(Number(e.target.value))}
                  className="btn-ghost px-2 py-1.5 text-lg font-semibold"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <h1 className="text-xl font-semibold">{profile.name}</h1>
              )}
            </div>
            <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
              {profile.city_name ?? profile.city_code} · {comps.length} competitor
              {comps.length === 1 ? "" : "s"} ·{" "}
              {lastCapturedAt
                ? `updated ${new Date(lastCapturedAt).toLocaleString()}`
                : "no rates fetched yet"}
            </p>
          </div>
          <Link href={`/setup?profileId=${profile.id}`} className="btn-ghost px-3 py-1.5 text-sm">
            Edit profile
          </Link>
          <Link href="/setup?new=1" className="btn-ghost px-3 py-1.5 text-sm">
            + New profile
          </Link>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="btn-accent px-4 py-1.5 text-sm disabled:opacity-60"
          >
            {refreshing ? "Fetching… (takes a few minutes)" : "Refresh rates"}
          </button>
        </div>
      }
    >
      {refreshMsg && (
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          {refreshMsg}
        </p>
      )}

      {!hasAnyData && (
        <div className="card mt-6 p-5 text-sm">
          No rates yet — hit <b>Refresh rates</b> to fetch live prices for the
          next {profile.horizon_days} days. A daily job keeps it fresh afterwards.
        </div>
      )}

      {/* Stat tiles */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <StatTile
          value={String(stats.raise)}
          label="nights with room to raise"
          tone={stats.raise > 0 ? "var(--delta-good-text)" : undefined}
        />
        <StatTile value={String(stats.hot)} label="high-demand nights ahead" />
        <StatTile
          value={String(stats.high)}
          label="nights priced above a soft market"
          tone={stats.high > 0 ? "var(--status-critical)" : undefined}
        />
        <StatTile
          value={String(stats.parityCount)}
          label={
            stats.parityAvg != null
              ? `nights an OTA undercuts your direct rate (avg ${fmt(stats.parityAvg)})`
              : "nights an OTA undercuts your direct rate"
          }
          tone={stats.parityCount > 0 ? "var(--status-critical)" : undefined}
        />
        <StatTile
          value={stats.avg30 != null ? fmt(stats.avg30) : "—"}
          label="avg market rate, next 30 nights"
        />
        <div className="card p-4">
          <div className="flex h-10 items-end gap-1" aria-label="Typical market rate by weekday">
            {[1, 2, 3, 4, 5, 6, 0].map((wd) => {
              const v = weekdayAvg.find((w) => w.weekday === wd)?.avgMedian ?? null;
              return (
                <div
                  key={wd}
                  className="flex-1 rounded-t"
                  title={v != null ? `${WEEKDAYS[wd]}: ${fmt(v)}` : `${WEEKDAYS[wd]}: no data`}
                  style={{
                    height: v != null ? `${Math.max(8, (v / maxWeekday) * 100)}%` : "4px",
                    background: v != null ? "var(--series-1)" : "var(--gridline)",
                  }}
                />
              );
            })}
          </div>
          <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
            typical market rate, Mon → Sun
          </p>
        </div>
      </div>

      {/* View tabs */}
      <div className="mt-6 flex gap-1">
        {(
          [
            ["grid", "Rate grid"],
            ["trends", "Trends"],
            ["ladder", "Rate ladder"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} className="tab" data-active={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "grid" && (
        <>
          <div className="card mt-3 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr
                  className="sticky top-0 z-10 text-left text-xs"
                  style={{ background: "var(--surface)", color: "var(--text-secondary)" }}
                >
                  <th className="px-3 py-2.5 font-medium">Check-in</th>
                  <th className="px-3 py-2.5 font-semibold" style={{ color: "var(--accent)" }}>
                    {myHotel ? myHotel.name : "My rate"}
                  </th>
                  {comps.map((h) => (
                    <th key={h.hotel_id} className="max-w-32 truncate px-3 py-2.5 font-medium" title={h.name}>
                      {h.name}
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-right font-medium">Median</th>
                  <th className="px-3 py-2.5 font-medium">Demand</th>
                  <th className="px-3 py-2.5 font-medium">Advice</th>
                  <th className="px-3 py-2.5 font-medium">Context</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <GridRowView
                    key={r.date}
                    row={r}
                    comps={comps}
                    fmt={fmt}
                    editing={editingDate === r.date}
                    editValue={editValue}
                    onStartEdit={() => {
                      setEditingDate(r.date);
                      setEditValue(r.myPrice != null ? String(r.myPrice) : "");
                    }}
                    onEditChange={setEditValue}
                    onEditSave={() => saveMyRate(r.date)}
                    onEditCancel={() => setEditingDate(null)}
                    onOpen={() => setDrawerDate(r.date)}
                    onTooltip={setTooltip}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div
            className="mt-3 flex flex-wrap items-center gap-3 text-xs"
            style={{ color: "var(--text-secondary)" }}
          >
            <span>Cell color = price vs that night&apos;s market median:</span>
            {[
              ["bin--2", "≤ −15%"],
              ["bin--1", "−15…−5%"],
              ["bin-0", "±5%"],
              ["bin-1", "+5…15%"],
              ["bin-2", "≥ +15%"],
            ].map(([cls, label]) => (
              <span key={cls} className="inline-flex items-center gap-1">
                <span
                  className={`${cls} inline-block h-3.5 w-3.5 rounded border`}
                  style={{ borderColor: "var(--border)" }}
                />
                {label}
              </span>
            ))}
            <span>· rates prefer the brand site&apos;s price when TripAdvisor lists it (hover a cell for all sellers)</span>
          </div>
        </>
      )}

      {tab === "trends" && (
        <div className="card mt-3 p-5">
          <TrendChart rows={rows} fmt={fmt} myName={myHotel?.name ?? "My rate"} />
        </div>
      )}

      {tab === "ladder" && (
        <div className="card mt-3 p-5">
          <RateLadder rows={rows} hotels={hotels} fmt={fmt} />
        </div>
      )}

      {/* Tooltip layer */}
      {tooltip && (
        <div
          className="card pointer-events-none fixed z-50 max-w-72 px-3 py-2 text-xs"
          style={{
            left: Math.min(tooltip.x + 14, typeof window !== "undefined" ? window.innerWidth - 300 : tooltip.x),
            top: tooltip.y + 14,
          }}
        >
          {tooltip.lines.map((l, i) => (
            <div key={i} style={i > 0 ? { color: "var(--text-secondary)" } : { fontWeight: 600 }}>
              {l}
            </div>
          ))}
        </div>
      )}

      {drawerRow && (
        <HistoryDrawer
          row={drawerRow}
          hotels={hotels}
          fmt={fmt}
          onClose={() => setDrawerDate(null)}
        />
      )}
    </Shell>
  );
}

function Shell({
  header,
  children,
}: {
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-screen-2xl p-4 sm:p-6">
      {header ?? <h1 className="text-xl font-semibold">Rate Beacon</h1>}
      {children}
    </main>
  );
}

function StatTile({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="text-2xl font-semibold" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
        {label}
      </p>
    </div>
  );
}

const ADVICE_META: Record<string, { label: string; icon: string; color: string }> = {
  raise: { label: "Raise", icon: "▲", color: "var(--delta-good-text)" },
  review_low: { label: "Low?", icon: "▲", color: "var(--status-warning)" },
  review_high: { label: "High", icon: "▼", color: "var(--status-critical)" },
  in_line: { label: "OK", icon: "•", color: "var(--text-muted)" },
};

function GridRowView({
  row,
  comps,
  fmt,
  editing,
  editValue,
  onStartEdit,
  onEditChange,
  onEditSave,
  onEditCancel,
  onOpen,
  onTooltip,
}: {
  row: GridRow;
  comps: Hotel[];
  fmt: (n: number) => string;
  editing: boolean;
  editValue: string;
  onStartEdit: () => void;
  onEditChange: (v: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onOpen: () => void;
  onTooltip: (t: TooltipState | null) => void;
}) {
  const weekend = [5, 6].includes(new Date(`${row.date}T00:00:00Z`).getUTCDay());
  const advice = row.advice ? ADVICE_META[row.advice] : null;

  function cellTooltip(e: React.MouseEvent, hotel: Hotel) {
    const c = row.cells[hotel.hotel_id];
    const lines = [hotel.name];
    if (c.capturedOn == null) {
      lines.push("No data yet — refresh rates.");
    } else if (!c.available || c.price == null) {
      lines.push("Sold out / no rate returned");
      lines.push(`checked ${c.capturedOn}`);
    } else {
      lines.push(
        `${fmt(c.price)} · ${c.direct ? "brand site" : c.source ?? "cheapest seller"}`
      );
      if (row.median != null && row.median > 0) {
        const pct = ((c.price - row.median) / row.median) * 100;
        lines.push(`${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs market median`);
      }
      for (const o of (c.offers ?? []).slice(0, 4)) {
        lines.push(`${o.name}: ${fmt(o.total)}`);
      }
      lines.push(`captured ${c.capturedOn}`);
    }
    onTooltip({ x: e.clientX, y: e.clientY, lines });
  }

  return (
    <tr
      className="border-t"
      style={{
        borderColor: "var(--gridline)",
        background: weekend ? "color-mix(in oklab, var(--surface-2) 55%, transparent)" : undefined,
      }}
    >
      <td className="whitespace-nowrap px-3 py-1.5">
        <button onClick={onOpen} className="underline-offset-2 hover:underline" title="Open price history">
          {dateLabel(row.date)}
        </button>
      </td>

      {/* My rate (editable) */}
      <td
        className={`${binOf(row.myPrice, row.median)} cursor-pointer px-3 py-1.5 font-medium tabular-nums`}
        style={{ boxShadow: "inset 2px 0 0 var(--accent), inset -2px 0 0 var(--accent)" }}
        onClick={() => !editing && onStartEdit()}
        title="Click to set your rate for this night"
      >
        {editing ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            onBlur={onEditSave}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditSave();
              if (e.key === "Escape") onEditCancel();
            }}
            className="w-20 rounded border px-1 py-0.5 text-sm"
            style={{ borderColor: "var(--accent)", background: "var(--surface)" }}
            placeholder="price"
          />
        ) : row.myPrice != null ? (
          <>
            {fmt(row.myPrice)}
            {row.myPriceSource === "manual" && (
              <span className="ml-1 text-xs" style={{ color: "var(--text-muted)" }} title="Entered manually">
                ✎
              </span>
            )}
          </>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>set…</span>
        )}
      </td>

      {comps.map((h) => {
        const c = row.cells[h.hotel_id];
        const soldOut = c.capturedOn != null && (!c.available || c.price == null);
        return (
          <td
            key={h.hotel_id}
            className={`${soldOut ? "bin-na" : binOf(c.price, row.median)} px-3 py-1.5 tabular-nums`}
            onMouseMove={(e) => cellTooltip(e, h)}
            onMouseLeave={() => onTooltip(null)}
          >
            {c.capturedOn == null ? (
              <span style={{ color: "var(--text-muted)" }}>—</span>
            ) : soldOut ? (
              <span style={{ color: "var(--text-muted)" }}>sold out</span>
            ) : (
              <>
                {fmt(c.price as number)}
                {c.direct && (
                  <span className="ml-0.5 align-super text-[9px]" style={{ color: "var(--text-muted)" }} title="Brand-site rate">
                    D
                  </span>
                )}
              </>
            )}
          </td>
        );
      })}

      <td className="px-3 py-1.5 text-right tabular-nums">
        {row.median != null ? fmt(row.median) : <span style={{ color: "var(--text-muted)" }}>—</span>}
      </td>

      <td className="px-3 py-1.5">
        {row.demand != null ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="w-6 text-right text-xs tabular-nums">{row.demand}</span>
            <span
              className="inline-block h-2 w-14 overflow-hidden rounded-full"
              style={{ background: "var(--gridline)" }}
              role="img"
              aria-label={`Demand ${row.demand} of 100`}
            >
              <span
                className="block h-full rounded-full"
                style={{ width: `${row.demand}%`, background: "var(--series-1)" }}
              />
            </span>
            {row.soldOutCount > 0 && (
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {row.soldOutCount} full
              </span>
            )}
          </span>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        )}
      </td>

      <td className="whitespace-nowrap px-3 py-1.5">
        {advice ? (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
            style={{
              color: advice.color,
              background: "color-mix(in oklab, currentColor 12%, transparent)",
            }}
            title={[
              row.momentumPct != null
                ? `Market moved ${row.momentumPct >= 0 ? "+" : ""}${row.momentumPct.toFixed(0)}% over ~2 weeks`
                : null,
              row.signals?.paceDelta != null && row.signals.paceDelta !== 0
                ? `${Math.abs(row.signals.paceDelta)} more comp${Math.abs(row.signals.paceDelta) === 1 ? "" : "s"} ${row.signals.paceDelta > 0 ? "sold out" : "reopened"} vs last week`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined}
          >
            <span aria-hidden>{advice.icon}</span> {advice.label}
          </span>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        )}
      </td>

      {/* Context: holidays, events, weather, parity — plain-text chips */}
      <td className="whitespace-nowrap px-3 py-1.5 text-xs">
        <span className="inline-flex items-center gap-1.5">
          {row.signals?.holiday && (
            <ContextChip
              label={row.signals.holiday.length > 16 ? `${row.signals.holiday.slice(0, 15)}…` : row.signals.holiday}
              title={row.signals.holiday}
              tone="var(--accent)"
            />
          )}
          {!row.signals?.holiday && row.signals?.nearHoliday && (
            <ContextChip label="Holiday wknd" title="Adjacent to a public holiday" tone="var(--accent)" />
          )}
          {row.signals?.eventCount > 0 && (
            <ContextChip
              label={`${row.signals.eventCount} event${row.signals.eventCount === 1 ? "" : "s"}`}
              title={row.signals.topEvents.join(" · ")}
            />
          )}
          {row.signals?.weather && (
            <ContextChip
              label={`${row.signals.weather.tMax}°${row.signals.weather.precipProb >= 40 ? ` ${row.signals.weather.label}` : ""}`}
              title={`Forecast: ${row.signals.weather.label}, high ${row.signals.weather.tMax}°F, ${row.signals.weather.precipProb}% precip`}
            />
          )}
          {row.signals?.parity && (
            <ContextChip
              label={`Undercut ${fmt(row.signals.parity.undercut)}`}
              title={`${row.signals.parity.by} sells below your direct rate by ${fmt(row.signals.parity.undercut)}`}
              tone="var(--status-critical)"
            />
          )}
          {!row.signals?.holiday &&
            !row.signals?.nearHoliday &&
            !row.signals?.eventCount &&
            !row.signals?.weather &&
            !row.signals?.parity && <span style={{ color: "var(--text-muted)" }}>—</span>}
        </span>
      </td>
    </tr>
  );
}

function ContextChip({ label, title, tone }: { label: string; title?: string; tone?: string }) {
  return (
    <span
      className="rounded-md px-1.5 py-0.5 font-medium"
      style={{
        color: tone ?? "var(--text-secondary)",
        background: "color-mix(in oklab, currentColor 10%, transparent)",
      }}
      title={title}
    >
      {label}
    </span>
  );
}

// ── Trends: my rate vs the market band over the horizon ──────────────────────
function TrendChart({
  rows,
  fmt,
  myName,
}: {
  rows: GridRow[];
  fmt: (n: number) => string;
  myName: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 920;
  const H = 300;
  const padL = 52;
  const padR = 12;
  const padT = 16;
  const padB = 34;

  const withData = rows.filter((r) => r.median != null || r.myPrice != null);
  if (withData.length < 2) {
    return (
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Not enough data yet — refresh rates first.
      </p>
    );
  }

  const values = rows.flatMap((r) =>
    [r.min, r.max, r.median, r.myPrice].filter((v): v is number => v != null)
  );
  const lo = Math.min(...values) * 0.95;
  const hi = Math.max(...values) * 1.05;
  const x = (i: number) => padL + (i / (rows.length - 1)) * (W - padL - padR);
  const y = (v: number) => H - padB - ((v - lo) / (hi - lo || 1)) * (H - padT - padB);

  function linePath(get: (r: GridRow) => number | null): string {
    let d = "";
    let pen = false;
    rows.forEach((r, i) => {
      const v = get(r);
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  // Market band: contiguous segments where min & max exist.
  const bandSegs: string[] = [];
  let seg: { i: number; min: number; max: number }[] = [];
  const flush = () => {
    if (seg.length > 1) {
      const top = seg.map((p) => `${x(p.i).toFixed(1)},${y(p.max).toFixed(1)}`).join(" L");
      const bot = [...seg].reverse().map((p) => `${x(p.i).toFixed(1)},${y(p.min).toFixed(1)}`).join(" L");
      bandSegs.push(`M${top} L${bot} Z`);
    }
    seg = [];
  };
  rows.forEach((r, i) => {
    if (r.min != null && r.max != null) seg.push({ i, min: r.min, max: r.max });
    else flush();
  });
  flush();

  const hoverRow = hover != null ? rows[hover] : null;
  const yTicks = Array.from({ length: 4 }, (_, k) => lo + ((k + 1) / 4) * (hi - lo));
  const xTickEvery = Math.max(1, Math.round(rows.length / 8));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 text-xs" style={{ color: "var(--text-secondary)" }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: "var(--accent)" }} />
          {myName}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-5 rounded"
            style={{ borderTop: "2px dashed var(--text-muted)" }}
          />
          market median
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-5 rounded"
            style={{ background: "color-mix(in oklab, var(--series-1) 16%, transparent)" }}
          />
          market min–max
        </span>
      </div>
      <div className="relative mt-2 overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full min-w-[640px]"
          role="img"
          aria-label="Your nightly rate versus the market band across upcoming dates"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * W;
            const i = Math.round(((px - padL) / (W - padL - padR)) * (rows.length - 1));
            setHover(Math.max(0, Math.min(rows.length - 1, i)));
          }}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke="var(--gridline)" strokeWidth="1" />
              <text x={padL - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
                {fmt(v)}
              </text>
            </g>
          ))}
          {bandSegs.map((d, i) => (
            <path key={i} d={d} fill="color-mix(in oklab, var(--series-1) 16%, transparent)" />
          ))}
          <path d={linePath((r) => r.median)} fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeDasharray="5 4" />
          <path d={linePath((r) => r.myPrice)} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
          {rows.map((r, i) =>
            i % xTickEvery === 0 ? (
              <text
                key={r.date}
                x={x(i)}
                y={H - 10}
                textAnchor="middle"
                fontSize="11"
                fill="var(--text-muted)"
              >
                {r.date.slice(5)}
              </text>
            ) : null
          )}
          {hoverRow && hover != null && (
            <g>
              <line x1={x(hover)} y1={padT} x2={x(hover)} y2={H - padB} stroke="var(--baseline)" strokeWidth="1" />
              {hoverRow.myPrice != null && (
                <circle cx={x(hover)} cy={y(hoverRow.myPrice)} r="4.5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
              )}
              {hoverRow.median != null && (
                <circle cx={x(hover)} cy={y(hoverRow.median)} r="4" fill="var(--text-muted)" stroke="var(--surface)" strokeWidth="2" />
              )}
            </g>
          )}
        </svg>
        {hoverRow && (
          <div className="card pointer-events-none absolute top-2 right-2 px-3 py-2 text-xs">
            <div className="font-semibold">{dateLabel(hoverRow.date)}</div>
            <div style={{ color: "var(--text-secondary)" }}>
              {hoverRow.myPrice != null && <>You: {fmt(hoverRow.myPrice)} · </>}
              {hoverRow.median != null && <>median {fmt(hoverRow.median)}</>}
              {hoverRow.min != null && hoverRow.max != null && (
                <> · market {fmt(hoverRow.min)}–{fmt(hoverRow.max)}</>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Rate ladder: where the hotel sits in the market on one night ─────────────
function RateLadder({
  rows,
  hotels,
  fmt,
}: {
  rows: GridRow[];
  hotels: Hotel[];
  fmt: (n: number) => string;
}) {
  const [idx, setIdx] = useState(0);
  const row = rows[Math.min(idx, rows.length - 1)];
  if (!row) return null;

  const entries = hotels
    .map((h) => {
      const isMine = h.is_mine;
      const price = isMine ? row.myPrice : row.cells[h.hotel_id]?.price ?? null;
      const c = row.cells[h.hotel_id];
      const soldOut = !isMine && c?.capturedOn != null && (!c.available || c.price == null);
      return { hotel: h, price, soldOut, direct: c?.direct ?? false };
    })
    .sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  const maxPrice = Math.max(1, ...entries.map((e) => e.price ?? 0));
  const priced = entries.filter((e) => e.price != null);
  const myRank = priced.findIndex((e) => e.hotel.is_mine);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-ghost px-2.5 py-1 text-sm" onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0}>
          ←
        </button>
        <select value={idx} onChange={(e) => setIdx(Number(e.target.value))} className="btn-ghost px-2 py-1.5 text-sm font-medium">
          {rows.map((r, i) => (
            <option key={r.date} value={i}>
              {dateLabel(r.date)}
            </option>
          ))}
        </select>
        <button
          className="btn-ghost px-2.5 py-1 text-sm"
          onClick={() => setIdx(Math.min(rows.length - 1, idx + 1))}
          disabled={idx >= rows.length - 1}
        >
          →
        </button>
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {myRank >= 0 && (
            <>
              You&apos;re <b>#{myRank + 1} of {priced.length}</b> priced hotels (most expensive first)
            </>
          )}
          {row.demand != null && <> · demand {row.demand}/100</>}
        </span>
      </div>

      <ul className="mt-4 space-y-1.5">
        {entries.map(({ hotel, price, soldOut, direct }) => (
          <li key={hotel.hotel_id} className="flex items-center gap-3">
            <span className="w-64 truncate text-sm" title={hotel.name}>
              <span
                style={{
                  fontWeight: hotel.is_mine ? 700 : 400,
                  color: hotel.is_mine ? "var(--accent)" : undefined,
                }}
              >
                {hotel.name}
              </span>
              {hotel.rating != null && (
                <span className="ml-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
                  {hotel.rating.toFixed(1)}
                  {hotel.review_count != null && ` (${hotel.review_count})`}
                </span>
              )}
            </span>
            <div className="relative h-6 flex-1 overflow-hidden rounded-md" style={{ background: "var(--surface-2)" }}>
              {price != null && (
                <div
                  className="h-full rounded-md"
                  style={{
                    width: `${(price / maxPrice) * 100}%`,
                    background: hotel.is_mine
                      ? "var(--accent)"
                      : "color-mix(in oklab, var(--series-1) 55%, var(--surface))",
                  }}
                />
              )}
            </div>
            <span className="w-24 text-right text-sm tabular-nums">
              {price != null ? (
                <>
                  {fmt(price)}
                  {direct && (
                    <span className="ml-0.5 align-super text-[9px]" style={{ color: "var(--text-muted)" }}>
                      D
                    </span>
                  )}
                </>
              ) : soldOut ? (
                <span style={{ color: "var(--text-muted)" }}>sold out</span>
              ) : (
                <span style={{ color: "var(--text-muted)" }}>—</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
        Bars show each hotel&apos;s nightly rate for this check-in date; &ldquo;D&rdquo; marks a brand-site (direct) rate.
      </p>
    </div>
  );
}

function HistoryDrawer({
  row,
  hotels,
  fmt,
  onClose,
}: {
  row: GridRow;
  hotels: Hotel[];
  fmt: (n: number) => string;
  onClose: () => void;
}) {
  const [histories, setHistories] = useState<Record<string, HistoryPoint[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(
      hotels.map(async (h) => {
        const res = await fetch(
          `/api/history?hotelId=${encodeURIComponent(h.hotel_id)}&checkIn=${row.date}`
        );
        const j = await res.json();
        return [h.hotel_id, (j.points ?? []) as HistoryPoint[]] as const;
      })
    )
      .then((entries) => {
        if (!cancelled) setHistories(Object.fromEntries(entries));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [row.date, hotels]);

  const sorted = [...hotels].sort((a, b) => {
    if (a.is_mine !== b.is_mine) return a.is_mine ? -1 : 1;
    const pa = row.cells[a.hotel_id]?.price ?? Infinity;
    const pb = row.cells[b.hotel_id]?.price ?? Infinity;
    return pa - pb;
  });

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <aside
        className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l p-5"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        role="dialog"
        aria-label={`Price history for ${dateLabel(row.date)}`}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{dateLabel(row.date)}</h2>
          <button onClick={onClose} className="btn-ghost px-2.5 py-1 text-sm">
            Close
          </button>
        </div>
        <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
          How each hotel&apos;s rate for this night has moved since tracking began.
          {row.median != null && <> Market median now: <b>{fmt(row.median)}</b>.</>}
        </p>
        {loading ? (
          <p className="mt-6 text-sm" style={{ color: "var(--text-muted)" }}>
            Loading history…
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {sorted.map((h) => {
              const c = row.cells[h.hotel_id];
              return (
                <li
                  key={h.hotel_id}
                  className="rounded-xl border p-3"
                  style={{ borderColor: h.is_mine ? "var(--accent)" : "var(--border)" }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {h.name}
                      {h.is_mine && (
                        <span className="ml-1.5 text-xs" style={{ color: "var(--accent)" }}>
                          (you)
                        </span>
                      )}
                    </span>
                    <span className="whitespace-nowrap text-sm tabular-nums">
                      {c?.price != null ? (
                        fmt(c.price)
                      ) : c?.capturedOn != null ? (
                        <span style={{ color: "var(--text-muted)" }}>sold out</span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>no data</span>
                      )}
                    </span>
                  </div>
                  <div className="mt-2">
                    <Sparkline points={histories[h.hotel_id] ?? []} fmt={fmt} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </>
  );
}
