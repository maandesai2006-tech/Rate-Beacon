// Building a competitive set, and searching for hotels to add to one.
//
// Two rules shape all of this:
//
//   Everything must be rate-able. The rate feed is keyed on TripAdvisor hotel
//   keys, so a candidate without one is a name we can never price. Search
//   therefore returns keyed hotels only — a dropdown full of entries that
//   silently fail to collect rates is worse than a short dropdown.
//
//   Everything must be near. "Hampton Inn" matches several hundred hotels
//   worldwide; a compset is the handful a guest would actually choose between
//   instead. Every query is anchored to a point and cut at a radius, so
//   distance is a filter rather than a sort applied after the fact.

import type { SupabaseClient } from "@supabase/supabase-js";
import { listHotelsIn, type ListedHotel } from "./xotelo-list";
import { comparableName, milesBetween, sameProperty } from "./hotel-match";
import { geocodeHotel } from "./geo";
import { hotelsNear } from "./nearby";

export { comparableName, sameProperty, milesBetween } from "./hotel-match";

export const DEFAULT_RADIUS_MILES = 25;

export interface Candidate {
  hotelKey: string;
  name: string;
  distanceMiles: number | null;
  rating: number | null;
  reviewCount: number | null;
  latitude: number | null;
  longitude: number | null;
  alreadyTracked: boolean;
  /** Where the candidate was found — shown so an empty result is explainable. */
  source: "listing" | "known" | "map";
  /**
   * Whether the rate feed can follow it. A candidate found on the map is a real
   * hotel with no TripAdvisor id, so it cannot be priced until one is attached.
   */
  priceable: boolean;
  /** Set for unpriceable candidates: a search that lands on its TripAdvisor page. */
  lookupUrl?: string;
}

interface DirectoryRow {
  hotel_id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  review_count: number | null;
}

export interface Anchor {
  latitude: number;
  longitude: number;
  locationKey: string;
  cityName: string | null;
}

/**
 * Where "near" is measured from: the profile's own hotel if it has
 * coordinates, otherwise the profile's market.
 */
export async function anchorForProfile(
  supa: SupabaseClient,
  profileId: number,
  // For writing a freshly geocoded position back; the registry is shared.
  shared: SupabaseClient = supa
): Promise<{ anchor: Anchor | null; error?: string }> {
  const { data: mine } = await supa
    .from("profile_hotels")
    .select("hotel_id, hotels(name, latitude, longitude)")
    .eq("profile_id", profileId)
    .eq("is_mine", true)
    .returns<
      { hotel_id: string; hotels: { name: string; latitude: number | null; longitude: number | null } | null }[]
    >();

  const { data: profile } = await supa
    .from("profiles")
    .select("latitude, longitude, city_name, city_code")
    .eq("id", profileId)
    .maybeSingle<{
      latitude: number | null;
      longitude: number | null;
      city_name: string | null;
      city_code: string | null;
    }>();

  const placed = (mine ?? []).find(
    (m) => m.hotels?.latitude != null && m.hotels?.longitude != null
  );

  // The location key is the g-prefix of any tracked hotel; it is what the
  // listing endpoint takes.
  const locationKey =
    (mine ?? [])[0]?.hotel_id?.split("-")[0] ?? profile?.city_code ?? "";

  if (placed?.hotels?.latitude != null && placed.hotels.longitude != null) {
    return {
      anchor: {
        latitude: placed.hotels.latitude,
        longitude: placed.hotels.longitude,
        locationKey,
        cityName: profile?.city_name ?? null,
      },
    };
  }

  // The hotel has no coordinates yet — place it now rather than failing.
  const unplaced = (mine ?? [])[0];
  if (unplaced?.hotels?.name) {
    const geo = await geocodeHotel(unplaced.hotels.name, profile?.city_name ?? null);
    if (geo) {
      await shared
        .from("hotels")
        .update({
          latitude: geo.latitude,
          longitude: geo.longitude,
          address: geo.address,
        geo_precision: geo.precision,
          geo_updated_at: new Date().toISOString(),
        })
        .eq("hotel_id", unplaced.hotel_id);
      return {
        anchor: {
          latitude: geo.latitude,
          longitude: geo.longitude,
          locationKey,
          cityName: profile?.city_name ?? null,
        },
      };
    }
  }

  if (profile?.latitude != null && profile.longitude != null) {
    return {
      anchor: {
        latitude: profile.latitude,
        longitude: profile.longitude,
        locationKey,
        cityName: profile.city_name,
      },
    };
  }

  return {
    anchor: null,
    error: "Add your own hotel first — the search radius is measured from it.",
  };
}

/**
 * Pull a market's hotels into the directory.
 *
 * The directory is what search reads, so this is the expensive step and it is
 * cached: a market refreshed within the last week is left alone. Pages through
 * the listing until it stops returning new keys.
 */
