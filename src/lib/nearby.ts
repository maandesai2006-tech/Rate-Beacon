// What hotels are actually near a point, from OpenStreetMap.
//
// Competitor discovery has always started from the rate provider's own market
// listing, and that listing has never answered — thirteen request shapes across
// two endpoints, all refused, so the directory is empty and no competitive set
// has ever been produced. Every market is equally empty, so a new customer in a
// town nobody has onboarded gets nothing at all.
//
// OpenStreetMap answers everywhere and needs no key. What it does not carry is
// a TripAdvisor key, and without one a hotel cannot be priced — so these are
// candidates, not competitors. They are matched against hotels we can already
// price, and whatever is left is offered to the operator as "here are your real
// neighbours, link the ones you want". That is a far shorter task than being
// asked to think of competitors and find each one yourself, and it is honest
// about which of them we can actually follow.
//
// Overpass is a shared free service. It rate-limits, mirrors go down, and it
// refuses some datacenter addresses outright, so every mirror is tried in turn
// and the reason each failed is kept for the diagnostics endpoint.

import { milesBetween } from "./hotel-match";

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
];

export interface NearbyHotel {
  /** Stable within OSM, used to dedupe across refreshes. */
  osmId: string;
  name: string;
  latitude: number;
  longitude: number;
  /** Brand or operator when OSM records one — useful for matching. */
  brand: string | null;
  distanceMiles: number;
}

/** Why each mirror failed on the last attempt, for the system check to report. */
export let lastNearbyErrors: string[] = [];

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Hotels within a radius of a point.
 *
 * Motels, inns and guest houses count — a budget property's compset is other
 * budget properties, and OSM tags them separately. Anything without a name is
 * dropped: an unnamed building cannot be matched to a rate feed or recognised
 * by an operator.
 */
export async function hotelsNear(
  latitude: number,
  longitude: number,
  radiusMiles: number,
  limit = 60
): Promise<NearbyHotel[]> {
  const metres = Math.round(Math.min(radiusMiles, 50) * 1609.34);
  const query = `
    [out:json][timeout:25];
    (
      node["tourism"~"^(hotel|motel|guest_house|hostel)$"](around:${metres},${latitude},${longitude});
      way["tourism"~"^(hotel|motel|guest_house|hostel)$"](around:${metres},${latitude},${longitude});
    );
    out center ${Math.min(limit * 3, 300)};
  `;

  const errors: string[] = [];

  for (const mirror of MIRRORS) {
    try {
      const res = await fetch(mirror, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "RateBeacon/1.0 (hotel rate dashboard; competitor discovery)",
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(28_000),
      });

      if (!res.ok) {
        errors.push(`${host(mirror)}: HTTP ${res.status}`);
        continue;
      }

      const json = (await res.json()) as { elements?: OverpassElement[] };
      const anchor = { latitude, longitude };
      const seen = new Map<string, NearbyHotel>();

      for (const el of json.elements ?? []) {
        const name = el.tags?.name?.trim();
        if (!name) continue;
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        if (lat == null || lon == null) continue;

        const distance = milesBetween(anchor, { latitude: lat, longitude: lon });
        if (distance > radiusMiles) continue;

        const osmId = `${el.type}/${el.id}`;
        if (seen.has(osmId)) continue;
        seen.set(osmId, {
          osmId,
          name,
          latitude: lat,
          longitude: lon,
          brand: el.tags?.brand ?? el.tags?.operator ?? null,
          distanceMiles: distance,
        });
      }

      lastNearbyErrors = errors;
      return [...seen.values()]
        .sort((a, b) => a.distanceMiles - b.distanceMiles)
        .slice(0, limit);
    } catch (e) {
      const err = e as Error;
      errors.push(`${host(mirror)}: ${err.name === "TimeoutError" ? "timed out" : err.message}`);
    }
  }

  lastNearbyErrors = errors;
  return [];
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
