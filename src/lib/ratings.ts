// Review scores, gathered from whichever public source responds.
//
// The upstream rate provider exposes hotel metadata on more than one
// endpoint and the shapes vary, so each candidate is probed and parsed
// defensively. Whatever produces a score is recorded along with its source,
// so the dashboard can say where a number came from instead of implying a
// precision it does not have.

export interface RatingHit {
  rating: number;         // 0–5
  reviewCount: number | null;
  source: string;         // "tripadvisor" | "osm-stars" | …
}

const BASE = "https://data.xotelo.com/api";

function pickNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return null;
}

// Walk an unknown JSON blob for the first object that looks like a hotel
// record carrying a rating, keyed by hotel id where possible.
function harvest(node: unknown, into: Map<string, RatingHit>): void {
  if (Array.isArray(node)) {
    for (const item of node) harvest(item, into);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;

  const key = String(o.key ?? o.hotel_key ?? o.id ?? "").toLowerCase();
  const rating = pickNumber(
    o.rating,
    o.review_rating,
    o.average_rating,
    (o.review_summary as Record<string, unknown> | undefined)?.rating
  );
  const reviews = pickNumber(
    o.review_count,
    o.reviews,
    o.reviews_count,
    (o.review_summary as Record<string, unknown> | undefined)?.count
  );
  if (/^g\d+-d\d+$/.test(key) && rating != null && rating <= 5) {
    into.set(key, {
      rating,
      reviewCount: reviews != null ? Math.round(reviews) : null,
      source: "tripadvisor",
    });
  }
  for (const v of Object.values(o)) harvest(v, into);
}

async function probe(url: string): Promise<Map<string, RatingHit>> {
  const found = new Map<string, RatingHit>();
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return found;
    const json = await res.json();
    if (json?.error) return found;
    harvest(json?.result ?? json, found);
  } catch {
    // Endpoint unavailable — the caller falls through to the next source.
  }
  return found;
}

// Ratings for a whole location, trying each endpoint that might carry them.
export async function ratingsForLocation(
  locationKey: string,
  pages = 3
): Promise<{ hits: Map<string, RatingHit>; tried: { url: string; got: number }[] }> {
  const hits = new Map<string, RatingHit>();
  const tried: { url: string; got: number }[] = [];

  for (let page = 0; page < pages; page++) {
    const url = `${BASE}/list?location_key=${locationKey}&offset=${page * 30}&limit=30`;
    const found = await probe(url);
    tried.push({ url, got: found.size });
    for (const [k, v] of found) hits.set(k, v);
    if (found.size === 0) break;
  }
  return { hits, tried };
}

// Per-hotel lookup, used when the location listing yields nothing.
export async function ratingForHotel(
  hotelKey: string,
  name: string
): Promise<{ hit: RatingHit | null; tried: { url: string; got: number }[] }> {
  const tried: { url: string; got: number }[] = [];
  const candidates = [
    `${BASE}/search?query=${encodeURIComponent(name)}`,
    `${BASE}/heatmap?hotel_key=${hotelKey}`,
  ];
  for (const url of candidates) {
    const found = await probe(url);
    tried.push({ url, got: found.size });
    const direct = found.get(hotelKey);
    if (direct) return { hit: direct, tried };
  }
  return { hit: null, tried };
}