export async function refreshDirectory(
  // The directory is shared: pass the service connection.
  supa: SupabaseClient,
  locationKey: string,
  { force = false, maxPages = 4, pageSize = 30 } = {}
): Promise<{ added: number; total: number; shape: string | null; error: string | null }> {
  if (!locationKey) return { added: 0, total: 0, shape: null, error: "No location key" };

  if (!force) {
    const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
    const { count } = await supa
      .from("hotel_directory")
      .select("hotel_id", { count: "exact", head: true })
      .eq("location_key", locationKey)
      .gt("last_listed_at", weekAgo);
    if ((count ?? 0) > 0) {
      const { count: total } = await supa
        .from("hotel_directory")
        .select("hotel_id", { count: "exact", head: true })
        .eq("location_key", locationKey);
      return { added: 0, total: total ?? 0, shape: "cached", error: null };
    }
  }

  const seen = new Map<string, ListedHotel>();
  let shape: string | null = null;
  let error: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const r = await listHotelsIn(supa, locationKey, { offset: page * pageSize, limit: pageSize });
    if (r.error) {
      // Only the first page's failure is fatal; a later page failing just
      // means a shorter directory.
      if (page === 0) error = r.error;
      break;
    }
    shape = r.shape;
    let fresh = 0;
    for (const h of r.hotels) {
      if (!seen.has(h.hotelKey)) {
        seen.set(h.hotelKey, h);
        fresh++;
      }
    }
    if (fresh === 0 || r.hotels.length < pageSize) break;
  }

  if (seen.size > 0) {
    const now = new Date().toISOString();
    await supa.from("hotel_directory").upsert(
      [...seen.values()].map((h) => ({
        hotel_id: h.hotelKey,
        location_key: locationKey,
        name: h.name,
        latitude: h.latitude,
        longitude: h.longitude,
        rating: h.rating,
        review_count: h.reviewCount,
        last_listed_at: now,
        seen_at: now,
      })),
      { onConflict: "hotel_id" }
    );
  }

  const { count: total } = await supa
    .from("hotel_directory")
    .select("hotel_id", { count: "exact", head: true })
    .eq("location_key", locationKey);

  return { added: seen.size, total: total ?? 0, shape, error };
}

/** Place directory entries that arrived without coordinates. Bounded — Nominatim asks for ~1/s. */
export async function placeDirectory(
  // Writes coordinates into the shared directory: pass the service connection.
  supa: SupabaseClient,
  locationKey: string,
  cityName: string | null,
  limit = 12
): Promise<number> {
  const { data: pending } = await supa
    .from("hotel_directory")
    .select("hotel_id, name")
    .eq("location_key", locationKey)
    .is("latitude", null)
    .is("geo_attempted_at", null)
    .limit(limit)
    .returns<{ hotel_id: string; name: string }[]>();

  let placed = 0;
  for (const h of pending ?? []) {
    const geo = await geocodeHotel(h.name, cityName);
    await supa
      .from("hotel_directory")
      .update({
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
        geo_attempted_at: new Date().toISOString(),
      })
      .eq("hotel_id", h.hotel_id);
    if (geo) placed++;
  }
  return placed;
}

/**
 * Hotels already known to the deployment, near a point.
 *
 * The market listing is the primary source, but it is one undocumented
 * upstream endpoint away from returning nothing, and a compset picker that
 * empties out when a third party changes a parameter name is not something to
 * sell. Every hotel any customer has ever tracked is already stored with a
 * TripAdvisor key and coordinates, so it is priceable by construction and
 * costs no external call. It is read here as a second source, unioned with the
 * listing rather than replacing it.
 *
 * The box is a degree approximation around the anchor; exact distance is
 * applied afterwards, so the box only has to be generous.
 */
