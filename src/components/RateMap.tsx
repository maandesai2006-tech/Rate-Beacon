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
//   weather  NEXRAD rain radar from the Iowa Environmental Mesonet, animated
//            over the last fifty minutes, plus an OpenWeather temperature field
//
// Every layer is an independent toggle. Traffic is the only one that needs a
// key, and it says so rather than drawing a stand-in.

type PoiKind = "lodging" | "food" | "attraction" | "shop";

interface Poi {
  osmId: string;
  kind: PoiKind;
  name: string;
  latitude: number;
  longitude: number;
  detail: string | null;
}

/** Everything the user can switch on or off, in one list. */
type LayerKey = "radar" | "temperature" | "traffic" | PoiKind;

// Weather rasters are generated at coarse zooms and answer anything deeper
// with a grey "Zoom Level Not Supported" placeholder — which is exactly what
// tiles the map once it frames a single town. maxNativeZoom tells Leaflet to
// stop asking past that point and upscale the last real tile instead, which
// is how every weather app renders these layers close in.
const OPENWEATHER_MAX_NATIVE_ZOOM = 9;

/**
 * IEM publishes the NEXRAD composite as "now" plus five-minute steps back to
 * fifty minutes. Ordered oldest → newest so playback runs forwards.
 */
const RADAR_OFFSETS: { suffix: string; minutesAgo: number }[] = [
  ...Array.from({ length: 10 }, (_, i) => {
    const minutesAgo = 50 - i * 5;
    return { suffix: `-m${String(minutesAgo).padStart(2, "0")}m`, minutesAgo };
  }),
  { suffix: "", minutesAgo: 0 },
];

// Radar covers a small part of the frame, so it can sit strong. Temperature
// covers all of it and would become wallpaper at the same value.
const RADAR_OPACITY = 0.8;
const TEMPERATURE_OPACITY = 0.45;

const LAYER_LABEL: Record<LayerKey, string> = {
  radar: "Rain radar",
  temperature: "Temperature",
  traffic: "Traffic",
  lodging: "Other hotels",
  food: "Restaurants",
  attraction: "Attractions",
  shop: "Shops",
};

