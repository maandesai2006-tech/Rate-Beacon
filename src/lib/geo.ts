// Putting a hotel on the map.
//
// Coordinates are what the forecast, the radius search and the market filter
// all stand on, so a hotel that cannot be placed is a hotel that sits outside
// all three. The names hotels trade under are the problem: "Candlewood Suites
// Pensacola University Area by IHG" or "Hampton Inn & Suites Pensacola I-10 N
// University Town Plaza" are how a franchise lists itself and not how a map
// knows it. Asked verbatim, a geocoder returns nothing — and that is exactly
// what happened to both baseline hotels on the deployment.
//
// So the name is asked several ways, most specific first, and the first hit
// wins. If none of them lands, the town itself is used and the result is
// marked as city precision: good enough for weather (a forecast is the same
// across a town) and for telling Destin from Pensacola, and honestly labelled
// so the radius search knows not to trust it to the mile.
//
// Google's geocoder is used when a key is configured — it knows franchise
// names far better — with OpenStreetMap's Nominatim as the keyless default.
// Nominatim asks for a descriptive User-Agent and one request a second, both
// respected here.

export type GeoPrecision = "hotel" | "city";

export interface GeoResult {
  latitude: number;
  longitude: number;
  address: string | null;
  precision: GeoPrecision;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The queries worth trying for a hotel name, most specific first.
 *
 * Exported so the shapes can be tested without a network: the whole value of
 * this function is which strings it produces for the names hotels actually
 * have.
 */
export function geocodeQueries(name: string, near: string | null): string[] {
  const full = name.trim();
  const noFranchise = full
    .replace(/\s+by\s+(ihg|marriott|hilton|wyndham|choice|hyatt|radisson|best western|sonesta)\b.*$/i, "")
    .trim();
  // Everything after a dash, slash or road designation is a locality hint that
  // maps do not index: "- I-10 at Davis Hwy", "Airport/Medical Center".
  const noLocality = noFranchise
    .replace(/\s*[-–—]\s.*$/, "")
    .replace(/\s+I-\d+.*$/i, "")
    .replace(/\s*\/.*$/, "")
    .trim();
  // Brand plus the first place word: "Hampton Inn Pensacola".
  const brand = noLocality
    .replace(/\s*&\s*suites\b/i, "")
    .replace(/\b(university area|town plaza|downtown|airport|beach|east|west|north|south)\b.*$/i, "")
    .trim();

  const variants = [full, noFranchise, noLocality, brand]
    .map((v) => v.replace(/\s+/g, " ").trim())
    .filter((v, i, arr) => v.length >= 4 && arr.indexOf(v) === i);

  const town = near?.split(",")[0].trim().toLowerCase() ?? null;
  const out: string[] = [];
  for (const v of variants) {
    if (near) out.push(`${v}, ${near}`);
    // The bare variant is only worth a request when it already names the
    // town; without one it would match the same brand anywhere on earth.
    if (!near || (town && v.toLowerCase().includes(town))) out.push(v);
  }
  return [...new Set(out)];
}

async function nominatim(query: string): Promise<Omit<GeoResult, "precision"> | null> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1` +
    `&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "RateBeacon/1.0 (hotel rate dashboard; contact via github.com/maandesai2006-tech/Rate-Beacon)",
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { lat?: string; lon?: string; display_name?: string }[];
    const hit = json?.[0];
    if (!hit?.lat || !hit?.lon) return null;
    const latitude = parseFloat(hit.lat);
    const longitude = parseFloat(hit.lon);
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
    return { latitude, longitude, address: hit.display_name ?? null };
  } catch {
    return null;
  } finally {
    await sleep(1100);
  }
}

async function google(query: string, key: string): Promise<Omit<GeoResult, "precision"> | null> {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${key}`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      status?: string;
      results?: { formatted_address?: string; geometry?: { location?: { lat: number; lng: number } } }[];
    };
    const hit = json.results?.[0];
    const loc = hit?.geometry?.location;
    if (json.status !== "OK" || !loc) return null;
    return { latitude: loc.lat, longitude: loc.lng, address: hit?.formatted_address ?? null };
  } catch {
    return null;
  }
}

/**
 * Place a hotel, or failing that its town.
 *
 * Returns null only when even the town cannot be found — a name with no
 * market at all.
 */
export async function geocodeHotel(name: string, near: string | null): Promise<GeoResult | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  const lookup = key ? (q: string) => google(q, key) : nominatim;

  for (const query of geocodeQueries(name, near)) {
    const hit = await lookup(query);
    if (hit) return { ...hit, precision: "hotel" };
  }

  if (near) {
    const town = await lookup(near);
    if (town) return { ...town, precision: "city" };
  }
  return null;
}
