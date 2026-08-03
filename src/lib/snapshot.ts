import { db } from "./db";
import { getRates } from "./xotelo";
import { addDaysISO, dateRange, todayISO } from "./dates";
import { refreshEvents, refreshGeo, refreshRatings } from "./enrich";
import type { Profile } from "./types";

export interface SnapshotResult {
  profiles: number;
  hotels: number;
  dates: number;
  rowsWritten: number;
  errors: string[];
}

interface TrackedHotel {
  hotel_id: string;
  name: string;
  currency: string;
  adults: number;
  horizon: number;
}

// Fetch nightly quotes for every hotel tracked by any profile and store
// today's snapshot. A hotel shared by several profiles is fetched once, using
// the widest horizon among them. One Xotelo request per hotel per night, so a
// small worker pool; `maxDates` keeps a run inside serverless time limits.
export async function runSnapshot(maxDates?: number): Promise<SnapshotResult> {
  const supa = db();

  const [{ data: profiles }, { data: links }, { data: hotelRows }] =
    await Promise.all([
      supa.from("profiles").select("*").returns<Profile[]>(),
      supa
        .from("profile_hotels")
        .select("profile_id, hotel_id")
        .returns<{ profile_id: number; hotel_id: string }[]>(),
      supa
        .from("hotels")
        .select("hotel_id, name")
        .returns<{ hotel_id: string; name: string }[]>(),
    ]);
  if (!profiles?.length || !links?.length) {
    return { profiles: 0, hotels: 0, dates: 0, rowsWritten: 0, errors: ["No profiles configured yet"] };
  }

  const nameById = new Map(hotelRows?.map((h) => [h.hotel_id, h.name]) ?? []);
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const tracked = new Map<string, TrackedHotel>();
  for (const link of links) {
    const p = profileById.get(link.profile_id);
    if (!p) continue;
    const existing = tracked.get(link.hotel_id);
    if (existing) {
      existing.horizon = Math.max(existing.horizon, p.horizon_days);
    } else {
      tracked.set(link.hotel_id, {
        hotel_id: link.hotel_id,
        name: nameById.get(link.hotel_id) ?? link.hotel_id,
        currency: p.currency,
        adults: p.adults,
        horizon: p.horizon_days,
      });
    }
  }

  const maxHorizon = Math.min(
    Math.max(...[...tracked.values()].map((h) => h.horizon)),
    maxDates ?? 120
  );
  const dates = dateRange(todayISO(), maxHorizon);
  const errors: string[] = [];
  let rowsWritten = 0;

  const jobs = dates.flatMap((checkIn, dayIdx) =>
    [...tracked.values()]
      .filter((h) => dayIdx < h.horizon)
      .map((hotel) => ({ checkIn, hotel }))
  );

  const CONCURRENCY = 4;
  let cursor = 0;
  let aborted = false;

  async function worker() {
    while (!aborted) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const { checkIn, hotel } = jobs[i];
      try {
        const r = await getRates(
          hotel.hotel_id,
          hotel.name,
          checkIn,
          addDaysISO(checkIn, 1),
          hotel.currency,
          hotel.adults
        );
        const { error } = await supa.from("rate_snapshots").upsert(
          {
            hotel_id: hotel.hotel_id,
            check_in: checkIn,
            captured_on: todayISO(),
            price: r.price,
            price_low: r.priceLow,
            rate_source: r.source ? `${r.source}${r.direct ? " (direct)" : ""}` : null,
            offers: r.offers,
            currency: r.currency ?? hotel.currency,
            available: r.available,
            room_desc: null,
          },
          { onConflict: "hotel_id,check_in,captured_on" }
        );
        if (error) errors.push(`${hotel.name} ${checkIn}: ${error.message}`);
        else rowsWritten++;
      } catch (e) {
        errors.push(`${hotel.name} ${checkIn}: ${(e as Error).message}`);
        // Persistent failure (network, upstream outage) — stop hammering.
        if (errors.length >= 10) aborted = true;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Best-effort enrichment: local events + review standing.
  errors.push(...(await refreshEvents(supa, profiles)));
  errors.push(...(await refreshRatings(supa, profiles)));
  errors.push(...(await refreshGeo(supa, profiles)));

  return {
    profiles: profiles.length,
    hotels: tracked.size,
    dates: dates.length,
    rowsWritten,
    errors: errors.slice(0, 10),
  };
}
