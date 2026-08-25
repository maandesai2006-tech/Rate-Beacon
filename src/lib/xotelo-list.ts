// Finding the hotels in a market.
//
// Everything downstream needs TripAdvisor hotel keys: the rate feed is keyed
// on them, so a market with no keys cannot be priced at all. That makes
// /api/list the load-bearing endpoint for onboarding a new customer.
//
// It has also been the least reliable. Its accepted parameter shape is not
// documented and has changed at least once; probing from a development machine
// is not possible when the host is unreachable from there, and guessing one
// shape per deploy costs a round trip each time.
//
// So the shape is *learned* rather than assumed. A probe runs a matrix of
// candidate shapes against a known-good location, records verbatim what each
// one returned, and stores the winner. Discovery then uses the stored shape
// and only re-probes if it stops working. One production run settles it, and
// if none work the recorded messages say exactly why instead of "check your
// params".

import type { SupabaseClient } from "@supabase/supabase-js";

const BASE = "https://data.xotelo.com/api";
const PROBE_KEY = "xotelo.list.shape";

export interface ListedHotel {
  hotelKey: string;
  name: string;
  rating: number | null;
  reviewCount: number | null;
  latitude: number | null;
  longitude: number | null;
  price: number | null;
}

export interface ProbeOutcome {
  shape: string;
  ok: boolean;
  status: number | null;
  message: string;
  hotels: number;
}

/** Named candidate shapes, widest plausible spread of the ways this could work. */
function candidateShapes(
  locationKey: string,
  offset: number,
  limit: number
): { name: string; params: Record<string, string> }[] {
  const day = (n: number) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  const inISO = day(14);
  const outISO = day(15);
  const inSlash = inISO.replace(/-/g, "/");
  const outSlash = outISO.replace(/-/g, "/");
  const inCompact = inISO.replace(/-/g, "");
  const outCompact = outISO.replace(/-/g, "");
  const base = { location_key: locationKey, offset: String(offset), limit: String(limit) };

  return [
    { name: "iso-dates", params: { ...base, chk_in: inISO, chk_out: outISO } },
    {
      name: "iso-dates-full",
      params: { ...base, chk_in: inISO, chk_out: outISO, currency: "USD", adults: "2", rooms: "1" },
    },
    { name: "iso-dates-sorted", params: { ...base, chk_in: inISO, chk_out: outISO, sort: "best_value" } },
    { name: "slash-dates", params: { ...base, chk_in: inSlash, chk_out: outSlash } },
    { name: "compact-dates", params: { ...base, chk_in: inCompact, chk_out: outCompact } },
    {
      name: "checkin-alias",
      params: { ...base, check_in: inISO, check_out: outISO },
    },
    { name: "no-dates", params: base },
    { name: "no-dates-sorted", params: { ...base, sort: "best_value" } },
    { name: "bare", params: { location_key: locationKey } },
    { name: "bare-limit", params: { location_key: locationKey, limit: String(limit) } },
  ];
}

interface RawListItem {
  key?: string;
  hotel_key?: string;
  name?: string;
  title?: string;
  rating?: number;
  review_count?: number;
  reviews?: number;
  review_summary?: { rating?: number; count?: number };
  geo?: { latitude?: number; longitude?: number };
  latitude?: number;
  longitude?: number;
  price?: number;
  price_ranges?: { minimum?: number };
}

interface RawList {
  list?: RawListItem[];
  total_count?: number;
}

function normalise(raw: RawList): ListedHotel[] {
  return (raw.list ?? [])
    .map((h) => ({
      hotelKey: (h.key ?? h.hotel_key ?? "").toLowerCase(),
      name: (h.name ?? h.title ?? "").trim(),
      rating: h.rating ?? h.review_summary?.rating ?? null,
      reviewCount: h.review_count ?? h.reviews ?? h.review_summary?.count ?? null,
      latitude: h.geo?.latitude ?? h.latitude ?? null,
      longitude: h.geo?.longitude ?? h.longitude ?? null,
      price: h.price ?? h.price_ranges?.minimum ?? null,
    }))
    .filter((h) => /^g\d+-d\d+$/.test(h.hotelKey) && h.name);
}

