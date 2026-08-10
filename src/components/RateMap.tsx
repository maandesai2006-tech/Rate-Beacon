"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, Marker } from "leaflet";
import type { GridRow, Hotel, MapPlace } from "@/lib/types";

// Real slippy map: OpenStreetMap tiles with zoom and pan, hotels drawn as
// price pills. Tile style follows the app theme so the markers stay legible.
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
  const markersRef = useRef<Marker[]>([]);
  const tileRef = useRef<ReturnType<typeof import("leaflet").tileLayer> | null>(null);
  const [ready, setReady] = useState(false);

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

  // Create the map once.
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
      setReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Swap tiles when the theme changes.
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
      tileRef.current = L.tileLayer(url, {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      }).addTo(map);
    })();
  }, [ready, theme]);

  // Redraw markers whenever the night or the point set changes.
  const signature = points
    .map((p) => `${p.key}:${p.price ?? ""}`)
    .join("|");
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
          `<strong>${p.name}</strong><br/>${
            p.price != null ? fmt(p.price) : "—"
          } · ${pct}${link}`
        );
        markersRef.current.push(marker);
      }

      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]));
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, signature, theme]);

  return (
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
  );
}
