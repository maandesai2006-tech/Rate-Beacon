// Competitor discovery, entirely from data.
//
// For any hotel: list every hotel TripAdvisor knows in its location, geocode
// them, then rank by great-circle distance from the anchor. The nearest N
// become that hotel's competitor set; the next M become map context. No
// hand-authored lists, so adding a hotel anywhere in the world runs the same
// pipeline and gets its own competitors rather than inheriting someone else's.

import { SupabaseClient } from "@supabase/supabase-js";
import { listHotels } from "./xotelo";
import { geocodeHotel } from "./geo";

export interface DirectoryEntry {
  hotel_id: string;
  location_key: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

export function haversineKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function locationKeyOf(hotelId: string): string {
  return hotelId.split("-")[0];
}

// Page a location's hotels into the directory. Safe to re-run: it upserts.
export async function syncDirectory(
  supa: SupabaseClient,
  locationKey: string,
  maxPages = 6
): Promise<{ added: number; errors: string[] }> {
  const errors: string[] = [];
  let added = 0;
  for (let page = 0; page < maxPages; page++) {
    let batch: { hotelKey: string; name: string }[] = [];
    try {
      batch = await listHotels(locationKey, page * 30, 30);
    } catch (e) {
      errors.push(`list(${locationKey} p${page}): ${(e as Error).message}`);
      break;
    }
    if (batch.length === 0) break;
    const { error } = await supa.from("hotel_directory").upsert(
      batch.map((h) => ({
        hotel_id: h.hotelKey,
        location_key: locationKey,
        name: h.name,
        seen_at: new Date().toISOString(),
      })),
      { onConflict: "hotel_id", ignoreDuplicates: false }
    );
    if (error) errors.push(`directory(${locationKey}): ${error.message}`);
    else added += batch.length;
    if (batch.length < 30) break;
  }
  return { added, errors };
}

// Geocode directory rows that still lack coordinates. Nominatim asks for
// roughly one request a second, so callers cap the batch.
export async function geocodeDirectory(
  supa: SupabaseClient,
  locationKey: string,
  near: string | null,
  limit = 25
): Promise<{ located: number; errors: string[] }> {
  const errors: string[] = [];
  let located = 0;
  const { data: pending } = await supa
    .from("hotel_directory")
    .select("hotel_id, name")
    .eq("location_key", locationKey)
    .is("latitude", null)
    .is("geo_attempted_at", null)
    .limit(limit)
    .returns<{ hotel_id: string; name: string }[]>();

  for (const h of pending ?? []) {
    const geo = await geocodeHotel(h.name, near);
    const patch = geo
      ? {
          latitude: geo.latitude,
          longitude: geo.longitude,
          geo_attempted_at: new Date().toISOString(),
        }
      : { geo_attempted_at: new Date().toISOString() };
    const { error } = await supa
      .from("hotel_directory")
      .update(patch)
      .eq("hotel_id", h.hotel_id);
    if (error) errors.push(`geo(${h.name}): ${error.message}`);
    else if (geo) located++;
  }
  return { located, errors };
}

export interface Ranked {
  hotel_id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

// Nearest hotels to an anchor, from the directory. `exclude` keeps a hotel
// from being its own competitor and lets callers carve out already-used ids.
export async function nearestTo(
  supa: SupabaseClient,
  anchorId: string,
  opts: { limit: number; exclude?: Set<string>; maxKm?: number } = { limit: 15 }
): Promise<Ranked[]> {
  const locationKey = locationKeyOf(anchorId);
  const { data: anchor } = await supa
    .from("hotel_directory")
    .select("latitude, longitude")
    .eq("hotel_id", anchorId)
    .maybeSingle<{ latitude: number | null; longitude: number | null }>();
  if (anchor?.latitude == null || anchor?.longitude == null) return [];

  // Neighbouring TripAdvisor locations matter too (a market often spans more
  // than one), so rank across every located hotel and let distance decide.
  const { data: pool } = await supa
    .from("hotel_directory")
    .select("hotel_id, name, latitude, longitude")
    .not("latitude", "is", null)
    .returns<DirectoryEntry[]>();

  const exclude = opts.exclude ?? new Set<string>();
  const maxKm = opts.maxKm ?? 25;
  return (pool ?? [])
    .filter(
      (h) =>
        h.hotel_id !== anchorId &&
        !exclude.has(h.hotel_id) &&
        h.latitude != null &&
        h.longitude != null
    )
    .map((h) => ({
      hotel_id: h.hotel_id,
      name: h.name,
      latitude: h.latitude as number,
      longitude: h.longitude as number,
      distanceKm: haversineKm(
        anchor.latitude as number,
        anchor.longitude as number,
        h.latitude as number,
        h.longitude as number
      ),
    }))
    .filter((h) => h.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, opts.limit)
    .concat([])
    .map((h) => ({ ...h, location_key: locationKey } as Ranked));
}

export interface DiscoverResult {
  baseline: string;
  comps: number;
  mapExtras: number;
  errors: string[];
}

// Full run for one baseline: sync + geocode its location, take the nearest
// `compCount` as competitors, then the nearest `perCompExtras` around each of
// those as map-only context.
export async function discoverForBaseline(
  supa: SupabaseClient,
  profileId: number,
  baselineId: string,
  near: string | null,
  compCount = 15,
  perCompExtras = 3
): Promise<DiscoverResult> {
  const errors: string[] = [];
  const locationKey = locationKeyOf(baselineId);

  const sync = await syncDirectory(supa, locationKey);
  errors.push(...sync.errors);
  const geo = await geocodeDirectory(supa, locationKey, near, 30);
  errors.push(...geo.errors);

  const comps = await nearestTo(supa, baselineId, { limit: compCount });
  if (comps.length === 0) {
    return { baseline: baselineId, comps: 0, mapExtras: 0, errors: [...errors, "no located neighbours yet — run again after geocoding catches up"] };
  }

  // Persist the hotels themselves, then the baseline→comp edges.
  await supa.from("hotels").upsert(
    comps.map((c) => ({
      hotel_id: c.hotel_id,
      name: c.name,
      latitude: c.latitude,
      longitude: c.longitude,
      city_code: locationKey,
    })),
    { onConflict: "hotel_id" }
  );
  await supa.from("profile_hotels").upsert(
    comps.map((c) => ({
      profile_id: profileId,
      hotel_id: c.hotel_id,
      is_mine: false,
      role: "comp",
    })),
    { onConflict: "profile_id,hotel_id" }
  );
  await supa.from("baseline_comps").delete().eq("profile_id", profileId).eq("baseline_hotel_id", baselineId);
  await supa.from("baseline_comps").insert(
    comps.map((c) => ({
      profile_id: profileId,
      baseline_hotel_id: baselineId,
      comp_hotel_id: c.hotel_id,
      distance_km: c.distanceKm,
      discovered_at: new Date().toISOString(),
    }))
  );

  // Map context: a few hotels around each competitor that aren't tracked.
  const used = new Set<string>([baselineId, ...comps.map((c) => c.hotel_id)]);
  const extras: Ranked[] = [];
  for (const c of comps) {
    const near3 = await nearestTo(supa, c.hotel_id, {
      limit: perCompExtras,
      exclude: new Set([...used, ...extras.map((e) => e.hotel_id)]),
      maxKm: 8,
    });
    extras.push(...near3);
  }
  if (extras.length) {
    await supa.from("hotels").upsert(
      extras.map((e) => ({
        hotel_id: e.hotel_id,
        name: e.name,
        latitude: e.latitude,
        longitude: e.longitude,
        city_code: locationKeyOf(e.hotel_id),
      })),
      { onConflict: "hotel_id" }
    );
    // Only add as map context where the hotel isn't already tracked.
    const { data: existing } = await supa
      .from("profile_hotels")
      .select("hotel_id, role")
      .eq("profile_id", profileId)
      .returns<{ hotel_id: string; role: string }[]>();
    const known = new Set((existing ?? []).map((e) => e.hotel_id));
    const toAdd = extras.filter((e) => !known.has(e.hotel_id));
    if (toAdd.length) {
      await supa.from("profile_hotels").insert(
        toAdd.map((e) => ({
          profile_id: profileId,
          hotel_id: e.hotel_id,
          is_mine: false,
          role: "map",
        }))
      );
    }
  }

  return {
    baseline: baselineId,
    comps: comps.length,
    mapExtras: extras.length,
    errors,
  };
}
