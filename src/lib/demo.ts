// The public demo grid, built from the database directly.
//
// This used to live inside an API route, and the demo page fetched that route
// over HTTP from the server — a round trip to itself. Anything in the way (a
// cold start, a missing VERCEL_URL, Vercel's deployment protection sitting in
// front of the whole app) turned into a silent null, and the page said "no
// rates collected yet" while the API next to it was returning twelve hotels.
// A server component reads the database; it does not phone its own API.
//
// It reads published competitor prices and nothing else — no manager's
// reports, no manual overrides, no account or profile names — because it
// answers without a session and must never be able to leak anything private.

import { db } from "./db";
import { dateRange, todayISO } from "./dates";

const NIGHTS = 14;
const MAX_HOTELS = 12;

// The market the demo shows: the one with the deepest rate history.
const DEMO_LOCATION_PREFIX = "g34550";
const DEMO_MARKET = "Pensacola, FL";

export interface DemoRow {
  hotel: string;
  prices: (number | null)[];
}

export interface DemoGrid {
  market: string;
  capturedAt: string | null;
  dates: string[];
  rows: DemoRow[];
  medians: (number | null)[];
  /** Why the grid is empty, when it is — never a stand-in for an error. */
  note?: string;
  error?: string;
}

export async function buildDemoGrid(): Promise<DemoGrid> {
  const supa = db();
  const start = todayISO();
  const dates = dateRange(start, NIGHTS);
  const last = dates[dates.length - 1];

  try {
    const { data: hotelRows } = await supa
      .from("hotels")
      .select("hotel_id, name")
      .like("hotel_id", `${DEMO_LOCATION_PREFIX}-%`)
      .limit(60)
      .returns<{ hotel_id: string; name: string }[]>();

    const nameOf = new Map((hotelRows ?? []).map((h) => [h.hotel_id, h.name]));
    if (nameOf.size === 0) {
      return {
        market: DEMO_MARKET,
        capturedAt: null,
        dates,
        rows: [],
        medians: [],
        note: "No hotels are tracked in the demo market yet.",
      };
    }

    const { data: snaps } = await supa
      .from("latest_rates")
      .select("hotel_id, check_in, price, captured_on")
      .in("hotel_id", [...nameOf.keys()])
      .gte("check_in", start)
      .lte("check_in", last)
      .returns<{ hotel_id: string; check_in: string; price: number | null; captured_on: string }[]>();

    const byHotel = new Map<string, Map<string, number>>();
    let latestCapture: string | null = null;
    for (const s of snaps ?? []) {
      if (s.captured_on && (!latestCapture || s.captured_on > latestCapture)) {
        latestCapture = s.captured_on;
      }
      if (s.price == null) continue;
      const bag = byHotel.get(s.hotel_id) ?? new Map<string, number>();
      bag.set(s.check_in, Number(s.price));
      byHotel.set(s.hotel_id, bag);
    }

    // Only hotels with a reasonable amount of coverage; a row of dashes tells
    // a visitor nothing good about the product.
    const rows = [...byHotel.entries()]
      .map(([hotelId, bag]) => ({
        hotel: nameOf.get(hotelId) ?? hotelId,
        filled: bag.size,
        prices: dates.map((d) => bag.get(d) ?? null),
      }))
      .filter((r) => r.filled >= Math.ceil(NIGHTS / 3))
      .sort((a, b) => b.filled - a.filled)
      .slice(0, MAX_HOTELS)
      .map(({ hotel, prices }) => ({ hotel, prices }));

    const medians = dates.map((_, i) => {
      const vals = rows
        .map((r) => r.prices[i])
        .filter((v): v is number => v != null)
        .sort((a, b) => a - b);
      if (vals.length === 0) return null;
      const mid = Math.floor(vals.length / 2);
      return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    });

    return { market: DEMO_MARKET, capturedAt: latestCapture, dates, rows, medians };
  } catch (e) {
    return { market: DEMO_MARKET, capturedAt: null, dates, rows: [], medians: [], error: (e as Error).message };
  }
}
