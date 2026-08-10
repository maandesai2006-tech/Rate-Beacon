"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import type { GridResponse, GridRow, HistoryPoint, Hotel, MapPlace, RankStat } from "@/lib/types";
import Sparkline from "@/components/Sparkline";
import dynamicImport from "next/dynamic";

// Leaflet touches window on import, so the map is client-only.
const RateMap = dynamicImport(() => import("@/components/RateMap"), {
  ssr: false,
  loading: () => (
    <div
      className="pulsing"
      style={{ height: 560, borderRadius: 10, background: "var(--surface-2)" }}
    />
  ),
});

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

// A hotel key is g<loc>-d<hotel>; TripAdvisor resolves the short review URL.
function tripAdvisorUrl(hotelId: string): string {
  return `https://www.tripadvisor.com/Hotel_Review-${hotelId}-Reviews.html`;
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

type Tab = "grid" | "trends" | "ladder" | "map" | "ratings";
type Theme = "light" | "dark";

export default function Dashboard() {
  const [profiles, setProfiles] = useState<ProfileStub[]>([]);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("light");
  const [data, setData] = useState<GridPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("grid");
  const [refreshing, setRefreshing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [ratingsBusy, setRatingsBusy] = useState(false);
  const [checks, setChecks] = useState<{ name: string; ok: boolean; detail: string }[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [drawerDate, setDrawerDate] = useState<string | null>(null);
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // What the cell held when the edit began — used so simply clicking a cell
  // and clicking away never writes a manual override.
  const editOriginal = useRef<string>("");
  const [headerHidden, setHeaderHidden] = useState(false);
  const [headerStuck, setHeaderStuck] = useState(false);
  const [gridScrolled, setGridScrolled] = useState(false);

  // Theme: explicit light/dark stamp on <html>, or follow the OS.
  useEffect(() => {
    const saved = localStorage.getItem("rb-theme") as Theme | null;
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    localStorage.setItem("rb-theme", theme);
  }, [theme]);

  // Header floats away on scroll down and returns on scroll up.
  useEffect(() => {
    let last = window.scrollY;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = window.scrollY;
        setHeaderStuck(y > 6);
        if (y > last + 4 && y > 140) setHeaderHidden(true);
        else if (y < last - 4) setHeaderHidden(false);
        last = y;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

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
      const qs = new URLSearchParams();
      if (profileId) qs.set("profileId", String(profileId));
      if (baselineId) qs.set("baselineId", baselineId);
      const res = await fetch(`/api/grid?${qs}`);
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
      if (j.configured && j.activeBaselineId) setBaselineId(j.activeBaselineId);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [profileId, baselineId]);

  useEffect(() => {
    load();
  }, [load]);

  // Place any hotels that still lack coordinates so the map has points.
  const fillMap = useCallback(async () => {
    for (let guard = 0; guard < 12; guard++) {
      const res = await fetch("/api/geocode?limit=20", { method: "POST" });
      if (!res.ok) return;
      const j = (await res.json()) as { remaining?: number; located?: number };
      if (!j.remaining) break;
    }
    await load();
  }, [load]);

  // If the map has no coordinates yet, place them in the background so the
  // map is populated the next time it is opened — no manual step.
  const mapFillStarted = useRef(false);
  const ratingsFillStarted = useRef(false);
  useEffect(() => {
    if (mapFillStarted.current || !data || !data.configured) return;
    const anyLocated = [...data.hotels, ...(data.mapHotels ?? [])].some(
      (h) => h.latitude != null
    );
    if (anyLocated) return;
    mapFillStarted.current = true;
    fillMap().catch(() => {});
  }, [data, fillMap]);



  // Fill in review scores, looping until the server reports none pending.
  const fillRatings = useCallback(async () => {
    setRatingsBusy(true);
    try {
      for (let guard = 0; guard < 8; guard++) {
        const res = await fetch("/api/ratings?limit=25", { method: "POST" });
        if (!res.ok) break;
        const j = (await res.json()) as { remaining?: number; updated?: number };
        if (!j.remaining || !j.updated) break;
      }
      await load();
    } finally {
      setRatingsBusy(false);
    }
  }, [load]);

  useEffect(() => {
    if (tab !== "ratings" || ratingsFillStarted.current) return;
    if (!data || !data.configured) return;
    if (data.hotels.some((h) => h.rating != null)) return;
    ratingsFillStarted.current = true;
    fillRatings().catch(() => {});
  }, [tab, data, fillRatings]);

  // The server can only work for ~60s at a time, so the refresh is driven
  // from here in chunks until the run reports it is finished.
  async function refresh() {
    setRefreshing(true);
    setRefreshMsg("Fetching rates…");
    let offset = 0;
    let written = 0;
    const problems: string[] = [];
    try {
      for (let guard = 0; guard < 60; guard++) {
        const res = await fetch(`/api/refresh?offset=${offset}`, { method: "POST" });
        const text = await res.text();
        let j: {
          rowsWritten?: number;
          errors?: string[];
          error?: string;
          total?: number;
          nextOffset?: number | null;
        };
        try {
          j = JSON.parse(text);
        } catch {
          throw new Error(`server returned ${res.status}`);
        }
        if (!res.ok) throw new Error(j.error ?? "Refresh failed");
        written += j.rowsWritten ?? 0;
        if (j.errors?.length) problems.push(...j.errors);
        const total = j.total ?? 0;
        if (j.nextOffset == null) {
          setRefreshMsg(
            problems.length
              ? `Fetched ${written} rates with ${problems.length} error(s): ${problems[0]}`
              : `Fetched ${written} rates.`
          );
          break;
        }
        offset = j.nextOffset;
        setRefreshMsg(
          `Fetching rates… ${Math.min(offset, total)} of ${total} (${written} stored)`
        );
      }
      await load();
      await fillMap();
    } catch (e) {
      setRefreshMsg(`Refresh failed: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }


  // Rebuild this baseline's competitor set from data: TripAdvisor listing →
  // geocode → nearest by distance.
  async function discover() {
    if (!profileId) return;
    setDiscovering(true);
    setRefreshMsg(null);
    try {
      const qs = new URLSearchParams({ profileId: String(profileId) });
      if (baselineId) qs.set("baselineId", baselineId);
      const res = await fetch(`/api/discover?${qs}`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Discovery failed");
      const r = j.results?.[0];
      setRefreshMsg(
        r
          ? `Found ${r.comps} competitors and ${r.mapExtras} nearby hotels for the map. Refresh rates to price them.`
          : "Discovery finished."
      );
      await load();
    } catch (e) {
      setRefreshMsg(`Discovery failed: ${(e as Error).message}`);
    } finally {
      setDiscovering(false);
    }
  }

  // Rebuild the map's nearby-hotel set from OpenStreetMap for this profile.

  async function refreshMapSet() {
    if (!profileId) return;
    setMapping(true);
    setRefreshMsg(null);
    try {
      const res = await fetch(`/api/map-set?profileId=${profileId}&limit=30`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Map refresh failed");
      const found = (j.results ?? []).reduce(
        (a: number, r: { found?: number }) => a + (r.found ?? 0),
        0
      );
      setRefreshMsg(`Map updated with ${found} nearby hotels.`);
      await load();
    } catch (e) {
      setRefreshMsg(`Map refresh failed: ${(e as Error).message}`);
    } finally {
      setMapping(false);
    }
  }


  async function runSystemCheck() {
    setChecking(true);
    try {
      const res = await fetch("/api/system-check");
      const j = await res.json();
      setChecks(j.checks ?? []);
    } catch (e) {
      setChecks([{ name: "System check", ok: false, detail: (e as Error).message }]);
    } finally {
      setChecking(false);
    }
  }

  async function saveMyRate(date: string) {
    const raw = editValue.trim();
    setEditingDate(null);
    // Untouched edit — never persist, so a stray click can't freeze the live
    // rate behind a manual override.
    if (!profileId || raw === editOriginal.current.trim()) return;
    const price = raw === "" ? null : Number(raw);
    if (price != null && (Number.isNaN(price) || price < 0)) return;
    await fetch("/api/my-rates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId, checkIn: date, price }),
    });
    await load();
  }

  async function clearMyRate(date: string) {
    if (!profileId) return;
    await fetch("/api/my-rates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId, checkIn: date, price: null }),
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
          <h2 className="text-[15px]" style={{ color: "var(--status-critical)" }}>
            Something went wrong
          </h2>
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
        <p className="pulsing mt-10 text-sm" style={{ color: "var(--text-muted)" }}>
          Loading…
        </p>
      </Shell>
    );
  }

  if (!data.configured) {
    return (
      <Shell>
        <div className="card mt-10 p-8 text-center">
          <h2 className="text-lg">Welcome to Rate Beacon</h2>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--text-secondary)" }}>
            Create a hotel profile: pick the baseline hotel and the competitor
            set to shop against, night by night.
          </p>
          <Link href="/setup" className="btn-accent mt-5 inline-flex px-5 py-2.5">
            Create a profile →
          </Link>
        </div>
      </Shell>
    );
  }

  const { profile, hotels, rows, weekdayAvg, lastCapturedAt, baselines, rankStats, mapHotels, mapPlaces, compsAreDiscovered } = data;
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
        <div
          className="app-header flex flex-wrap items-center gap-3"
          data-hidden={headerHidden}
          data-stuck={headerStuck}
        >
          <div className="mr-auto">
            <div className="flex items-center gap-2.5">
              <Mark />
              {profiles.length > 1 ? (
                <select
                  value={profileId ?? profiles[0]?.id}
                  onChange={(e) => setProfileId(Number(e.target.value))}
                  style={{
                    font: "600 20px var(--font-heading)",
                    background: "transparent",
                    border: "none",
                    color: "var(--text-primary)",
                    padding: "2px 0",
                    cursor: "pointer",
                  }}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <h1 style={{ font: "600 20px var(--font-heading)" }}>{profile.name}</h1>
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
          <ThemeToggle theme={theme} onChange={setTheme} />
          <button
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.href = "/login";
            }}
            className="btn-ghost px-3 py-1.5 text-[13px]"
          >
            Sign out
          </button>
          <Link href={`/setup?profileId=${profile.id}`} className="btn-ghost px-3 py-1.5 text-[13px]">
            Edit profile
          </Link>
          <button
            onClick={refreshMapSet}
            disabled={mapping || refreshing}
            className="btn-ghost px-3 py-1.5 text-[13px]"
            title="Rebuild the map's nearby-hotel set from OpenStreetMap"
          >
            {mapping ? "Mapping…" : "Refresh map"}
          </button>
          <button
            onClick={discover}
            disabled={discovering || refreshing}
            className="btn-ghost px-3 py-1.5 text-[13px]"
            title="Rebuild this hotel's competitor set from TripAdvisor listings and distance"
          >
            {discovering ? "Searching…" : "Find competitors"}
          </button>
          <button
            onClick={refresh}
            disabled={refreshing || discovering}
            className="btn-accent px-4 py-1.5 text-[13px]"
          >
            {refreshing ? "Fetching rates…" : "Refresh rates"}
          </button>
        </div>
      }
    >
      {baselines.length > 1 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="kicker" style={{ color: "var(--text-muted)" }}>
            My hotel
          </span>
          <div className="flex flex-wrap gap-1.5">
            {baselines.map((b) => (
              <button
                key={b.hotel_id}
                onClick={() => setBaselineId(b.hotel_id)}
                className="btn-ghost px-3 py-1.5 text-[12px]"
                data-on={b.hotel_id === baselineId}
                style={
                  b.hotel_id === baselineId
                    ? {
                        borderColor: "var(--accent)",
                        background: "var(--accent-soft)",
                        color: "var(--accent)",
                      }
                    : undefined
                }
                title={`${b.compCount} competitors tracked for this hotel`}
              >
                {b.name}
                <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {b.compCount}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {refreshMsg && (
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          {refreshMsg}
        </p>
      )}

      {!compsAreDiscovered && (
        <div className="card mt-4 p-4 text-[13px]">
          <div className="kicker mb-1">Competitor set not discovered yet</div>
          This hotel is showing other tracked hotels in the same TripAdvisor
          location as a stand-in. Click <b>Find competitors</b> to build its own
          set by distance.
        </div>
      )}

      {!hasAnyData && (
        <div className="card mt-6 p-5 text-sm">
          <div className="kicker mb-1.5">No rates yet</div>
          Hit <b>Refresh rates</b> to fetch live prices for the next{" "}
          {profile.horizon_days} days. A daily job keeps it fresh afterwards.
        </div>
      )}

      {/* Stat tiles */}
      <div className="stagger mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
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
        <div className="card card--lift px-4 py-3.5">
          <div className="flex h-10 items-end gap-1" aria-label="Typical market rate by weekday">
            {[1, 2, 3, 4, 5, 6, 0].map((wd) => {
              const v = weekdayAvg.find((w) => w.weekday === wd)?.avgMedian ?? null;
              return (
                <div
                  key={wd}
                  className="grow-bar flex-1 rounded-t"
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
      <TabBar tab={tab} onChange={setTab} />

      {tab === "grid" && (
        <div className="fade">
          <div
            className="card grid-scroll mt-4 overflow-hidden"
            data-scrolled={gridScrolled}
            onScroll={(e) => setGridScrolled(e.currentTarget.scrollLeft > 2)}
            style={{ overflowX: "auto" }}
          >
            <table className="w-full min-w-[1100px] border-collapse text-[13px]">
              <thead>
                <tr
                  className="sticky top-0 z-10 text-left"
                  style={{ background: "var(--surface)" }}
                >
                  <th
                    className="th-label col-sticky sticky left-0 z-20 px-3 py-2.5"
                    style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
                  >
                    Check-in
                  </th>
                  <th
                    className="th-label px-3 py-2.5"
                    style={{
                      color: "var(--accent)",
                      borderBottom: "1px solid var(--border)",
                      boxShadow: "inset 2px 0 0 var(--accent)",
                    }}
                  >
                    {myHotel ? myHotel.name : "My rate"}
                  </th>
                  {comps.map((h) => (
                    <th
                      key={h.hotel_id}
                      className="th-label max-w-32 truncate px-3 py-2.5"
                      style={{ borderBottom: "1px solid var(--border)" }}
                      title={h.rating != null ? `${h.name} · ${h.rating.toFixed(1)} (${h.review_count ?? "–"})` : h.name}
                    >
                      <a
                        href={tripAdvisorUrl(h.hotel_id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                        style={{ color: "inherit" }}
                      >
                        {h.name}
                      </a>
                    </th>
                  ))}
                  <th className="th-label px-3 py-2.5 text-right" style={{ borderBottom: "1px solid var(--border)" }}>
                    Median
                  </th>
                  <th className="th-label px-3 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
                    Demand
                  </th>
                  <th className="th-label px-3 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
                    Advice
                  </th>
                  <th className="th-label px-3 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
                    Context
                  </th>
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
                      const current = r.myPrice != null ? String(r.myPrice) : "";
                      editOriginal.current = current;
                      setEditingDate(r.date);
                      setEditValue(current);
                    }}
                    onClearOverride={() => clearMyRate(r.date)}
                    myHotelId={myHotel?.hotel_id ?? null}
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
              <span key={cls} className="inline-flex items-center gap-1.5">
                <span
                  className={`${cls} inline-block h-3.5 w-3.5`}
                  style={{ border: "1px solid var(--border)" }}
                />
                {label}
              </span>
            ))}
            <span>· rates prefer the brand site&apos;s price when TripAdvisor lists it (hover a cell for all sellers)</span>
          </div>
        </div>
      )}

      {tab === "trends" && (
        <div className="card rise mt-4 p-5">
          <TrendChart rows={rows} fmt={fmt} myName={myHotel?.name ?? "My rate"} />
        </div>
      )}

      {tab === "ladder" && (
        <div className="card rise mt-4 p-5">
          <RateLadder rows={rows} hotels={hotels} fmt={fmt} rankStats={rankStats} />
        </div>
      )}

      {tab === "ratings" && (
        <div className="card rise mt-4 p-5">
          <RatingsTable
            hotels={hotels}
            rows={rows}
            fmt={fmt}
            busy={ratingsBusy}
            onFetch={fillRatings}
          />
        </div>
      )}

      {tab === "map" && (
        <div className="card rise mt-4 p-5">
          <MapPanel rows={rows} hotels={[...hotels, ...(mapHotels ?? [])]} places={mapPlaces ?? []} fmt={fmt} theme={theme} />
        </div>
      )}

      {/* Tooltip layer */}
      {tooltip && (
        <div
          className="card fade pointer-events-none max-w-[300px] px-3 py-2.5 text-xs"
          style={{
            position: "fixed",
            zIndex: 60,
            left: Math.min(tooltip.x + 14, typeof window !== "undefined" ? window.innerWidth - 320 : tooltip.x),
            top: Math.min(tooltip.y + 14, typeof window !== "undefined" ? window.innerHeight - 260 : tooltip.y),
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {tooltip.lines.map((l, i) => (
            <div key={i} style={i > 0 ? { color: "var(--text-secondary)" } : { fontWeight: 600 }}>
              {l}
            </div>
          ))}
        </div>
      )}

      <div className="card mt-6 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <div className="kicker">System check</div>
            <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
              Tests every data source this dashboard depends on and reports what
              is working.
            </p>
          </div>
          <button
            onClick={runSystemCheck}
            disabled={checking}
            className="btn-ghost px-3 py-1.5 text-[13px]"
          >
            {checking ? "Checking…" : "Run check"}
          </button>
        </div>
        {checks && (
          <ul className="mt-3 space-y-1.5">
            {checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2 text-[13px]">
                <span
                  className="mt-[3px] inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: c.ok ? "var(--status-good)" : "var(--status-critical)" }}
                  aria-hidden
                />
                <span>
                  <b>{c.name}:</b>{" "}
                  <span style={{ color: "var(--text-secondary)" }}>{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

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

// Tabs with an indicator that slides between the active buttons.
function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const defs: [Tab, string][] = [
    ["grid", "Rate grid"],
    ["trends", "Trends"],
    ["ladder", "Rate ladder"],
    ["map", "Map"],
    ["ratings", "Ratings"],
  ];
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const [ind, setInd] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[tab];
      if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [tab]);

  return (
    <div
      className="tabbar mt-6"
      style={
        {
          borderBottom: "1px solid var(--border)",
          "--ind-left": `${ind.left}px`,
          "--ind-width": `${ind.width}px`,
        } as React.CSSProperties
      }
      role="tablist"
    >
      {defs.map(([t, label]) => (
        <button
          key={t}
          ref={(el) => {
            refs.current[t] = el;
          }}
          role="tab"
          aria-selected={tab === t}
          className="tab"
          data-active={tab === t}
          onClick={() => onChange(t)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Day-over-day ladder move plus the hotel's mean position over 30 nights.
function RankInsight({ stat, live }: { stat?: RankStat; live: boolean }) {
  if (!stat) return <span className="w-[124px]" />;
  const { rankDelta, avgRank30 } = stat;
  const up = rankDelta != null && rankDelta > 0;
  const down = rankDelta != null && rankDelta < 0;
  return (
    <span className="flex w-[124px] items-center justify-end gap-2 text-[11px] tabular-nums">
      {live && rankDelta != null && rankDelta !== 0 ? (
        <span
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 font-semibold"
          style={{
            color: up ? "var(--delta-good-text)" : "var(--status-critical)",
            background: "color-mix(in oklab, currentColor 13%, transparent)",
            borderRadius: 4,
          }}
          title={
            up
              ? `Moved up ${rankDelta} place${rankDelta === 1 ? "" : "s"} since the previous capture`
              : `Slipped ${Math.abs(rankDelta as number)} place${Math.abs(rankDelta as number) === 1 ? "" : "s"} since the previous capture`
          }
        >
          <span aria-hidden>{up ? "▲" : "▼"}</span>
          {up ? "+" : ""}
          {rankDelta}
        </span>
      ) : (
        <span style={{ color: "var(--text-muted)" }} title="No day-over-day change recorded yet">
          {live && rankDelta === 0 ? "—" : ""}
        </span>
      )}
      <span
        style={{ color: "var(--text-secondary)" }}
        title="Average ladder position across the next 30 nights"
      >
        {avgRank30 != null ? `#${avgRank30.toFixed(1)}` : "—"}
      </span>
    </span>
  );
}

// Review standing across the compset. TripAdvisor is the only source in the
// free feed, so that is what is shown — rating, review volume and rank —
// alongside price position, which is where the two often disagree.
function RatingsTable({
  hotels,
  rows,
  fmt,
  busy,
  onFetch,
}: {
  hotels: Hotel[];
  rows: GridRow[];
  fmt: (n: number) => string;
  busy: boolean;
  onFetch: () => void;
}) {
  const rated = hotels.filter((h) => h.rating != null);
  // Average price over the horizon, for the value comparison.
  const avgPrice = new Map<string, number>();
  for (const h of hotels) {
    const vals = rows
      .map((r) => (h.is_mine ? r.myPrice ?? r.cells[h.hotel_id]?.price : r.cells[h.hotel_id]?.price))
      .filter((v): v is number => v != null);
    if (vals.length) avgPrice.set(h.hotel_id, vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  if (rated.length === 0) {
    return (
      <div>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {busy ? "Looking up review scores…" : "No review scores collected yet."}
        </p>
        <p className="mt-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
          Scores are gathered from TripAdvisor&apos;s public data. If this stays
          empty, that source is not returning hotel records right now — run the
          system check at the bottom of the page to see which feeds are up.
        </p>
        <button
          onClick={onFetch}
          disabled={busy}
          className="btn-ghost mt-3 px-3 py-1.5 text-[13px]"
        >
          {busy ? "Fetching…" : "Fetch review scores"}
        </button>
      </div>
    );
  }

  const byRating = [...rated].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const byPrice = [...hotels]
    .filter((h) => avgPrice.has(h.hotel_id))
    .sort((a, b) => (avgPrice.get(b.hotel_id) ?? 0) - (avgPrice.get(a.hotel_id) ?? 0));
  const priceRank = new Map(byPrice.map((h, i) => [h.hotel_id, i + 1]));
  const maxReviews = Math.max(1, ...rated.map((h) => h.review_count ?? 0));

  return (
    <div>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        TripAdvisor rating and review volume across the competitive set, next to
        each hotel&apos;s price position. A hotel rated above the set but priced
        below it is leaving room; the reverse is a risk.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left">
              {["#", "Hotel", "Rating", "Reviews", "Avg rate", "Price rank"].map((h, i) => (
                <th
                  key={h}
                  className={`th-label px-3 py-2.5 ${i >= 2 ? "text-right" : ""}`}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byRating.map((h, i) => {
              const pRank = priceRank.get(h.hotel_id) ?? null;
              const rRank = i + 1;
              // Rated better than priced → room to move up.
              const gap = pRank != null ? pRank - rRank : null;
              return (
                <tr
                  key={h.hotel_id}
                  className="row-hover border-t"
                  style={{ borderColor: "var(--gridline)" }}
                >
                  <td className="px-3 py-2 tabular-nums" style={{ color: "var(--text-muted)" }}>
                    {rRank}
                  </td>
                  <td className="max-w-[280px] truncate px-3 py-2">
                    <a
                      href={tripAdvisorUrl(h.hotel_id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                      style={{
                        color: h.is_mine ? "var(--accent)" : "inherit",
                        fontWeight: h.is_mine ? 700 : 400,
                      }}
                    >
                      {h.name}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {h.rating?.toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="inline-flex items-center justify-end gap-2">
                      <span
                        className="inline-block h-1.5"
                        style={{
                          width: `${Math.max(4, ((h.review_count ?? 0) / maxReviews) * 56)}px`,
                          background: "var(--series-1)",
                        }}
                      />
                      <span style={{ color: "var(--text-secondary)" }}>
                        {h.review_count ?? "—"}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {avgPrice.has(h.hotel_id) ? fmt(avgPrice.get(h.hotel_id) as number) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {pRank != null ? (
                      <span
                        title={
                          gap === null || gap === 0
                            ? "Priced in line with its review standing"
                            : gap > 0
                            ? `Rated ${gap} place(s) better than it is priced`
                            : `Priced ${Math.abs(gap)} place(s) above its review standing`
                        }
                        style={{
                          color:
                            gap == null || gap === 0
                              ? "var(--text-secondary)"
                              : gap > 0
                              ? "var(--delta-good-text)"
                              : "var(--status-critical)",
                        }}
                      >
                        #{pRank}
                        {gap != null && gap !== 0 && (
                          <span className="ml-1 text-[11px]">
                            ({gap > 0 ? "+" : ""}
                            {gap})
                          </span>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
        Ratings are TripAdvisor&apos;s. Expedia and Booking.com scores are not
        available in the free feed this dashboard runs on.
      </p>
    </div>
  );
}

function ThemeToggle({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
}) {
  return (
    <div
      className="inline-flex overflow-hidden"
      style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)" }}
      role="group"
      aria-label="Colour theme"
    >
      {(["light", "dark"] as Theme[]).map((value) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          aria-pressed={theme === value}
          title={value === "light" ? "Light" : "Dark"}
          className="px-2.5 py-1.5"
          style={{
            background: theme === value ? "var(--accent)" : "transparent",
            color: theme === value ? "var(--accent-ink)" : "var(--text-secondary)",
            transition: "background .18s var(--ease), color .18s var(--ease)",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            {value === "light" ? (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 4v1.5M12 18.5V20M4 12h1.5M18.5 12H20M6.3 6.3l1.1 1.1M16.6 16.6l1.1 1.1M17.7 6.3l-1.1 1.1M7.4 16.6l-1.1 1.1" />
              </>
            ) : (
              <path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z" />
            )}
          </svg>
        </button>
      ))}
    </div>
  );
}

// Map panel: night stepper plus the real slippy map.
function MapPanel({
  rows,
  hotels,
  places,
  fmt,
  theme,
}: {
  rows: GridRow[];
  hotels: Hotel[];
  places: MapPlace[];
  fmt: (n: number) => string;
  theme: "light" | "dark";
}) {
  const [idx, setIdx] = useState(0);
  const row = rows[Math.min(idx, rows.length - 1)] ?? null;
  const located = hotels.filter((h) => h.latitude != null && h.longitude != null);
  const total = located.length + places.filter((p) => !p.hotel_id).length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn-ghost h-9 w-9 text-sm disabled:opacity-45"
          onClick={() => setIdx(Math.max(0, idx - 1))}
          disabled={idx === 0}
          aria-label="Previous night"
        >
          ←
        </button>
        <select
          value={idx}
          onChange={(e) => setIdx(Number(e.target.value))}
          className="btn-ghost px-2.5 py-1.5 text-[13px]"
        >
          {rows.map((r, i) => (
            <option key={r.date} value={i}>
              {dateLabel(r.date)}
            </option>
          ))}
        </select>
        <button
          className="btn-ghost h-9 w-9 text-sm disabled:opacity-45"
          onClick={() => setIdx(Math.min(rows.length - 1, idx + 1))}
          disabled={idx >= rows.length - 1}
          aria-label="Next night"
        >
          →
        </button>
        <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
          {row?.median != null && <>median {fmt(row.median)} · </>}
          {total} hotels on the map
        </span>
      </div>

      <div className="mt-3">
        <RateMap row={row} hotels={hotels} places={places} fmt={fmt} theme={theme} />
      </div>

      <div
        className="mt-3 flex flex-wrap items-center gap-3 text-xs"
        style={{ color: "var(--text-secondary)" }}
      >
        <span>Pin colour = price vs median:</span>
        {[
          ["var(--div-low)", "cheaper"],
          ["var(--baseline)", "at market"],
          ["var(--div-high)", "pricier"],
        ].map(([c, label]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-full" style={{ background: c }} />
            {label}
          </span>
        ))}
        <span>· starred pins are your hotels · grey pins are nearby hotels without a tracked rate</span>
      </div>
    </div>
  );
}

function Mark() {
  return (
    <span
      aria-hidden
      className="inline-flex h-[30px] w-[30px] items-center justify-center"
      style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M12 2l7 4v6c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z" />
        <path d="M12 8v5" />
        <circle cx="12" cy="16" r="0.6" fill="currentColor" />
      </svg>
    </span>
  );
}

function StatTile({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div className="card card--lift px-4 py-3.5">
      <div
        className="tabular-nums"
        style={{
          font: "600 30px/1.1 var(--font-heading)",
          color: tone ?? "var(--text-primary)",
        }}
      >
        {value}
      </div>
      <p className="mt-1 text-xs leading-snug" style={{ color: "var(--text-secondary)" }}>
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
  onClearOverride,
  onOpen,
  onTooltip,
  myHotelId,
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
  onClearOverride: () => void;
  onOpen: () => void;
  onTooltip: (t: TooltipState | null) => void;
  myHotelId: string | null;
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
      const offers = c.offers ?? [];
      if (offers.length) {
        lines.push("—");
        for (const o of offers) {
          const mark = o.name === (c.source ?? "").replace(" (direct)", "") ? " ←" : "";
          lines.push(`${o.name}  ${fmt(o.total)}${mark}`);
        }
      }
      lines.push(`captured ${c.capturedOn}`);
    }
    onTooltip({ x: e.clientX, y: e.clientY, lines });
  }

  return (
    <tr
      className="row-hover border-t"
      style={{
        borderColor: "var(--gridline)",
        background: weekend ? "color-mix(in oklab, var(--surface-2) 55%, transparent)" : undefined,
      }}
    >
      <td
        className="col-sticky sticky left-0 z-10 whitespace-nowrap px-3 py-1.5"
        style={{
          background: weekend
            ? "color-mix(in oklab, var(--surface-2) 55%, var(--surface))"
            : "var(--surface)",
        }}
      >
        <button onClick={onOpen} className="underline-offset-2 hover:underline" title="Open price history">
          {dateLabel(row.date)}
        </button>
      </td>

      {/* My rate (editable) */}
      <td
        className={`${binOf(row.myPrice, row.median)} cursor-pointer px-3 py-1.5 font-semibold tabular-nums`}
        style={{ boxShadow: "inset 2px 0 0 var(--accent), inset -2px 0 0 var(--accent)" }}
        onClick={() => !editing && onStartEdit()}
        onMouseMove={(e) => myHotelId && cellTooltip(e, { hotel_id: myHotelId, name: "Your hotel", is_mine: true, rating: null, review_count: null, latitude: null, longitude: null })}
        onMouseLeave={() => onTooltip(null)}
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
            className="input w-[78px] px-1.5 py-0.5 text-[13px]"
            style={{ minHeight: "auto", borderColor: "var(--accent)" }}
            placeholder="price"
          />
        ) : row.myPrice != null ? (
          <>
            {fmt(row.myPrice)}
            {row.myPriceSource === "manual" ? (
              <button
                className="ml-1 text-[10px] align-super"
                style={{ color: "var(--status-warning)" }}
                title="Manual override — click to restore the live rate"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearOverride();
                }}
              >
                M
              </button>
            ) : (
              row.cells[myHotelId ?? ""]?.direct && (
                <span
                  className="ml-0.5 align-super text-[9px]"
                  style={{ color: "var(--text-muted)" }}
                  title="Brand-site rate"
                >
                  D
                </span>
              )
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
              className="inline-block h-[7px] w-14 overflow-hidden"
              style={{ background: "var(--gridline)" }}
              role="img"
              aria-label={`Demand ${row.demand} of 100`}
            >
              <span
                className="block h-full"
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
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold"
            style={{
              color: advice.color,
              background: "color-mix(in oklab, currentColor 14%, transparent)",
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
      className="inline-flex px-[7px] py-0.5 text-[11px] font-medium"
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
      <div className="flex flex-wrap items-center gap-[18px] text-xs" style={{ color: "var(--text-secondary)" }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-[18px]" style={{ background: "var(--accent)" }} />
          {myName}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-[18px]"
            style={{ height: 0, borderTop: "2px dashed var(--text-muted)" }}
          />
          market median
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-[18px]"
            style={{ background: "var(--accent-soft)" }}
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
            <path key={i} d={d} fill="var(--accent-soft)" />
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
          <div className="card pointer-events-none absolute top-2 right-2 px-3 py-2 text-xs" style={{ background: "var(--surface)" }}>
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
  rankStats,
}: {
  rows: GridRow[];
  hotels: Hotel[];
  fmt: (n: number) => string;
  rankStats: RankStat[];
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
  const statById = new Map(rankStats.map((s) => [s.hotel_id, s]));
  const showsToday = idx === 0;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn-ghost h-9 w-9 text-sm disabled:opacity-45"
          onClick={() => setIdx(Math.max(0, idx - 1))}
          disabled={idx === 0}
          aria-label="Previous night"
        >
          ←
        </button>
        <select
          value={idx}
          onChange={(e) => setIdx(Number(e.target.value))}
          className="btn-ghost px-2.5 py-1.5 text-[13px]"
        >
          {rows.map((r, i) => (
            <option key={r.date} value={i}>
              {dateLabel(r.date)}
            </option>
          ))}
        </select>
        <button
          className="btn-ghost h-9 w-9 text-sm disabled:opacity-45"
          onClick={() => setIdx(Math.min(rows.length - 1, idx + 1))}
          disabled={idx >= rows.length - 1}
          aria-label="Next night"
        >
          →
        </button>
        <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
          {myRank >= 0 && (
            <>
              You&apos;re <b>#{myRank + 1} of {priced.length}</b> priced hotels (most expensive first)
            </>
          )}
          {row.demand != null && <> · demand {row.demand}/100</>}
        </span>
      </div>

      <div
        className="mt-4 flex items-center gap-3 pb-1 text-[10px]"
        style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}
      >
        <span className="th-label w-[230px]">Hotel</span>
        <span className="th-label flex-1">Rate</span>
        <span className="th-label w-[90px] text-right">Price</span>
        <span className="th-label w-[124px] text-right">Move · 30-night avg</span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {entries.map(({ hotel, price, soldOut, direct }) => (
          <li key={hotel.hotel_id} className="flex items-center gap-3">
            <span className="w-[230px] truncate text-[13px]" title={hotel.name}>
              <a
                href={tripAdvisorUrl(hotel.hotel_id)}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                style={{
                  fontWeight: hotel.is_mine ? 700 : 400,
                  color: hotel.is_mine ? "var(--accent)" : "inherit",
                }}
              >
                {hotel.name}
              </a>
              {hotel.rating != null && (
                <span className="ml-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
                  {hotel.rating.toFixed(1)}
                  {hotel.review_count != null && ` (${hotel.review_count})`}
                </span>
              )}
            </span>
            <div className="relative h-[22px] flex-1 overflow-hidden" style={{ background: "var(--surface-2)" }}>
              {price != null && (
                <div
                  className="grow-bar h-full"
                  style={{
                    width: `${(price / maxPrice) * 100}%`,
                    background: hotel.is_mine
                      ? "var(--accent)"
                      : "color-mix(in oklab, var(--series-1) 55%, var(--surface))",
                  }}
                />
              )}
            </div>
            <span className="w-[90px] text-right text-[13px] tabular-nums">
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
            <RankInsight stat={statById.get(hotel.hotel_id)} live={showsToday} />
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
      <div className="fade fixed inset-0 z-40 bg-black/45" onClick={onClose} />
      <aside
        className="slide-in fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l p-5"
        style={{
          background: "var(--surface)",
          borderColor: "var(--border)",
          boxShadow: "var(--shadow-lg)",
        }}
        role="dialog"
        aria-label={`Price history for ${dateLabel(row.date)}`}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[17px]">{dateLabel(row.date)}</h2>
          <button onClick={onClose} className="btn-ghost px-2.5 py-1 text-xs">
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
                  className="p-3"
                  style={{ border: `1px solid ${h.is_mine ? "var(--accent)" : "var(--border)"}` }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] font-semibold">
                      <a
                        href={tripAdvisorUrl(h.hotel_id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                        style={{ color: "inherit" }}
                      >
                        {h.name}
                      </a>
                      {h.is_mine && (
                        <span className="ml-1.5 text-xs" style={{ color: "var(--accent)" }}>
                          (you)
                        </span>
                      )}
                    </span>
                    <span className="whitespace-nowrap text-[13px] tabular-nums">
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
