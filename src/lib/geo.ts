// Hotel geocoding via OpenStreetMap Nominatim (free, keyless). Their usage
// policy asks for a descriptive User-Agent and at most one request per second,
// both of which this respects. Coordinates are cached in the hotels table and
// only ever fetched once per hotel.

export interface GeoResult {
  latitude: number;
  longitude: number;
  address: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function geocodeHotel(
  name: string,
  near: string | null
): Promise<GeoResult | null> {
  const query = near ? `${name}, ${near}` : name;
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
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      lat?: string;
      lon?: string;
      display_name?: string;
    }[];
    const hit = json?.[0];
    if (!hit?.lat || !hit?.lon) return null;
    const latitude = parseFloat(hit.lat);
    const longitude = parseFloat(hit.lon);
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
    return { latitude, longitude, address: hit.display_name ?? null };
  } catch {
    return null;
  } finally {
    // Nominatim's rate limit: keep to one lookup per second.
    await sleep(1100);
  }
}
