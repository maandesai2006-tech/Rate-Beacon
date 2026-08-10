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