const POI_STYLE: Record<PoiKind, { label: string; token: string; fallback: string }> = {
  lodging: { label: "Other hotels", token: "--text-muted", fallback: "#6b7a90" },
  food: { label: "Restaurants", token: "--status-serious", fallback: "#d1662f" },
  attraction: { label: "Attractions", token: "--status-good", fallback: "#12915a" },
  shop: { label: "Shops", token: "--status-warning", fallback: "#c08512" },
};

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
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const fitDone = useRef(false);
  // Latest points, read by the resize handler without re-running its effect.
  const pointsRef = useRef<{ lat: number; lon: number }[]>([]);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Layer[]>([]);
  const tileRef = useRef<TileLayer | null>(null);
  const poiLayerRef = useRef<LayerGroup | null>(null);
  const trafficRef = useRef<TileLayer | null>(null);
  const [ready, setReady] = useState(false);

  // One flat set of toggles. Radar and temperature are on from the start —
  // a weather map that shows no weather until you find a button is not a
  // weather map.
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    radar: true,
    temperature: true,
    traffic: false,
    lodging: true,
    food: true,
    attraction: true,
    shop: false,
  });
  const kinds = layers;
  const [trafficStatus, setTrafficStatus] = useState<{
    available: boolean;
    detail: string;
  } | null>(null);
  const [pois, setPois] = useState<Poi[]>([]);
  const [poiNote, setPoiNote] = useState<string | null>(null);
  const [poiBusy, setPoiBusy] = useState(false);

  const [playing, setPlaying] = useState(true);
  // Playback position as a float, so the field is interpolated between
  // frames rather than stepping — that continuous drift is what makes it read
  // as an animation instead of a slideshow.
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  // One cached tile layer per radar frame, so looping does not refetch.
  const radarTilesRef = useRef<Map<number, TileLayer>>(new Map());
  const tempTileRef = useRef<TileLayer | null>(null);

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

  // Frame the tracked hotels. Only ever runs when the container has a real
  // size — fitting against a 0x0 box is what produced the world view.
  const refit = useCallback(async (map: LeafletMap) => {
    const size = map.getSize();
    if (size.x < 50 || size.y < 50) return;
    const pts = pointsRef.current;
    if (pts.length === 0) return;
    const L = (await import("leaflet")).default;
    const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lon] as [number, number]));
    if (!bounds.isValid()) return;
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
    fitDone.current = true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/map/traffic/status")
      .then((r) => r.json())
      .then((j: { available?: boolean; detail?: string }) => {
        if (cancelled) return;
        setTrafficStatus({ available: Boolean(j.available), detail: j.detail ?? "" });
      })
      .catch(() => {
        if (!cancelled) setTrafficStatus({ available: false, detail: "Traffic status unavailable." });
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      const tempPane = map.createPane("temperature");
      tempPane.style.zIndex = "340";
      tempPane.style.pointerEvents = "none";
      tempPane.classList.add("rb-weather-pane");
      tempPane.dataset.source = "openweather";

      const trafficPane = map.createPane("traffic");
      trafficPane.style.zIndex = "360";
      trafficPane.style.pointerEvents = "none";

      const pane = map.createPane("weather");
      pane.style.zIndex = "350";
      pane.style.pointerEvents = "none";
      pane.classList.add("rb-weather-pane");
      pane.dataset.source = "radar";
      poiLayerRef.current = L.layerGroup().addTo(map);

      // Re-measure as soon as the container has been laid out, and again
      // whenever it changes size. Without this the map keeps whatever
      // geometry it guessed at 0x0 and never recovers.
      const remeasure = () => {
        map.invalidateSize({ animate: false });
        // The first honest measurement is also the first chance to frame the
        // hotels correctly.
        if (!fitDone.current) refit(map);
      };
      requestAnimationFrame(remeasure);

      const container = containerRef.current;
      if (container && typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => map.invalidateSize({ animate: false }));
        ro.observe(container);
        resizeObserverRef.current = ro;
      }

      setReady(true);
    })();
    return () => {
      cancelled = true;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
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
  // Proxied so the key never reaches the browser, and re-created on a theme
  // change because TomTom ships a light and a dark styling of the same data.
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
      if (!layers.traffic || !trafficStatus?.available) return;
      trafficRef.current = L.tileLayer(
        `/api/map/traffic/tile/{z}/{x}/{y}?theme=${theme}`,
        {
          maxZoom: 19,
          maxNativeZoom: 18,
          opacity: 0.9,
          pane: "traffic",
          attribution: '&copy; <a href="https://www.tomtom.com">TomTom</a>',
        }
      ).addTo(map);
    })();
  }, [ready, layers.traffic, theme, trafficStatus?.available]);

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
  pointsRef.current = points.map((p) => ({ lat: p.lat, lon: p.lon }));
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

      // Frame the hotels once. Refitting on every redraw would fight the user
      // each time they pan to look at something.
      if (!fitDone.current) await refit(map);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, signature, theme]);

  // ── Weather field ───────────────────────────────────────────────────────
  // ── Weather overlays ────────────────────────────────────────────────────
  //
  // Radar comes from the Iowa Environmental Mesonet's NEXRAD composite. It is
  // free, keyless, rendered to street zoom, and it is the actual US radar
  // mosaic rather than a coarse global product — which is why the previous
  // source turned into grey placeholder tiles the moment the map framed a
  // town. IEM also publishes the same composite at five-minute offsets for
  // the last fifty minutes, so it animates without a paid plan.
  //
  // Temperature stays on OpenWeather because nothing free serves a
  // temperature raster at higher resolution. It is a coarse field by nature —
  // upscaled it reads as a smooth gradient, which is all a temperature
  // overlay ever conveys.
  // Newest first in IEM's naming, so the list is reversed to run forwards.
  const radarFrames = RADAR_OFFSETS;
  const timelineLength = layers.radar ? radarFrames.length : 0;
  const frameIndex = Math.min(Math.round(cursor), Math.max(0, timelineLength - 1));

  useEffect(() => {
    if (!playing || timelineLength < 2) return;
    const last = timelineLength - 1;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = now - prev;
      prev = now;
      const next = cursorRef.current + dt / 500;
      if (next >= last) {
        // Radar is a loop, not a story with an ending.
        cursorRef.current = 0;
        setCursor(0);
      } else {
        cursorRef.current = next;
        setCursor(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, timelineLength]);

  // Radar: one cached layer per five-minute offset, crossfaded.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      const map = mapRef.current;
      if (cancelled || !map) return;

      if (!layers.radar) {
        for (const layer of radarTilesRef.current.values()) map.removeLayer(layer);
        radarTilesRef.current.clear();
        return;
      }

      const layerFor = (index: number) => {
        if (index < 0 || index >= radarFrames.length) return null;
        const existing = radarTilesRef.current.get(index);
        if (existing) return existing;
        const suffix = radarFrames[index].suffix;
        const layer = L.tileLayer(
          `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913${suffix}/{z}/{x}/{y}.png`,
          {
            maxZoom: 19,
            maxNativeZoom: 15,
            opacity: 0,
            pane: "weather",
            attribution:
              '&copy; <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a>',
          }
        ).addTo(map);
        radarTilesRef.current.set(index, layer);
        return layer;
      };

      const current = layerFor(frameIndex);
      if (current) current.setOpacity(RADAR_OPACITY);
      layerFor(frameIndex + 1);
      for (const [index, layer] of radarTilesRef.current) {
        if (index !== frameIndex) layer.setOpacity(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, layers.radar, frameIndex, radarFrames]);

  // Temperature: a single current raster, no timeline.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      const map = mapRef.current;
      if (cancelled || !map) return;
      if (tempTileRef.current) {
        map.removeLayer(tempTileRef.current);
        tempTileRef.current = null;
      }
      if (!layers.temperature) return;
      tempTileRef.current = L.tileLayer("/api/map/weather/tile/temperature/{z}/{x}/{y}", {
        maxZoom: 19,
        maxNativeZoom: OPENWEATHER_MAX_NATIVE_ZOOM,
        opacity: TEMPERATURE_OPACITY,
        pane: "temperature",
        attribution: '&copy; <a href="https://openweathermap.org/">OpenWeather</a>',
      }).addTo(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, layers.temperature]);


  const activeRadar = layers.radar ? radarFrames[frameIndex] : null;
  const clockLabel = activeRadar ? radarLabel(activeRadar.minutesAgo) : "";

  return (
    <div>
      {/* Layer controls sit above the map, in one row. */}
      {/* Every layer in one row of filters: weather, traffic and places all
          switch the same way, because to a user they are the same kind of
          thing. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="kicker mr-1" style={{ color: "var(--text-muted)" }}>
          Layers
        </span>
        {(["radar", "temperature", "traffic", "lodging", "food", "attraction", "shop"] as LayerKey[]).map(
          (k) => {
            const on = layers[k];
            const swatch = k in POI_STYLE ? `var(${POI_STYLE[k as PoiKind].token})` : null;
            const needsKey = k === "traffic" && trafficStatus?.available === false;
            return (
              <button
                key={k}
                onClick={() => setLayers((c) => ({ ...c, [k]: !c[k] }))}
                className="btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px]"
                aria-pressed={on}
                title={
                  needsKey
                    ? "Live traffic needs a free TomTom key — set NEXT_PUBLIC_TOMTOM_KEY on the deployment"
                    : LAYER_LABEL[k]
                }
                style={
                  on
                    ? {
                        borderColor: "var(--accent)",
                        background: "var(--accent-soft)",
                        color: "var(--accent)",
                      }
                    : undefined
                }
              >
                {swatch && (
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ background: swatch }}
                    aria-hidden
                  />
                )}
                {LAYER_LABEL[k]}
                {needsKey && (
                  <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                    key needed
                  </span>
                )}
              </button>
            );
          }
        )}

        <span className="ml-auto text-[11px]" style={{ color: "var(--text-muted)" }}>
          {poiBusy ? "Loading places…" : poiNote ? poiNote : `${pois.length} places in view`}
        </span>
      </div>

      {layers.traffic && trafficStatus && !trafficStatus.available && (
        <p className="mb-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {trafficStatus.detail} Traffic is the one layer here with no keyless
          source — nothing is drawn without real data.
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

      {/* Layer picker and the radar clock. The forecast range lives with the
      {/* The radar clock. Only radar has a timeline — temperature is a single
          current field, and saying so beats a control that does nothing. */}
      {layers.radar && timelineLength > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={() => setPlaying((p) => !p)}
            className="btn-ghost px-3 py-1.5 text-[12px]"
          >
            {playing ? "Pause" : "Play"}
          </button>
          <input
            type="range"
            min={0}
            max={timelineLength - 1}
            step={0.01}
            value={Math.min(cursor, timelineLength - 1)}
            onChange={(e) => {
              setPlaying(false);
              const v = Number(e.target.value);
              cursorRef.current = v;
              setCursor(v);
            }}
            className="min-w-[160px] max-w-[320px] flex-1"
            aria-label="Radar time"
          />
          <span
            className="tabular-nums text-[12px] font-medium"
            style={{ color: "var(--text-primary)", minWidth: 74 }}
          >
            {clockLabel}
          </span>
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            NEXRAD composite, last 50 minutes
          </span>
        </div>
      )}
    </div>
  );
}

function radarLabel(minutesAgo: number): string {
  return minutesAgo === 0 ? "Now" : `${minutesAgo} min ago`;
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
