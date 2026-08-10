// Xotelo (https://xotelo.com) — free, keyless JSON API serving TripAdvisor
// meta-search prices across OTAs (Booking.com, Expedia, Agoda, …).
//
// Identifiers come straight from TripAdvisor URLs:
//   https://www.tripadvisor.com/Hotel_Review-g187147-d197685-Reviews-Hotel_X-Paris.html
//   → location_key "g187147", hotel_key "g187147-d197685"

const BASE = "https://data.xotelo.com/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function xoteloGet<T>(
  path: string,
  params: Record<string, string>
): Promise<T> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(700 * 2 ** attempt);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Xotelo ${res.status} on ${path}`);
        continue;
      }
      const json = (await res.json()) as {
        error: { message?: string } | string | null;
        result: T | null;
      };
      if (json.error) {
        const msg =
          typeof json.error === "string"
            ? json.error
            : json.error.message ?? JSON.stringify(json.error);
        throw new XoteloApiError(msg);
      }
      return (json.result ?? ({} as T)) as T;
    } catch (e) {
      if (e instanceof XoteloApiError) throw e;
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error(`Xotelo request failed: ${path}`);
}

// API-level errors (e.g. "no availability", bad key) — not worth retrying.
export class XoteloApiError extends Error {}

export interface ParsedTripAdvisorUrl {
  locationKey: string | null;
  hotelKey: string | null;
  name: string | null;
}

// Accepts a full TripAdvisor URL (any country domain), a bare hotel key
// ("g187147-d197685"), or a bare location key ("g187147").
export function parseTripAdvisorRef(input: string): ParsedTripAdvisorUrl {
  const s = input.trim();
  const bare = s.match(/^(g\d+)(?:-(d\d+))?$/i);
  if (bare) {
    return {
      locationKey: bare[1].toLowerCase(),
      hotelKey: bare[2] ? `${bare[1]}-${bare[2]}`.toLowerCase() : null,
      name: null,
    };
  }
  const g = s.match(/[-/](g\d+)/i);
  const d = s.match(/-(d\d+)/i);
  // Hotel_Review-g187147-d197685-Reviews-Hotel_Name-City.html → "Hotel Name"
  const nameMatch = s.match(/Reviews-([^-][^/]*?)-[^-/]+\.html/i);
  const name = nameMatch
    ? decodeURIComponent(nameMatch[1]).replace(/_/g, " ").trim()
    : null;
  return {
    locationKey: g ? g[1].toLowerCase() : null,
    hotelKey: g && d ? `${g[1]}-${d[1]}`.toLowerCase() : null,
    name,
  };
}

export interface Quote {
  name: string;
  total: number; // rate + tax for the stay
}

export interface XoteloRates {
  price: number | null; // headline rate: brand-direct when detected, else cheapest
  priceLow: number | null; // cheapest quote across all sellers
  source: string | null; // which seller the headline rate came from
  direct: boolean; // true when the headline rate is the brand site's
  offers: Quote[];
  currency: string | null;
  available: boolean;
}

// Sub-brands that identify a chain in a hotel's own name, keyed by the
// seller labels TripAdvisor's compare list uses for that chain's own site.
// The list carries either the parent ("IHG", "Marriott") or the sub-brand
// itself ("Courtyard", "Residence Inn"), so both are matched.
const BRAND_FAMILIES: [string[], string[]][] = [
  [
    ["ihg", "intercontinental hotels group"],
    ["candlewood", "holiday inn", "staybridge", "crowne plaza", "intercontinental", "avid", "even hotel", "hotel indigo", "kimpton", "atwell", "vignette"],
  ],
  [
    ["marriott", "bonvoy"],
    ["marriott", "courtyard", "residence inn", "towneplace", "fairfield", "springhill", "four points", "sheraton", "westin", "aloft", "ac hotel", "moxy", "element", "delta hotels", "st regis", "w hotel", "ritz"],
  ],
  [
    ["hilton", "hilton honors"],
    ["hilton", "hampton", "home2", "homewood", "tru by", "doubletree", "embassy suites", "garden inn", "canopy", "tapestry", "curio", "signia", "spark by"],
  ],
  [["hyatt"], ["hyatt", "hyatt place", "hyatt house", "andaz", "thompson hotels", "caption by"]],
  [
    ["wyndham", "by wyndham"],
    ["wyndham", "la quinta", "days inn", "super 8", "baymont", "microtel", "ramada", "travelodge", "howard johnson", "wingate", "hawthorn", "americinn", "trademark"],
  ],
  [
    ["choice hotels", "choicehotels", "choice"],
    ["comfort inn", "comfort suites", "quality inn", "sleep inn", "clarion", "econo lodge", "mainstay", "rodeway", "cambria", "woodspring", "suburban studios", "everhome"],
  ],
  [["best western", "bestwestern"], ["best western", "surestay", "glo by", "aiden by", "sadie hotel"]],
  [["red roof", "redroof"], ["red roof", "hometowne studios"]],
  [["extended stay america", "extendedstayamerica", "esa"], ["extended stay america"]],
  [["motel 6", "motel6", "g6 hospitality"], ["motel 6", "studio 6"]],
  [["sonesta"], ["sonesta", "simply suites", "sonesta select", "sonesta es suites"]],
  [["drury"], ["drury"]],
  [["omni"], ["omni"]],
  [["loews"], ["loews"]],
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.(com|co\.uk|net|org)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Known OTA/meta sellers — never a brand site, even if a name collides with a
// chain token (e.g. "Hotels.com" vs a hotel literally named "… Hotel").
const OTA_SELLERS = [
  "booking", "expedia", "agoda", "trip", "hotels", "priceline", "orbitz",
  "travelocity", "vio", "hotwire", "kayak", "trivago", "ebookers", "algotels",
  "getaroom", "zenhotels", "hostelworld", "official hotel", "prestigia",
  "traveluro", "reservations", "amoma", "mytrip", "supertravel", "destinia",
  "findhotel", "stayforlong", "hotelscombined", "cheaptickets", "onetravel",
];

function isOta(q: string): boolean {
  return OTA_SELLERS.some((o) => q === o || q.startsWith(`${o} `));
}

// Is this quote the hotel's own brand site? Matches the generic "official
// site" label, the chain site that owns the hotel's sub-brand, or a seller
// named after a sub-brand appearing in the hotel's own name.
export function isDirectQuote(quoteName: string, hotelName: string): boolean {
  const q = normalize(quoteName);
  if (!q) return false;
  const h = normalize(hotelName);
  if (q.includes("official site") || q === "official") return true;
  if (isOta(q)) return false;

  for (const [sellerLabels, subBrands] of BRAND_FAMILIES) {
    const hotelInFamily = subBrands.some((b) => h.includes(b));
    if (!hotelInFamily) continue;
    // Seller is the chain's parent site ("IHG", "Marriott", "Choice Hotels").
    if (sellerLabels.some((label) => q === label || q.includes(label))) return true;
    // Seller is the sub-brand itself ("Courtyard", "Residence Inn").
    if (subBrands.some((b) => q === b || q.includes(b))) return true;
  }
  // Fallback: the seller name appears verbatim in the hotel's own name.
  return q.length > 3 && h.includes(q);
}

interface RatesResult {
  chk_in?: string;
  chk_out?: string;
  currency?: string;
  rates?: { code?: string; name?: string; rate?: number; tax?: number }[];
}

export async function getRates(
  hotelKey: string,
  hotelName: string,
  checkIn: string,
  checkOut: string,
  currency: string,
  adults: number
): Promise<XoteloRates> {
  const empty: XoteloRates = {
    price: null,
    priceLow: null,
    source: null,
    direct: false,
    offers: [],
    currency: null,
    available: false,
  };
  try {
    const result = await xoteloGet<RatesResult>("/rates", {
      hotel_key: hotelKey,
      chk_in: checkIn,
      chk_out: checkOut,
      currency,
      adults: String(adults),
      rooms: "1",
    });
    const offers: Quote[] = (result.rates ?? [])
      .filter((r) => typeof r.rate === "number" && r.rate! > 0)
      .map((r) => ({
        name: r.name ?? r.code ?? "unknown",
        total: r.rate! + (r.tax ?? 0),
      }))
      .sort((a, b) => a.total - b.total);
    if (offers.length === 0) return empty;

    const directQuote = offers.find((o) => isDirectQuote(o.name, hotelName)) ?? null;
    const headline = directQuote ?? offers[0];
    return {
      price: headline.total,
      priceLow: offers[0].total,
      source: headline.name,
      direct: directQuote != null,
      offers,
      currency: result.currency ?? currency,
      available: true,
    };
  } catch (e) {
    if (e instanceof XoteloApiError) {
      // "No availability" style errors mean sold out / not bookable that night.
      return empty;
    }
    throw e;
  }
}

export interface XoteloHotel {
  hotelKey: string;
  name: string;
  rating: number | null;
  reviewCount: number | null;
}

// Remembered across calls once a parameter shape is known to work.
let listVariantIndex = -1;

interface ListResult {
  list?: {
    key?: string;
    hotel_key?: string;
    name?: string;
    title?: string;
    rating?: number;
    review_count?: number;
    reviews?: number;
    review_summary?: { rating?: number; count?: number };
  }[];
  total_count?: number;
}

// Hotels in a TripAdvisor location, for the competitor picker and for
// refreshing review standing (rating fields are parsed defensively — the
// exact shape varies).
export async function listHotels(
  locationKey: string,
  offset = 0,
  limit = 30
): Promise<XoteloHotel[]> {
  // The listing endpoint is picky about parameters and the accepted shape has
  // changed over time, so try the known variants and use the first that
  // answers. The winning shape is remembered for the rest of the process.
  const inD = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  const outD = new Date(Date.now() + 15 * 86400e3).toISOString().slice(0, 10);
  const variants: Record<string, string>[] = [
    { location_key: locationKey, offset: String(offset), limit: String(limit) },
    { location_key: locationKey, offset: String(offset), limit: String(limit), sort: "best_value" },
    {
      location_key: locationKey,
      chk_in: inD,
      chk_out: outD,
      offset: String(offset),
      limit: String(limit),
      currency: "USD",
      adults: "2",
      rooms: "1",
    },
    { location_key: locationKey, chk_in: inD, chk_out: outD, offset: String(offset), limit: String(limit) },
    { location_key: locationKey },
  ];

  const ordered = listVariantIndex >= 0
    ? [variants[listVariantIndex], ...variants.filter((_, i) => i !== listVariantIndex)]
    : variants;

  let lastErr: Error | null = null;
  let result: ListResult | null = null;
  for (let i = 0; i < ordered.length; i++) {
    try {
      const r = await xoteloGet<ListResult>("/list", ordered[i]);
      if ((r.list ?? []).length > 0 || r.total_count != null) {
        listVariantIndex = variants.indexOf(ordered[i]);
        result = r;
        break;
      }
    } catch (e) {
      lastErr = e as Error;
    }
  }
  if (!result) throw lastErr ?? new Error("Hotel listing returned no usable shape");

  return (result.list ?? [])
    .map((h) => ({
      hotelKey: (h.key ?? h.hotel_key ?? "").toLowerCase(),
      name: h.name ?? h.title ?? "",
      rating: h.rating ?? h.review_summary?.rating ?? null,
      reviewCount: h.review_count ?? h.reviews ?? h.review_summary?.count ?? null,
    }))
    .filter((h) => /^g\d+-d\d+$/.test(h.hotelKey) && h.name);
}
