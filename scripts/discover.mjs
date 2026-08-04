#!/usr/bin/env node
// Standalone competitor discovery — the same pipeline the app runs, usable
// from any machine so the data can be rebuilt without the dashboard.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/discover.mjs <profileId> [baselineHotelKey] [comps] [extras]
//
// Steps, all from public data:
//   1. list every hotel TripAdvisor knows in the baseline's location (Xotelo)
//   2. geocode the ones we haven't placed yet (OpenStreetMap Nominatim)
//   3. rank by great-circle distance from the baseline
//   4. store the nearest N as competitors, and a few around each as map context

import { createClient } from "@supabase/supabase-js";

const [, , profileArg, baselineArg, compsArg, extrasArg] = process.argv;
const profileId = Number(profileArg) || 1;
const compCount = Number(compsArg) || 15;
const perCompExtras = Number(extrasArg) || 3;

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}
const supa = createClient(url, key, { auth: { persistSession: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const XOTELO = "https://data.xotelo.com/api";

async function listHotels(locationKey, offset, limit) {
  const res = await fetch(
    `${XOTELO}/list?location_key=${locationKey}&offset=${offset}&limit=${limit}`,
    { headers: { Accept: "application/json" } }
  );
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return (json.result?.list ?? [])
    .map((h) => ({
      hotelKey: String(h.key ?? h.hotel_key ?? "").toLowerCase(),
      name: h.name ?? h.title ?? "",
    }))
    .filter((h) => /^g\d+-d\d+$/.test(h.hotelKey) && h.name);
}

async function geocode(name, near) {
  const q = encodeURIComponent(near ? `${name}, ${near}` : name);
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${q}`,
    { headers: { "User-Agent": "RateBeacon/1.0 (rate dashboard)", Accept: "application/json" } }
  );
  await sleep(1100); // Nominatim asks for ~1 request per second.
  if (!res.ok) return null;
  const j = await res.json();
  const hit = j?.[0];
  if (!hit) return null;
  const lat = parseFloat(hit.lat);
  const lon = parseFloat(hit.lon);
  return Number.isNaN(lat) || Number.isNaN(lon) ? null : { lat, lon };
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const { data: profile } = await supa
  .from("profiles")
  .select("*")
  .eq("id", profileId)
  .maybeSingle();
if (!profile) {
  console.error(`No profile ${profileId}`);
  process.exit(1);
}

const { data: baselineRows } = await supa
  .from("profile_hotels")
  .select("hotel_id")
  .eq("profile_id", profileId)
  .eq("role", "baseline");
const baselines = (baselineRows ?? [])
  .map((b) => b.hotel_id)
  .filter((id) => !baselineArg || id === baselineArg);

console.log(`Profile ${profileId} — ${baselines.length} baseline(s)\n`);

for (const baselineId of baselines) {
  const locationKey = baselineId.split("-")[0];
  console.log(`▸ ${baselineId}  (location ${locationKey})`);

  // 1. Directory
  let listed = 0;
  for (let page = 0; page < 6; page++) {
    let batch = [];
    try {
      batch = await listHotels(locationKey, page * 30, 30);
    } catch (e) {
      console.log(`  listing stopped: ${e.message}`);
      break;
    }
    if (!batch.length) break;
    await supa.from("hotel_directory").upsert(
      batch.map((h) => ({
        hotel_id: h.hotelKey,
        location_key: locationKey,
        name: h.name,
        seen_at: new Date().toISOString(),
      })),
      { onConflict: "hotel_id" }
    );
    listed += batch.length;
    if (batch.length < 30) break;
    await sleep(300);
  }
  console.log(`  listed ${listed} hotels`);

  // 2. Geocode
  const { data: pending } = await supa
    .from("hotel_directory")
    .select("hotel_id, name")
    .eq("location_key", locationKey)
    .is("latitude", null)
    .is("geo_attempted_at", null)
    .limit(60);
  let located = 0;
  for (const h of pending ?? []) {
    const geo = await geocode(h.name, profile.city_name ?? null);
    await supa
      .from("hotel_directory")
      .update(
        geo
          ? { latitude: geo.lat, longitude: geo.lon, geo_attempted_at: new Date().toISOString() }
          : { geo_attempted_at: new Date().toISOString() }
      )
      .eq("hotel_id", h.hotel_id);
    if (geo) located++;
  }
  console.log(`  geocoded ${located} new`);

  // 3. Rank by distance
  const { data: anchor } = await supa
    .from("hotel_directory")
    .select("latitude, longitude")
    .eq("hotel_id", baselineId)
    .maybeSingle();
  if (!anchor?.latitude) {
    console.log("  anchor not geocoded yet — rerun\n");
    continue;
  }
  const { data: pool } = await supa
    .from("hotel_directory")
    .select("hotel_id, name, latitude, longitude")
    .not("latitude", "is", null);
  const ranked = (pool ?? [])
    .filter((h) => h.hotel_id !== baselineId)
    .map((h) => ({
      ...h,
      distanceKm: haversineKm(anchor.latitude, anchor.longitude, h.latitude, h.longitude),
    }))
    .filter((h) => h.distanceKm <= 25)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const comps = ranked.slice(0, compCount);
  if (!comps.length) {
    console.log("  no neighbours within 25 km yet\n");
    continue;
  }

  // 4. Persist
  await supa.from("hotels").upsert(
    comps.map((c) => ({
      hotel_id: c.hotel_id,
      name: c.name,
      latitude: c.latitude,
      longitude: c.longitude,
      city_code: c.hotel_id.split("-")[0],
    })),
    { onConflict: "hotel_id" }
  );
  await supa.from("profile_hotels").upsert(
    comps.map((c) => ({ profile_id: profileId, hotel_id: c.hotel_id, is_mine: false, role: "comp" })),
    { onConflict: "profile_id,hotel_id" }
  );
  await supa
    .from("baseline_comps")
    .delete()
    .eq("profile_id", profileId)
    .eq("baseline_hotel_id", baselineId);
  await supa.from("baseline_comps").insert(
    comps.map((c) => ({
      profile_id: profileId,
      baseline_hotel_id: baselineId,
      comp_hotel_id: c.hotel_id,
      distance_km: c.distanceKm,
      discovered_at: new Date().toISOString(),
    }))
  );

  // Map context around each competitor
  const used = new Set([baselineId, ...comps.map((c) => c.hotel_id)]);
  const extras = [];
  for (const c of comps) {
    const near = ranked
      .filter((h) => !used.has(h.hotel_id) && !extras.some((e) => e.hotel_id === h.hotel_id))
      .map((h) => ({
        ...h,
        d: haversineKm(c.latitude, c.longitude, h.latitude, h.longitude),
      }))
      .filter((h) => h.d <= 8)
      .sort((a, b) => a.d - b.d)
      .slice(0, perCompExtras);
    extras.push(...near);
  }
  if (extras.length) {
    await supa.from("hotels").upsert(
      extras.map((e) => ({
        hotel_id: e.hotel_id,
        name: e.name,
        latitude: e.latitude,
        longitude: e.longitude,
        city_code: e.hotel_id.split("-")[0],
      })),
      { onConflict: "hotel_id" }
    );
    const { data: known } = await supa
      .from("profile_hotels")
      .select("hotel_id")
      .eq("profile_id", profileId);
    const knownSet = new Set((known ?? []).map((k) => k.hotel_id));
    const toAdd = extras.filter((e) => !knownSet.has(e.hotel_id));
    if (toAdd.length) {
      await supa.from("profile_hotels").insert(
        toAdd.map((e) => ({ profile_id: profileId, hotel_id: e.hotel_id, is_mine: false, role: "map" }))
      );
    }
  }

  console.log(
    `  → ${comps.length} competitors (nearest ${comps[0].distanceKm.toFixed(2)}–${comps[comps.length - 1].distanceKm.toFixed(2)} km), ${extras.length} map extras\n`
  );
}

console.log("Done. Run a rate refresh to fill in prices for the new hotels.");
