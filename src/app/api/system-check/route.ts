import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// A one-click health report, in plain language. Every external dependency is
// probed from the server (they are not reachable from a browser), so the
// answer to "why is X empty?" is visible in the app instead of requiring
// someone to open API URLs by hand.
export const maxDuration = 60;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function timed(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; ms: number; body: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, cache: "no-store" });
    const body = (await res.text()).slice(0, 400);
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, body: (e as Error).message };
  }
}

export async function GET() {
  const checks: Check[] = [];
  const supa = db();

  // 1. Database
  try {
    const { count } = await supa
      .from("rate_snapshots")
      .select("id", { count: "exact", head: true });
    checks.push({ name: "Database", ok: true, detail: `Connected. ${count ?? 0} rate snapshots stored.` });
  } catch (e) {
    checks.push({ name: "Database", ok: false, detail: (e as Error).message });
  }

  // 2. Rate feed
  const inD = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  const outD = new Date(Date.now() + 15 * 86400e3).toISOString().slice(0, 10);
  const rates = await timed(
    `https://data.xotelo.com/api/rates?hotel_key=g34550-d10637341&chk_in=${inD}&chk_out=${outD}&currency=USD&adults=2&rooms=1`
  );
  let ratesOk = false;
  try {
    const j = JSON.parse(rates.body.startsWith("{") ? rates.body : "{}");
    ratesOk = rates.ok && !j.error;
  } catch {
    ratesOk = false;
  }
  checks.push({
    name: "Rate feed (prices)",
    ok: ratesOk,
    detail: ratesOk
      ? `Responding in ${rates.ms}ms.`
      : `HTTP ${rates.status} in ${rates.ms}ms. ${rates.body.slice(0, 180)}`,
  });

  // 3. Hotel listing — the source of ratings and competitor discovery
  const list = await timed("https://data.xotelo.com/api/list?location_key=g34550&limit=5");
  let listCount = 0;
  let listErr = "";
  try {
    const j = JSON.parse(list.body.startsWith("{") ? list.body : "{}");
    if (j.error) listErr = JSON.stringify(j.error).slice(0, 160);
    listCount = (j.result?.list ?? []).length;
  } catch {
    listErr = list.body.slice(0, 160);
  }
  checks.push({
    name: "Hotel listing (ratings, discovery)",
    ok: listCount > 0,
    detail:
      listCount > 0
        ? `Returned ${listCount} hotels in ${list.ms}ms.`
        : `No hotels returned (HTTP ${list.status}). ${listErr || list.body.slice(0, 160)}`,
  });

  // 4. Map source
  const overpass = await timed("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: "data=" + encodeURIComponent("[out:json][timeout:15];node[\"tourism\"=\"hotel\"](around:3000,30.478,-87.209);out 5;"),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  let osmCount = 0;
  try {
    osmCount = (JSON.parse(overpass.body.startsWith("{") ? overpass.body : "{}").elements ?? []).length;
  } catch {
    osmCount = 0;
  }
  checks.push({
    name: "Map source (OpenStreetMap)",
    ok: overpass.ok,
    detail: overpass.ok
      ? `Responding in ${overpass.ms}ms, ${osmCount} sample hotels nearby.`
      : `HTTP ${overpass.status}. ${overpass.body.slice(0, 160)}`,
  });

  // 5. Geocoding
  const geo = await timed(
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=Candlewood%20Suites%20Pensacola",
    { headers: { "User-Agent": "RateBeacon/1.0 (health check)" } }
  );
  checks.push({
    name: "Geocoding",
    ok: geo.ok,
    detail: geo.ok ? `Responding in ${geo.ms}ms.` : `HTTP ${geo.status}. ${geo.body.slice(0, 160)}`,
  });

  // 6. Coverage summary
  try {
    const [{ count: hotels }, { count: located }, { count: rated }, { count: places }] = await Promise.all([
      supa.from("hotels").select("hotel_id", { count: "exact", head: true }),
      supa.from("hotels").select("hotel_id", { count: "exact", head: true }).not("latitude", "is", null),
      supa.from("hotels").select("hotel_id", { count: "exact", head: true }).not("rating", "is", null),
      supa.from("map_places").select("id", { count: "exact", head: true }),
    ]);
    checks.push({
      name: "Coverage",
      ok: (located ?? 0) > 0,
      detail: `${hotels ?? 0} hotels tracked · ${located ?? 0} placed on the map · ${rated ?? 0} with a review score · ${places ?? 0} nearby map pins.`,
    });
  } catch (e) {
    checks.push({ name: "Coverage", ok: false, detail: (e as Error).message });
  }

  return NextResponse.json({ checkedAt: new Date().toISOString(), checks });
}
