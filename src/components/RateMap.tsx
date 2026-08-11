"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, Layer, LayerGroup, TileLayer } from "leaflet";
import type { GridRow, Hotel, MapPlace } from "@/lib/types";

// Real slippy map: OpenStreetMap tiles with zoom and pan, hotels drawn as
// price pills, and three optional layers on top —
//
//   places   restaurants, attractions and shops from OpenStreetMap, loaded
//            for whatever the map is showing and refreshed as you pan
//   traffic  live flow tiles, when a free TomTom key is configured
//   weather  twelve hours of forecast over the visible area, played back
//
// Everything except traffic is keyless. Traffic has no keyless source worth
// having, so the layer says so rather than drawing something invented.

type PoiKind = "lodging" | "food" | "attraction" | "shop";

interface Poi {
  osmId: string;
  kind: PoiKind;
  name: string;
  latitude: number;
  longitude: number;
  detail: string | null;
}

interface WeatherCell {
  latitude: number;
  longitude: number;
  temperature: number | null;
  precipitation: number | null;
  precipitationChance: number | null;
  cloudCover: number | null;
  windSpeed: number | null;
}

interface WeatherFrame {
  time: string;
  cells: WeatherCell[];
}

const POI_STYLE: Record<PoiKind, { label: string; token: string; fallback: string }> = {
  lodging: { label: "Other hotels", token: "--text-muted", fallback: "#6b7a90" },
  food: { label: "Restaurants", token: "--status-serious", fallback: "#d1662f" },
  attraction: { label: "Attractions", token: "--status-good", fallback: "#12915a" },
  shop: { label: "Shops", token: "--status-warning", fallback: "#c08512" },
};

const TOMTOM_KEY = process.env.NEXT_PUBLIC_TOMTOM_KEY ?? "";

