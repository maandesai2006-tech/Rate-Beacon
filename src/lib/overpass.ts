// Nearby hotels from OpenStreetMap via the Overpass API — free, keyless, and
// independent of the rate feed. One query returns every lodging POI within a
// radius, already carrying coordinates, so the map never waits on per-hotel
// geocoding.

export interface NearbyPlace {
  osmId: string;
  name: string;
  latitude: number;
  longitude: number;
  brand: string | null;
  stars: number | null;
}

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export async function hotelsNear(
  lat: number,
  lon: number,
  radiusM = 6000,
  limit = 60
): Promise<NearbyPlace[]> {
  const query = `
    [out:json][timeout:25];
    (
      node["tourism"~"^(hotel|motel|apartment)$"](around:${radiusM},${lat},${lon});
      way["tourism"~"^(hotel|motel|apartment)$"](around:${radiusM},${lat},${lon});
    );
    out center ${limit};
  `;

  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "RateBeacon/1.0 (hotel rate dashboard)",
        },
        body: `data=${encodeURIComponent(query)}`,
        cache: "no-store",
      });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        elements?: {
          type: string;
          id: number;
          lat?: number;
          lon?: number;
          center?: { lat: number; lon: number };
          tags?: Record<string, string>;
        }[];
      };
      const out: NearbyPlace[] = [];
      for (const el of json.elements ?? []) {
        const name = el.tags?.name;
        const latitude = el.lat ?? el.center?.lat;
        const longitude = el.lon ?? el.center?.lon;
        if (!name || latitude == null || longitude == null) continue;
        const stars = el.tags?.stars ? parseFloat(el.tags.stars) : null;
        out.push({
          osmId: `${el.type}/${el.id}`,
          name,
          latitude,
          longitude,
          brand: el.tags?.brand ?? el.tags?.operator ?? null,
          stars: stars != null && !Number.isNaN(stars) ? stars : null,
        });
      }
      return out;
    } catch {
      // Try the next mirror.
    }
  }
  return [];
}

// ── Points of interest around the hotels ─────────────────────────────────
// What a rate decision actually keys off locally: where people eat, what
// brings them to town, and where they shop. All from the same free, keyless
// OSM data as the hotels.

export type PoiKind = "lodging" | "food" | "attraction" | "shop";

export interface Poi {
  osmId: string;
  kind: PoiKind;
  name: string;
  latitude: number;
  longitude: number;
  detail: string | null;
}

// Each kind is one OSM selector set. Keeping them separate lets the map turn
// layers on and off without refetching everything.
const KIND_FILTERS: Record<PoiKind, string[]> = {
  lodging: [`["tourism"~"^(hotel|motel|hostel|guest_house|apartment)$"]`],
  food: [`["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court)$"]`],
  attraction: [
    `["tourism"~"^(attraction|museum|theme_park|zoo|aquarium|viewpoint|gallery|artwork)$"]`,
    `["leisure"~"^(park|beach_resort|water_park|stadium|marina|golf_course)$"]`,
    `["natural"="beach"]`,
  ],
  shop: [
    `["shop"~"^(mall|department_store|supermarket|convenience|outdoor|clothes|gift|sports)$"]`,
    `["amenity"="marketplace"]`,
  ],
};

function detailFor(kind: PoiKind, tags: Record<string, string>): string | null {
  if (kind === "food") return tags.cuisine?.replace(/[_;]/g, " ") ?? tags.amenity ?? null;
  if (kind === "shop") return tags.shop?.replace(/_/g, " ") ?? tags.amenity ?? null;
  if (kind === "attraction") return tags.tourism?.replace(/_/g, " ") ?? tags.leisure?.replace(/_/g, " ") ?? null;
  return tags.brand ?? tags.operator ?? null;
}

/**
 * Everything of the requested kinds inside a bounding box.
 *
 * Bounded by the map's own viewport rather than a radius, so panning to a
 * neighbouring area fills in rather than showing a hole. One request covers
 * every kind, because Overpass rate-limits per request, not per element.
 */
export async function poisInBounds(
  bbox: { south: number; west: number; north: number; east: number },
  kinds: PoiKind[],
  limit = 800
): Promise<Poi[]> {
  const { south, west, north, east } = bbox;
  const box = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;

  const clauses = kinds
    .flatMap((kind) =>
      KIND_FILTERS[kind].flatMap((filter) => [
        `node${filter}(${box});`,
        `way${filter}(${box});`,
      ])
    )
    .join("\n      ");

  const query = `
    [out:json][timeout:30];
    (
      ${clauses}
    );
    out center ${limit};
  `;

  const elements = await runOverpass(query);
  const out: Poi[] = [];
  const seen = new Set<string>();

  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags.name;
    const latitude = el.lat ?? el.center?.lat;
    const longitude = el.lon ?? el.center?.lon;
    // An unnamed POI is a dot with nothing to say; skip rather than clutter.
    if (!name || latitude == null || longitude == null) continue;

    const kind = kindOf(tags, kinds);
    if (!kind) continue;

    const osmId = `${el.type}/${el.id}`;
    if (seen.has(osmId)) continue;
    seen.add(osmId);

    out.push({ osmId, kind, name, latitude, longitude, detail: detailFor(kind, tags) });
  }
  return out;
}

// A place can carry tags for more than one kind (a hotel with a restaurant).
// Resolve in the caller's requested order so the layer toggles stay coherent.
function kindOf(tags: Record<string, string>, requested: PoiKind[]): PoiKind | null {
  const is: Record<PoiKind, boolean> = {
    lodging: /^(hotel|motel|hostel|guest_house|apartment)$/.test(tags.tourism ?? ""),
    food: /^(restaurant|cafe|fast_food|bar|pub|food_court)$/.test(tags.amenity ?? ""),
    attraction:
      /^(attraction|museum|theme_park|zoo|aquarium|viewpoint|gallery|artwork)$/.test(tags.tourism ?? "") ||
      /^(park|beach_resort|water_park|stadium|marina|golf_course)$/.test(tags.leisure ?? "") ||
      tags.natural === "beach",
    shop:
      /^(mall|department_store|supermarket|convenience|outdoor|clothes|gift|sports)$/.test(tags.shop ?? "") ||
      tags.amenity === "marketplace",
  };
  const order: PoiKind[] = ["lodging", "attraction", "food", "shop"];
  for (const k of order) {
    if (is[k] && requested.includes(k)) return k;
  }
  return null;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function runOverpass(query: string): Promise<OverpassElement[]> {
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "RateBeacon/1.0 (hotel rate dashboard)",
        },
        body: `data=${encodeURIComponent(query)}`,
        cache: "no-store",
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { elements?: OverpassElement[] };
      return json.elements ?? [];
    } catch {
      // Try the next mirror.
    }
  }
  return [];
}

// Loose name match so an OSM place can be tied to a hotel we already track.
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(hotel|inn|suites|suite|motel|by|the|and|an?|at|of|resort)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = new Set(na.split(" ").filter((w) => w.length > 2));
  const wb = new Set(nb.split(" ").filter((w) => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}
