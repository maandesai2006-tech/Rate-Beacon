// Finding the hotels in a market.
//
// Everything downstream needs TripAdvisor hotel keys: the rate feed is keyed
// on them, so a market with no keys cannot be priced at all. That makes this
// the load-bearing step for onboarding a new customer.
//
// It has also been the least reliable part of the upstream API. Neither the
// accepted parameter shape nor the response field names are documented, and
// they have changed at least once. Guessing one shape per deploy costs a round
// trip each time, and the host is not reachable from a development machine, so
// guessing is all a local test could ever do.
//
// So the call is *learned* rather than assumed, in two ways:
//
//   The request  — a matrix of candidate endpoints and parameter shapes is
//                  probed against a known location, the winner is stored, and
//                  discovery uses it until it stops working.
//   The response — nothing depends on a particular field name. The JSON is
//                  walked for anything shaped like a TripAdvisor hotel key,
//                  taking the name and coordinates that sit alongside it. A
//                  renamed field, or a different endpoint's envelope, still
//                  parses.
//
// When every candidate fails, the recorded messages say what each one
// answered, which is the only thing that narrows down an undocumented API.

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

interface Candidate {
  name: string;
  path: string;
  params: Record<string, string>;
}

/**
 * Every plausible way to ask a market for its hotels.
 *
 * Two endpoints, because /list and /heatmap have both been documented as the
 * one that enumerates a location, and whichever answers is equally useful:
 * the response walker does not care which envelope the keys arrive in.
 */
function candidateCalls(locationKey: string, offset: number, limit: number): Candidate[] {
  const day = (n: number) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  const inISO = day(14);
  const outISO = day(15);
  const inSlash = inISO.replace(/-/g, "/");
  const outSlash = outISO.replace(/-/g, "/");
  const inCompact = inISO.replace(/-/g, "");
  const outCompact = outISO.replace(/-/g, "");
  const page = { offset: String(offset), limit: String(limit) };
  const base = { location_key: locationKey, ...page };

  const list: Candidate[] = [
    { name: "list:iso-dates", path: "/list", params: { ...base, chk_in: inISO, chk_out: outISO } },
    {
      name: "list:iso-dates-full",
      path: "/list",
      params: { ...base, chk_in: inISO, chk_out: outISO, currency: "USD", adults: "2", rooms: "1" },
    },
    {
      name: "list:iso-dates-sorted",
      path: "/list",
      params: { ...base, chk_in: inISO, chk_out: outISO, sort: "best_value" },
    },
    { name: "list:slash-dates", path: "/list", params: { ...base, chk_in: inSlash, chk_out: outSlash } },
    {
      name: "list:compact-dates",
      path: "/list",
      params: { ...base, chk_in: inCompact, chk_out: outCompact },
    },
    { name: "list:checkin-alias", path: "/list", params: { ...base, check_in: inISO, check_out: outISO } },
    { name: "list:no-dates", path: "/list", params: base },
    { name: "list:no-dates-sorted", path: "/list", params: { ...base, sort: "best_value" } },
    { name: "list:bare", path: "/list", params: { location_key: locationKey } },
    { name: "list:bare-limit", path: "/list", params: { location_key: locationKey, limit: String(limit) } },
  ];

  const heatmap: Candidate[] = [
    {
      name: "heatmap:iso-dates",
      path: "/heatmap",
      params: { location_key: locationKey, chk_in: inISO, chk_out: outISO },
    },
    {
      name: "heatmap:iso-dates-full",
      path: "/heatmap",
      params: {
        location_key: locationKey,
        chk_in: inISO,
        chk_out: outISO,
        currency: "USD",
        adults: "2",
        rooms: "1",
      },
    },
    { name: "heatmap:bare", path: "/heatmap", params: { location_key: locationKey } },
  ];

  return [...list, ...heatmap];
}

const KEY_RE = /^g\d+-d\d+$/i;

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function firstString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstNumber(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const n = num(o[k]);
    if (n != null) return n;
  }
  return null;
}

/** The TripAdvisor key on this object, if it carries one. */
const KEY_FIELDS = ["hotel_key", "hotelKey", "key", "hotel_id", "hotelId", "id"];

