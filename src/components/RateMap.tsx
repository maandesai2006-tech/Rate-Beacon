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
//   weather  OpenWeather's map rasters over 12h, 24h or 7 days, played back
//
// Places are keyless. Traffic and weather take keys, both on free tiers, and
// both say so plainly when the key is missing rather than drawing a stand-in.

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

interface WeatherField {
  range: WeatherRange;
  grid: number;
  bbox: { south: number; west: number; north: number; east: number };
  frames: WeatherFrame[];
}

type WeatherRange = "12h" | "24h" | "7d";
type WeatherMetric = "precipitation" | "temperature" | "clouds" | "wind";

// Enough that the base map's streets and the price pills stay readable
// through it, which is the difference between an overlay and a wallpaper.
const WEATHER_OPACITY = 0.62;

const METRIC_LABEL: Record<WeatherMetric, string> = {
  precipitation: "Rain",
  temperature: "Temperature",
  clouds: "Clouds",
  wind: "Wind",
};

const RANGE_LABEL: Record<WeatherRange, string> = {
  "12h": "12 hours",
  "24h": "24 hours",
  "7d": "7 days",
};

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

  const [field, setField] = useState<WeatherField | null>(null);
  const [range, setRange] = useState<WeatherRange>("12h");
  const [metric, setMetric] = useState<WeatherMetric>("precipitation");
  const [playing, setPlaying] = useState(false);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [weatherNote, setWeatherNote] = useState<string | null>(null);
  // Playback position as a float, so the field is interpolated between
  // frames rather than stepping — that continuous drift is what makes it read
  // as an animation instead of a slideshow.
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  // One cached tile layer per forecast hour, so replaying does not refetch.
  const weatherTilesRef = useRef<Map<number, TileLayer>>(new Map());
  const [capability, setCapability] = useState<{
    configured: boolean;
    forecast: boolean;
    detail: string | null;
  } | null>(null);

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
      // Its own pane: above the base tiles, below the price pins, and
      // addressable from CSS so the palette can be tuned to this map.
      const pane = map.createPane("weather");
      pane.style.zIndex = "350";
      pane.style.pointerEvents = "none";
      pane.classList.add("rb-weather-pane");
      poiLayerRef.current = L.layerGroup().addTo(map);
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

  // ── Weather field ───────────────────────────────────────────────────────
  // ── Weather overlay ─────────────────────────────────────────────────────
  // The picture comes from OpenWeather's map tiles — the same multicolour
  // rasters a weather app draws — proxied so the key stays server-side. The
  // numbers in the readout come from Open-Meteo, which gives exact values per
  // hour that a tile image cannot.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/map/weather/capability")
      .then((r) => r.json())
      .then((j: { configured?: boolean; forecast?: boolean; detail?: string }) => {
        if (cancelled) return;
        setCapability({
          configured: Boolean(j.configured),
          forecast: Boolean(j.forecast),
          detail: j.detail ?? null,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const loadWeather = useCallback(async (next: WeatherRange) => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]
      .map((n) => n.toFixed(4))
      .join(",");
    setWeatherBusy(true);
    setWeatherNote(null);
    try {
      const res = await fetch(`/api/map/weather?bbox=${bbox}&range=${next}`);
      const j = (await res.json()) as Partial<WeatherField> & { error?: string };
      if (j.error || !j.frames?.length || !j.bbox || !j.grid) {
        setWeatherNote(j.error ?? "No forecast came back for this area.");
        return;
      }
      setField({ range: next, grid: j.grid, bbox: j.bbox, frames: j.frames });
      cursorRef.current = 0;
      setCursor(0);
      setPlaying(true);
    } catch (e) {
      setWeatherNote((e as Error).message);
    } finally {
      setWeatherBusy(false);
    }
  }, []);

  // Advance on the animation frame rather than a timer, so the clock runs
  // smoothly and stops cleanly at the end of the range.
  useEffect(() => {
    if (!playing || !field) return;
    const last = field.frames.length - 1;
    // A day of forecast takes roughly the same wall time whichever range is
    // on, so seven days plays faster per frame than twelve hours.
    const perFrame = field.range === "7d" ? 1100 : 750;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = now - prev;
      prev = now;
      const next = cursorRef.current + dt / perFrame;
      if (next >= last) {
        cursorRef.current = last;
        setCursor(last);
        setPlaying(false);
        return;
      }
      cursorRef.current = next;
      setCursor(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, field]);

  // One tile layer per forecast hour, created lazily and kept. Crossfading
  // between two raster layers is how a weather app animates radar; swapping a
  // single layer's URL would blink white while the new tiles load.
  const frameIndex = Math.round(cursor);
  useEffect(() => {
    if (!ready || !field) return;
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default;
      const map = mapRef.current;
      if (cancelled || !map) return;

      const layerFor = (index: number) => {
        const existing = weatherTilesRef.current.get(index);
        if (existing) return existing;
        const frame = field.frames[index];
        if (!frame) return null;
        const stamp = Math.floor(new Date(frame.time).getTime() / 1000);
        // Without forecast tiles there is only ever one image, so every frame
        // shares it rather than requesting the same picture repeatedly.
        const query = capability?.forecast ? `?date=${stamp}` : "";
        const layer = L.tileLayer(`/api/map/weather/tile/${metric}/{z}/{x}/{y}${query}`, {
          maxZoom: 19,
          opacity: 0,
          pane: "weather",
          attribution: '&copy; <a href="https://openweathermap.org/">OpenWeather</a>',
        }).addTo(map);
        weatherTilesRef.current.set(index, layer);
        return layer;
      };

      const current = layerFor(frameIndex);
      if (current) current.setOpacity(WEATHER_OPACITY);
      // Warm the next hour so the crossfade has tiles ready to show.
      if (capability?.forecast) layerFor(frameIndex + 1);

      for (const [index, layer] of weatherTilesRef.current) {
        if (index !== frameIndex) layer.setOpacity(0);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, field, frameIndex, metric, capability]);

  // Changing metric or clearing the overlay discards every cached layer;
  // they are keyed by hour, not by metric.
  const clearWeatherLayers = useCallback(() => {
    const map = mapRef.current;
    for (const layer of weatherTilesRef.current.values()) {
      if (map) map.removeLayer(layer);
    }
    weatherTilesRef.current.clear();
  }, []);

  useEffect(() => {
    clearWeatherLayers();
  }, [metric, clearWeatherLayers]);

  useEffect(() => clearWeatherLayers, [clearWeatherLayers]);

  function stopWeather() {
    setPlaying(false);
    setField(null);
    clearWeatherLayers();
    cursorRef.current = 0;
    setCursor(0);
  }


  const activeFrame = field?.frames[Math.round(cursor)] ?? null;

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

      <div className="relative">
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
      </div>

      {/* Forecast playback, below the map. The field only exists while it is
          being watched — clearing removes the layer entirely. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(["12h", "24h", "7d"] as WeatherRange[]).map((r) => (
          <button
            key={r}
            onClick={() => {
              setRange(r);
              loadWeather(r);
            }}
            disabled={weatherBusy}
            className="btn-ghost px-3 py-1.5 text-[12px]"
            style={
              field && range === r
                ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                : undefined
            }
          >
            {RANGE_LABEL[r]}
          </button>
        ))}

        {field && (
          <>
            <span className="mx-1" style={{ color: "var(--border)" }} aria-hidden>
              |
            </span>
            {(Object.keys(METRIC_LABEL) as WeatherMetric[]).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className="btn-ghost px-3 py-1.5 text-[12px]"
                style={
                  metric === m
                    ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                    : undefined
                }
              >
                {METRIC_LABEL[m]}
              </button>
            ))}
          </>
        )}

        {!field && (
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {weatherBusy
              ? "Loading forecast…"
              : (weatherNote ??
                "Weather overlay from OpenWeather, readings from Open-Meteo.")}
          </span>
        )}
      </div>

      {field && capability && !capability.forecast && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {capability.configured
            ? "The overlay shows current conditions — this OpenWeather plan does not include forecast tiles, so the map does not change as the clock advances. The readings beside it are real forecast values."
            : "Set OPENWEATHER_API_KEY on the deployment to draw the weather overlay."}
        </p>
      )}

      {field && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            onClick={() => {
              if (!playing && cursorRef.current >= field.frames.length - 1) {
                cursorRef.current = 0;
                setCursor(0);
              }
              setPlaying((p) => !p);
            }}
            className="btn-accent px-4 py-2 text-[13px]"
          >
            {playing ? "Pause" : "Play"}
          </button>
          <input
            type="range"
            min={0}
            max={field.frames.length - 1}
            step={0.01}
            value={cursor}
            disabled={capability != null && !capability.forecast}
            onChange={(e) => {
              setPlaying(false);
              const v = Number(e.target.value);
              cursorRef.current = v;
              setCursor(v);
            }}
            className="min-w-[200px] flex-1"
            aria-label="Forecast time"
          />
          <span
            className="tabular-nums text-[13px] font-medium"
            style={{ color: "var(--text-primary)", minWidth: 92 }}
          >
            {activeFrame ? frameLabel(activeFrame.time, field.range) : ""}
          </span>
          {activeFrame && <WeatherSummary frame={activeFrame} range={field.range} />}
          <button onClick={stopWeather} className="btn-ghost px-3 py-1.5 text-[12px]">
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function WeatherSummary({ frame, range }: { frame: WeatherFrame; range: WeatherRange }) {
  const temps = frame.cells.map((c) => c.temperature).filter((t): t is number => t != null);
  const rain = frame.cells.map((c) => c.precipitationChance).filter((t): t is number => t != null);
  if (temps.length === 0) return null;
  const maxRain = rain.length ? Math.max(...rain) : null;
  return (
    <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
      {Math.round(Math.min(...temps))}&ndash;{Math.round(Math.max(...temps))}&deg;F
      {range === "7d" ? " high" : ""}
      {maxRain != null ? ` · rain to ${maxRain}%` : ""}
    </span>
  );
}

function frameLabel(iso: string, range: WeatherRange): string {
  const d = new Date(range === "7d" ? `${iso}T12:00:00` : iso);
  return range === "7d"
    ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c
  );
}