export default function RateMap({
  row,
  hotels,
  places,
  fmt,
  theme,
}: {
  row: GridRow | null;
  hotels: Hotel[];
  places: MapPlace[];
  fmt: (n: number) => string;
  theme: "light" | "dark";
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Layer[]>([]);
  const tileRef = useRef<TileLayer | null>(null);
  const poiLayerRef = useRef<LayerGroup | null>(null);
  const weatherLayerRef = useRef<LayerGroup | null>(null);
  const trafficRef = useRef<TileLayer | null>(null);
  const [ready, setReady] = useState(false);

  const [kinds, setKinds] = useState<Record<PoiKind, boolean>>({
    lodging: true,
    food: true,
    attraction: true,
    shop: false,
  });
  const [traffic, setTraffic] = useState(false);
  const [pois, setPois] = useState<Poi[]>([]);
  const [poiNote, setPoiNote] = useState<string | null>(null);
  const [poiBusy, setPoiBusy] = useState(false);

  const [frames, setFrames] = useState<WeatherFrame[] | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [weatherNote, setWeatherNote] = useState<string | null>(null);

  const hotelById = new Map(hotels.map((h) => [h.hotel_id, h]));

  // Points come from two places: hotels we track (always shown, priced) and
  // OpenStreetMap lodging nearby (context, priced when it matches a tracked
  // hotel). Tracked hotels win on duplicates.
  const seen = new Set<string>();
  const points: {
    key: string;
    name: string;
    lat: number;
    lon: number;
    price: number | null;
    isMine: boolean;
    tracked: boolean;
    hotelId: string | null;
  }[] = [];

  for (const h of hotels) {
    if (h.latitude == null || h.longitude == null) continue;
    const c = row?.cells[h.hotel_id];
    const price = h.is_mine ? row?.myPrice ?? c?.price ?? null : c?.price ?? null;
    seen.add(h.hotel_id);
    points.push({
      key: h.hotel_id,
      name: h.name,
      lat: h.latitude,
      lon: h.longitude,
      price,
      isMine: h.is_mine,
      tracked: true,
      hotelId: h.hotel_id,
    });
  }
  for (const p of places) {
    if (p.hotel_id && seen.has(p.hotel_id)) continue;
    const linked = p.hotel_id ? hotelById.get(p.hotel_id) : undefined;
    const c = p.hotel_id ? row?.cells[p.hotel_id] : undefined;
    points.push({
      key: p.osm_id,
      name: p.name,
      lat: p.latitude,
      lon: p.longitude,
      price: c?.price ?? null,
      isMine: linked?.is_mine ?? false,
      tracked: Boolean(p.hotel_id),
      hotelId: p.hotel_id,
    });
  }

  const median = row?.median ?? null;

  function toneFor(price: number | null, isMine: boolean): string {
    if (isMine) return "var(--accent)";
    if (price == null) return "var(--text-muted)";
    if (median == null || median === 0) return "var(--series-1)";
    const pct = ((price - median) / median) * 100;
    if (pct <= -15) return "var(--div-low)";
    if (pct <= -5) return "color-mix(in oklab, var(--div-low) 65%, var(--surface))";
    if (pct < 5) return "var(--baseline)";
    if (pct < 15) return "color-mix(in oklab, var(--div-high) 65%, var(--surface))";
    return "var(--div-high)";
  }

  // ── Map creation ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current || mapRef.current) return;
      const map = L.map(containerRef.current, {
        zoomControl: true,
        scrollWheelZoom: true,
        attributionControl: true,
      }).setView([30.47, -87.2], 12);
      mapRef.current = map;
      poiLayerRef.current = L.layerGroup().addTo(map);
      weatherLayerRef.current = L.layerGroup().addTo(map);
      setReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Base tiles follow the theme ─────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    (async () => {
      const L = (await import("leaflet")).default;
      const map = mapRef.current;
      if (!map) return;
      if (tileRef.current) map.removeLayer(tileRef.current);
      const url =
        theme === "dark"
          ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
      const layer = L.tileLayer(url, {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      }).addTo(map);
      tileRef.current = layer;
      // The base layer is added last, so push it under everything else.
      layer.bringToBack();
    })();
  }, [ready, theme]);

  // ── Traffic overlay ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    (async () => {
      const L = (await import("leaflet")).default;
      const map = mapRef.current;
      if (!map) return;
      if (trafficRef.current) {
        map.removeLayer(trafficRef.current);
        trafficRef.current = null;
      }
      if (!traffic || !TOMTOM_KEY) return;
      trafficRef.current = L.tileLayer(
        `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${TOMTOM_KEY}`,
        {
          maxZoom: 19,
          opacity: 0.85,
          attribution: '&copy; <a href="https://www.tomtom.com">TomTom</a> traffic',
        }
      ).addTo(map);
    })();
  }, [ready, traffic]);

  // ── Places, loaded for whatever is on screen ────────────────────────────
  const activeKinds = (Object.keys(kinds) as PoiKind[]).filter((k) => kinds[k]);
  const kindKey = activeKinds.join(",");

  const loadPois = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !kindKey) {
      setPois([]);
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]
      .map((n) => n.toFixed(5))
      .join(",");
    setPoiBusy(true);
    try {
      const res = await fetch(`/api/map/pois?bbox=${bbox}&kinds=${kindKey}`);
      const j = (await res.json()) as { pois?: Poi[]; skipped?: string; error?: string };
      setPois(j.pois ?? []);
      setPoiNote(j.skipped ?? j.error ?? null);
    } catch (e) {
      setPoiNote((e as Error).message);
    } finally {
      setPoiBusy(false);
    }
  }, [kindKey]);

  // Refetch after the map settles, not on every frame of a pan.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (!map) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => loadPois(), 600);
    };
    map.on("moveend", schedule);
    schedule();
    return () => {
      map.off("moveend", schedule);
      if (timer) clearTimeout(timer);
    };
  }, [ready, loadPois]);

  // Draw them.
  useEffect(() => {
    if (!ready) return;
    (async () => {
      const L = (await import("leaflet")).default;
      const group = poiLayerRef.current;
      if (!group) return;
      group.clearLayers();
      for (const p of pois) {
        if (!kinds[p.kind]) continue;
        const style = POI_STYLE[p.kind];
        const marker = L.circleMarker([p.latitude, p.longitude], {
          radius: 5,
          // A surface-coloured ring keeps overlapping dots separable.
          color: cssVar("--surface", "#ffffff"),
          weight: 2,
          fillColor: cssVar(style.token, style.fallback),
          fillOpacity: 0.9,
        });
        marker.bindPopup(
          `<strong>${escapeHtml(p.name)}</strong><br/>${style.label}${
            p.detail ? ` · ${escapeHtml(p.detail)}` : ""
          }`
        );
        marker.bindTooltip(p.name, { direction: "top" });
        group.addLayer(marker);
      }
    })();
  }, [ready, pois, kinds]);

  // ── Hotel price pills ───────────────────────────────────────────────────
  const signature = points.map((p) => `${p.key}:${p.price ?? ""}`).join("|");
  const fitDone = useRef(false);
  useEffect(() => {
    if (!ready) return;
    (async () => {
      const L = (await import("leaflet")).default;
      const map = mapRef.current;
      if (!map) return;

      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      if (points.length === 0) return;

      for (const p of points) {
        const label = p.price != null ? fmt(p.price) : p.tracked ? "—" : "";
        const bg = toneFor(p.price, p.isMine);
        const html = `
          <div class="rb-pin ${p.isMine ? "rb-pin--mine" : ""} ${
            p.price == null ? "rb-pin--muted" : ""
          }" style="--pin:${bg}">
            ${p.isMine ? '<span class="rb-pin__star">&#9733;</span>' : ""}
            <span class="rb-pin__label">${label || "&middot;"}</span>
          </div>`;
        const icon = L.divIcon({
          html,
          className: "rb-pin-wrap",
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        });
        const marker = L.marker([p.lat, p.lon], {
          icon,
          zIndexOffset: p.isMine ? 1000 : p.tracked ? 500 : 0,
        }).addTo(map);

        const pct =
          p.price != null && median != null && median > 0
            ? `${((p.price - median) / median) * 100 >= 0 ? "+" : ""}${(
                ((p.price - median) / median) *
                100
              ).toFixed(0)}% vs median`
            : p.tracked
              ? "no rate captured"
              : "not tracked for rates";
        const link = p.hotelId
          ? `<br/><a href="https://www.tripadvisor.com/Hotel_Review-${p.hotelId}-Reviews.html" target="_blank" rel="noopener noreferrer">View on TripAdvisor</a>`
          : "";
        marker.bindPopup(
          `<strong>${escapeHtml(p.name)}</strong><br/>${
            p.price != null ? fmt(p.price) : "—"
          } · ${pct}${link}`
        );
        markersRef.current.push(marker);
      }

      // Only frame the hotels once. Refitting on every redraw would fight the
      // user every time they pan to look at something.
      if (!fitDone.current) {
        const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]));
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
          fitDone.current = true;
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, signature, theme]);

  // ── Weather playback ────────────────────────────────────────────────────
  const loadWeather = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]
      .map((n) => n.toFixed(4))
      .join(",");
    setWeatherBusy(true);
    setWeatherNote(null);
    try {
      const res = await fetch(`/api/map/weather?bbox=${bbox}`);
      const j = (await res.json()) as { frames?: WeatherFrame[]; error?: string };
      if (j.error || !j.frames?.length) {
        setWeatherNote(j.error ?? "No forecast came back for this area.");
        return;
      }
      setFrames(j.frames);
      setFrameIndex(0);
      setPlaying(true);
    } catch (e) {
      setWeatherNote((e as Error).message);
    } finally {
      setWeatherBusy(false);
    }
  }, []);

  // Advance the frame while playing, and stop at the end of the twelve hours.
  useEffect(() => {
    if (!playing || !frames) return;
    const id = setInterval(() => {
      setFrameIndex((i) => {
        if (i + 1 >= frames.length) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 900);
    return () => clearInterval(id);
  }, [playing, frames]);

  // Draw the current frame — and nothing at all once playback is dismissed,
  // which is what "only for the duration of this" means.
  useEffect(() => {
    if (!ready) return;
    (async () => {
      const L = (await import("leaflet")).default;
      const group = weatherLayerRef.current;
      if (!group) return;
      group.clearLayers();
      if (!frames) return;
      const frame = frames[Math.min(frameIndex, frames.length - 1)];
      if (!frame) return;

      const temps = frame.cells
        .map((c) => c.temperature)
        .filter((t): t is number => t != null);
      const lo = temps.length ? Math.min(...temps) : 0;
      const hi = temps.length ? Math.max(...temps) : 1;

      for (const cell of frame.cells) {
        if (cell.temperature == null) continue;
        const marker = L.circleMarker([cell.latitude, cell.longitude], {
          radius: 26,
          stroke: false,
          fillColor: tempColor(cell.temperature, lo, hi),
          fillOpacity: 0.32,
          interactive: true,
        });
        marker.bindTooltip(
          `${Math.round(cell.temperature)}°F` +
            (cell.precipitationChance != null ? ` · ${cell.precipitationChance}% rain` : "") +
            (cell.windSpeed != null ? ` · ${Math.round(cell.windSpeed)} mph` : ""),
          { direction: "top" }
        );
        group.addLayer(marker);

        const label = L.marker([cell.latitude, cell.longitude], {
          interactive: false,
          icon: L.divIcon({
            className: "rb-wx-wrap",
            html: `<div class="rb-wx">${Math.round(cell.temperature)}&deg;</div>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
        });
        group.addLayer(label);
      }
    })();
  }, [ready, frames, frameIndex]);

  function stopWeather() {
    setPlaying(false);
    setFrames(null);
    setFrameIndex(0);
  }

  const frame = frames?.[Math.min(frameIndex, frames.length - 1)] ?? null;

  return (
    <div>
      {/* Layer controls sit above the map, in one row. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="kicker mr-1" style={{ color: "var(--text-muted)" }}>
          Show
        </span>
        {(Object.keys(POI_STYLE) as PoiKind[]).map((k) => (
          <button
            key={k}
            onClick={() => setKinds((c) => ({ ...c, [k]: !c[k] }))}
            className="btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px]"
            style={
              kinds[k]
                ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                : undefined
            }
            aria-pressed={kinds[k]}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: `var(${POI_STYLE[k].token})` }}
              aria-hidden
            />
            {POI_STYLE[k].label}
          </button>
        ))}

        <button
          onClick={() => setTraffic((t) => !t)}
          className="btn-ghost px-3 py-1.5 text-[12px]"
          style={
            traffic && TOMTOM_KEY
              ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
              : undefined
          }
          disabled={!TOMTOM_KEY}
          aria-pressed={traffic}
          title={
            TOMTOM_KEY
              ? "Live traffic flow from TomTom"
              : "Set NEXT_PUBLIC_TOMTOM_KEY to enable live traffic — TomTom's free tier covers this"
          }
        >
          Traffic
        </button>

        <span className="ml-auto text-[11px]" style={{ color: "var(--text-muted)" }}>
          {poiBusy ? "Loading places…" : poiNote ? poiNote : `${pois.length} places in view`}
        </span>
      </div>

      {!TOMTOM_KEY && traffic && (
        <p className="mb-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Live traffic needs a key. TomTom&rsquo;s free tier covers a dashboard
          like this — add it as <code>NEXT_PUBLIC_TOMTOM_KEY</code> and the layer
          turns on. Nothing is drawn without real data.
        </p>
      )}

      <div
        ref={containerRef}
        style={{
          height: 560,
          width: "100%",
          borderRadius: 10,
          overflow: "hidden",
          background: "var(--surface-2)",
        }}
      />

      {/* Weather playback, below the map, only running while asked. */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {!frames ? (
          <>
            <button
              onClick={loadWeather}
              disabled={weatherBusy}
              className="btn-accent px-4 py-2 text-[13px]"
            >
              {weatherBusy ? "Loading forecast…" : "Play 12 hour weather"}
            </button>
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {weatherNote ??
                "Twelve hours of forecast across the area on screen, from Open-Meteo."}
            </span>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                if (!playing && frameIndex >= (frames?.length ?? 0) - 1) setFrameIndex(0);
                setPlaying((p) => !p);
              }}
              className="btn-accent px-4 py-2 text-[13px]"
            >
              {playing ? "Pause" : "Play"}
            </button>
            <input
              type="range"
              min={0}
              max={frames.length - 1}
              value={frameIndex}
              onChange={(e) => {
                setPlaying(false);
                setFrameIndex(Number(e.target.value));
              }}
              className="min-w-[180px] flex-1"
              aria-label="Forecast hour"
            />
            <span className="tabular-nums text-[12px]" style={{ color: "var(--text-primary)" }}>
              {frame ? hourLabel(frame.time) : ""}
            </span>
            {frame && <WeatherSummary frame={frame} />}
            <button onClick={stopWeather} className="btn-ghost px-3 py-1.5 text-[12px]">
              Clear
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function WeatherSummary({ frame }: { frame: WeatherFrame }) {
  const temps = frame.cells.map((c) => c.temperature).filter((t): t is number => t != null);
  const rain = frame.cells
    .map((c) => c.precipitationChance)
    .filter((t): t is number => t != null);
  if (temps.length === 0) return null;
  const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
  const maxRain = rain.length ? Math.max(...rain) : null;
  return (
    <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
      {Math.round(Math.min(...temps))}–{Math.round(Math.max(...temps))}°F across the view,
      averaging {Math.round(avg)}°
      {maxRain != null ? ` · rain chance up to ${maxRain}%` : ""}
    </span>
  );
}

// Leaflet renders vectors by writing `fill` and `stroke` as SVG presentation
// attributes. var() and color-mix() are not substituted there, so every colour
// handed to a circleMarker has to be a literal. Read the token off the root
// element instead — which also means the values track the theme.
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function parseColor(input: string): [number, number, number] | null {
  const hex = input.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = input.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [parts[0], parts[1], parts[2]];
    }
  }
  return null;
}

function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return a;
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Temperature is a two-ended scale — cold at one end, hot at the other — so it
// takes the diverging pair with the neutral midpoint, not a rainbow.
function tempColor(value: number, lo: number, hi: number): string {
  const cool = cssVar("--div-low", "#2e7ff0");
  const mid = cssVar("--div-mid", "#f1f5fb");
  const warm = cssVar("--div-high", "#e2564f");
  if (hi <= lo) return mid;
  const t = Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  return t < 0.5 ? mix(cool, mid, t * 2) : mix(mid, warm, (t - 0.5) * 2);
}

function hourLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c
  );
}