function keyOf(o: Record<string, unknown>): string | null {
  // Preferred field names first, so a nested object that also carries its
  // parent's key under some other name cannot outrank its own identifier.
  for (const k of KEY_FIELDS) {
    const v = o[k];
    if (typeof v === "string" && KEY_RE.test(v)) return v.toLowerCase();
  }
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" && KEY_RE.test(v) && /key|id/i.test(k)) return v.toLowerCase();
  }
  for (const v of Object.values(o)) {
    if (typeof v === "string" && KEY_RE.test(v)) return v.toLowerCase();
  }
  return null;
}

/**
 * Walk any response and collect the hotels in it.
 *
 * Field names are read by preference rather than by contract, and the shape of
 * the envelope is irrelevant — an object anywhere in the tree that carries a
 * hotel key and a name is a hotel.
 */
function harvest(node: unknown, out: Map<string, ListedHotel>, depth = 0): void {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) harvest(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;

  const o = node as Record<string, unknown>;
  const key = keyOf(o);
  const name = firstString(o, ["name", "title", "hotel_name", "hotel_title"]);

  if (key && name && !out.has(key)) {
    const geo = (o.geo ?? o.coordinates ?? o.location) as Record<string, unknown> | undefined;
    const summary = (o.review_summary ?? o.reviews_summary) as Record<string, unknown> | undefined;
    const prices = (o.price_ranges ?? o.prices) as Record<string, unknown> | undefined;

    out.set(key, {
      hotelKey: key,
      name,
      rating: firstNumber(o, ["rating", "review_rating", "score"]) ?? (summary ? firstNumber(summary, ["rating", "score"]) : null),
      reviewCount:
        firstNumber(o, ["review_count", "reviews", "review_total"]) ??
        (summary ? firstNumber(summary, ["count", "total"]) : null),
      latitude:
        (geo ? firstNumber(geo, ["latitude", "lat"]) : null) ?? firstNumber(o, ["latitude", "lat"]),
      longitude:
        (geo ? firstNumber(geo, ["longitude", "lon", "lng"]) : null) ??
        firstNumber(o, ["longitude", "lon", "lng"]),
      price:
        firstNumber(o, ["price", "min_price", "lowest_price"]) ??
        (prices ? firstNumber(prices, ["minimum", "min"]) : null),
    });
  }

  for (const v of Object.values(o)) {
    if (v && typeof v === "object") harvest(v, out, depth + 1);
  }
}

export function hotelsInResponse(result: unknown): ListedHotel[] {
  const out = new Map<string, ListedHotel>();
  harvest(result, out);
  return [...out.values()];
}

async function call(
  c: Candidate
): Promise<{ ok: boolean; status: number | null; message: string; hotels: ListedHotel[] }> {
  const url = `${BASE}${c.path}?${new URLSearchParams(c.params)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "RateBeacon/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: { error?: unknown; result?: unknown } = {};
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
    const hotels = hotelsInResponse(json.result ?? json);
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
 * Try every candidate and report what each one said.
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

  for (const c of candidateCalls(locationKey, 0, 30)) {
    const r = await call(c);
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
 * Hotels in a market, using the learned call when there is one.
 *
 * Falls back to trying every candidate in order, and remembers whichever
 * answers, so a first-ever call in a fresh deployment still succeeds — it just
 * costs a few extra requests once.
 */
export async function listHotelsIn(
  supa: SupabaseClient,
  locationKey: string,
  { offset = 0, limit = 30 }: { offset?: number; limit?: number } = {}
): Promise<{ hotels: ListedHotel[]; shape: string | null; error: string | null }> {
  const candidates = candidateCalls(locationKey, offset, limit);
  const learned = await recallShape(supa);
  const ordered = learned
    ? [...candidates.filter((c) => c.name === learned), ...candidates.filter((c) => c.name !== learned)]
    : candidates;

  const failures: string[] = [];
  for (const c of ordered) {
    const r = await call(c);
    if (r.ok) {
      if (c.name !== learned) await rememberShape(supa, c.name);
      return { hotels: r.hotels, shape: c.name, error: null };
    }
    failures.push(`${c.name}: ${r.message}`);
  }
  return {
    hotels: [],
    shape: null,
    error: `Every request shape was refused — ${failures.slice(0, 4).join(" | ")}`,
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
