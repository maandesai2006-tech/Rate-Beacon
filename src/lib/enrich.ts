// Cron-time enrichment: local events per profile (Ticketmaster) and hotel
// review standing (TripAdvisor via Xotelo's location listing). Both are
// best-effort: failures are reported but never abort the rate snapshot.

import { SupabaseClient } from "@supabase/supabase-js";
import { getTicketmasterEvents } from "./signals";
import { listHotels } from "./xotelo";
import { addDaysISO, todayISO } from "./dates";
import type { Profile } from "./types";

export async function refreshEvents(
  supa: SupabaseClient,
  profiles: Profile[]
): Promise<string[]> {
  const errors: string[] = [];
  for (const p of profiles) {
    if (p.latitude == null || p.longitude == null) continue;
    try {
      const events = await getTicketmasterEvents(
        p.latitude,
        p.longitude,
        todayISO(),
        addDaysISO(todayISO(), p.horizon_days)
      );
      if (events.length === 0) continue;
      // Replace the window's events wholesale — simplest way to drop cancels.
      await supa
        .from("events")
        .delete()
        .eq("profile_id", p.id)
        .gte("event_date", todayISO());
      const { error } = await supa.from("events").upsert(
        events.map((e) => ({
          profile_id: p.id,
          event_date: e.date,
          name: e.name,
          venue: e.venue,
          category: e.category,
          url: e.url,
        })),
        { onConflict: "profile_id,event_date,name", ignoreDuplicates: true }
      );
      if (error) errors.push(`events(${p.name}): ${error.message}`);
    } catch (e) {
      errors.push(`events(${p.name}): ${(e as Error).message}`);
    }
  }
  return errors;
}

// Refresh rating/review_count for tracked hotels at most weekly, by paging
// their location's listing and matching keys.
export async function refreshRatings(
  supa: SupabaseClient,
  profiles: Profile[]
): Promise<string[]> {
  const errors: string[] = [];
  const { data: tracked } = await supa
    .from("hotels")
    .select("hotel_id, rating_updated_at")
    .returns<{ hotel_id: string; rating_updated_at: string | null }[]>();
  const stale = new Set(
    (tracked ?? [])
      .filter(
        (h) =>
          !h.rating_updated_at ||
          Date.now() - new Date(h.rating_updated_at).getTime() > 7 * 86400_000
      )
      .map((h) => h.hotel_id)
  );
  if (stale.size === 0) return errors;

  const locations = [...new Set(profiles.map((p) => p.city_code).filter(Boolean))] as string[];
  for (const loc of locations) {
    try {
      for (let page = 0; page < 3; page++) {
        const hotels = await listHotels(loc, page * 30, 30);
        if (hotels.length === 0) break;
        for (const h of hotels) {
          if (!stale.has(h.hotelKey) || h.rating == null) continue;
          const { error } = await supa
            .from("hotels")
            .update({
              rating: h.rating,
              review_count: h.reviewCount,
              rating_updated_at: new Date().toISOString(),
            })
            .eq("hotel_id", h.hotelKey);
          if (error) errors.push(`rating(${h.hotelKey}): ${error.message}`);
          stale.delete(h.hotelKey);
        }
        if (hotels.length < 30) break;
      }
    } catch (e) {
      errors.push(`ratings(${loc}): ${(e as Error).message}`);
    }
  }
  return errors;
}