async function callList(
  params: Record<string, string>
): Promise<{ ok: boolean; status: number | null; message: string; hotels: ListedHotel[] }> {
  const url = `${BASE}/list?${new URLSearchParams(params)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "RateBeacon/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: { error?: unknown; result?: RawList } = {};
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, message: `non-JSON: ${text.slice(0, 120)}`, hotels: [] };
    }
    if (json.error) {
      const err = json.error as { message?: string } | string;
      const message = typeof err === "string" ? err : (err.message ?? JSON.stringify(err));
      return { ok: false, status: res.status, message, hotels: [] };
    }
    const hotels = normalise(json.result ?? {});
    return {
      ok: hotels.length > 0,
      status: res.status,
      message: hotels.length > 0 ? "ok" : "answered but returned no hotels",
      hotels,
    };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      status: null,
      message: err.name === "TimeoutError" ? "timed out" : err.message,
      hotels: [],
    };
  }
}

/**
 * Try every candidate shape and report what each one said.
 *
 * Returns the full matrix, not just the winner, because when none work the
 * differences between the failures are the only thing that narrows it down.
 */
export async function probeListShapes(
  supa: SupabaseClient,
  locationKey: string
): Promise<{ winner: string | null; outcomes: ProbeOutcome[] }> {
  const outcomes: ProbeOutcome[] = [];
  let winner: string | null = null;

  for (const c of candidateShapes(locationKey, 0, 30)) {
    const r = await callList(c.params);
    outcomes.push({
      shape: c.name,
      ok: r.ok,
      status: r.status,
      message: r.message,
      hotels: r.hotels.length,
    });
    if (r.ok && !winner) {
      winner = c.name;
      await rememberShape(supa, c.name);
      // Keep probing the rest: knowing which others work is worth one extra
      // second when this only ever runs on demand.
    }
  }

  return { winner, outcomes };
}

async function rememberShape(supa: SupabaseClient, shape: string) {
  await supa
    .from("api_settings")
    .upsert({ key: PROBE_KEY, value: shape, updated_at: new Date().toISOString() }, { onConflict: "key" });
}

async function recallShape(supa: SupabaseClient): Promise<string | null> {
  const { data } = await supa
    .from("api_settings")
    .select("value")
    .eq("key", PROBE_KEY)
    .maybeSingle<{ value: string }>();
  return data?.value ?? null;
}

/**
 * Hotels in a market, using the learned shape when there is one.
 *
 * Falls back to trying every shape in order, and remembers whichever answers,
 * so a first-ever call in a fresh deployment still succeeds — it just costs a
 * few extra requests once.
 */
export async function listHotelsIn(
  supa: SupabaseClient,
  locationKey: string,
  { offset = 0, limit = 30 }: { offset?: number; limit?: number } = {}
): Promise<{ hotels: ListedHotel[]; shape: string | null; error: string | null }> {
  const shapes = candidateShapes(locationKey, offset, limit);
  const learned = await recallShape(supa);
  const ordered = learned
    ? [...shapes.filter((s) => s.name === learned), ...shapes.filter((s) => s.name !== learned)]
    : shapes;

  const failures: string[] = [];
  for (const c of ordered) {
    const r = await callList(c.params);
    if (r.ok) {
      if (c.name !== learned) await rememberShape(supa, c.name);
      return { hotels: r.hotels, shape: c.name, error: null };
    }
    failures.push(`${c.name}: ${r.message}`);
  }
  return {
    hotels: [],
    shape: null,
    error: `Every parameter shape was refused — ${failures.slice(0, 4).join(" | ")}`,
  };
}

/** Great-circle distance in miles. */
export function milesBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