async function knownHotelsNear(
  supa: SupabaseClient,
  anchor: Anchor,
  radiusMiles: number
): Promise<DirectoryRow[]> {
  const dLat = radiusMiles / 69;
  const dLon = radiusMiles / Math.max(1, 69 * Math.cos((anchor.latitude * Math.PI) / 180));

  const { data } = await supa
    .from("hotels")
    .select("hotel_id, name, latitude, longitude, rating, review_count")
    .gte("latitude", anchor.latitude - dLat)
    .lte("latitude", anchor.latitude + dLat)
    .gte("longitude", anchor.longitude - dLon)
    .lte("longitude", anchor.longitude + dLon)
    .limit(500)
    .returns<DirectoryRow[]>();

  return data ?? [];
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hotels within `radiusMiles` of the anchor, optionally matching a query.
 *
 * Entries whose coordinates are still unknown are kept only when the query
 * matches them by name, and are marked with a null distance — better to offer
 * a named match the operator recognises than to hide it because a geocoder
 * has not caught up.
 */
/** A TripAdvisor search that lands on the hotel, for a candidate we cannot price. */
function lookupUrlFor(name: string, near: string | null): string {
  const q = [name, near].filter(Boolean).join(" ");
  return `https://www.tripadvisor.com/Search?q=${encodeURIComponent(q)}`;
}

/**
 * Everything near the anchor, from every source, in one list.
 *
 * Three sources, in order of how much we can do with what they return:
 *
 *   listing  the rate provider's own market listing — priceable, and empty
 *            on this deployment because that endpoint has never answered.
 *   known    every hotel any account already tracks — priceable, free, and
 *            the reason a second customer in a covered market gets a compset
 *            immediately.
 *   map      OpenStreetMap — answers in every market, and carries no
 *            TripAdvisor id, so its hotels are real but not yet followable.
 *
 * A map hotel that turns out to be one we can already price is folded into the
 * priceable entry rather than offered twice.
 */
export async function searchNearby(
  supa: SupabaseClient,
  profileId: number,
  anchor: Anchor,
  {
    query = "",
    radiusMiles = DEFAULT_RADIUS_MILES,
    limit = 25,
    includeMap = true,
  }: { query?: string; radiusMiles?: number; limit?: number; includeMap?: boolean } = {}
): Promise<Candidate[]> {
  const [{ data: listed }, known, { data: tracked }, mapped] = await Promise.all([
    supa
      .from("hotel_directory")
      .select("hotel_id, name, latitude, longitude, rating, review_count")
      .eq("location_key", anchor.locationKey)
      .limit(500)
      .returns<DirectoryRow[]>(),
    knownHotelsNear(supa, anchor, radiusMiles),
    supa
      .from("profile_hotels")
      .select("hotel_id")
      .eq("profile_id", profileId)
      .returns<{ hotel_id: string }[]>(),
    includeMap
      ? hotelsNear(anchor.latitude, anchor.longitude, radiusMiles, 60).catch(() => [])
      : Promise.resolve([]),
  ]);

  // Union the two priceable sources, listing first so its ratings win, and a
  // row with coordinates beating one without whichever source it came from.
  const merged = new Map<string, { row: DirectoryRow; source: "listing" | "known" }>();
  for (const row of listed ?? []) merged.set(row.hotel_id, { row, source: "listing" });
  for (const row of known) {
    const existing = merged.get(row.hotel_id);
    if (!existing) {
      merged.set(row.hotel_id, { row, source: "known" });
    } else if (existing.row.latitude == null && row.latitude != null) {
      merged.set(row.hotel_id, {
        row: { ...existing.row, latitude: row.latitude, longitude: row.longitude },
        source: existing.source,
      });
    }
  }

  const trackedSet = new Set((tracked ?? []).map((t) => t.hotel_id));
  const q = normalise(query);
  const terms = q ? q.split(" ").filter(Boolean) : [];
  const matchesQuery = (name: string) =>
    terms.length === 0 || terms.every((t) => normalise(name).includes(t));

  const out: Candidate[] = [];
  const priceableRows: { name: string; latitude: number | null; longitude: number | null }[] = [];

  for (const { row: r, source } of merged.values()) {
    priceableRows.push({ name: r.name, latitude: r.latitude, longitude: r.longitude });

    const distance =
      r.latitude != null && r.longitude != null
        ? milesBetween(anchor, { latitude: r.latitude, longitude: r.longitude })
        : null;

    if (distance != null && distance > radiusMiles) continue;
    if (!matchesQuery(r.name)) continue;
    // Browsing rather than searching: only show what we can actually place.
    if (terms.length === 0 && distance == null) continue;

    out.push({
      hotelKey: r.hotel_id,
      name: r.name,
      distanceMiles: distance,
      rating: r.rating,
      reviewCount: r.review_count,
      latitude: r.latitude,
      longitude: r.longitude,
      alreadyTracked: trackedSet.has(r.hotel_id),
      source,
      priceable: true,
    });
  }

  // Map hotels we cannot already price: real neighbours, offered with the one
  // thing missing rather than hidden because a third party has no record.
  for (const hotel of mapped) {
    if (priceableRows.some((p) => sameProperty(hotel, p))) continue;
    if (!matchesQuery(hotel.name)) continue;
    out.push({
      hotelKey: `osm:${hotel.osmId}`,
      name: hotel.name,
      distanceMiles: hotel.distanceMiles,
      rating: null,
      reviewCount: null,
      latitude: hotel.latitude,
      longitude: hotel.longitude,
      alreadyTracked: false,
      source: "map",
      priceable: false,
      lookupUrl: lookupUrlFor(hotel.name, anchor.cityName),
    });
  }

  // Nearest first, and anything we can price ahead of anything we cannot at the
  // same distance — the operator should reach for the ready ones first.
  out.sort((a, b) => {
    if (a.priceable !== b.priceable) return a.priceable ? -1 : 1;
    if (a.distanceMiles == null) return 1;
    if (b.distanceMiles == null) return -1;
    return a.distanceMiles - b.distanceMiles;
  });

  return out.slice(0, limit);
}
