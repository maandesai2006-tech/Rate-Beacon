// Profiles, and who owns them.
//
// A profile is the unit a customer works in: one baseline hotel, its market,
// its competitive set, its horizon. Every other screen finds a customer's data
// by walking from their account to their profiles, so a profile without an
// owner is invisible to everyone — including the person who just created it.
//
// That is exactly what used to happen. The setup endpoint predates accounts:
// it wrote profiles with no owner and accepted whatever profile id the caller
// sent, so a new customer finished onboarding and was told to create a profile,
// while a signed-in one could read or overwrite somebody else's by changing a
// number. Three of the five accounts on the deployment reached that dead end.
//
// So ownership lives here rather than in the route: every read, write and
// delete takes an account id and refuses anything that account does not own.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Profile } from "./types";

export interface ProfileHotelInput {
  hotelId: string;
  name: string;
  isMine: boolean;
}

export interface SaveProfileInput {
  profileId?: number | null;
  name?: string;
  hotelName: string;
  cityCode: string;
  cityName: string;
  currency: string;
  horizonDays: number;
  adults: number;
  notes?: string;
  hotels: ProfileHotelInput[];
}

export type SaveResult =
  | { ok: true; profileId: number; created: boolean }
  | { ok: false; status: number; error: string };

/** The profile with this id, but only if this account owns it. */
export async function ownedProfile(
  supa: SupabaseClient,
  accountId: number,
  profileId: number
): Promise<Profile | null> {
  const { data } = await supa
    .from("profiles")
    .select("*")
    .eq("id", profileId)
    .eq("account_id", accountId)
    .maybeSingle<Profile>();
  return data ?? null;
}

/** This account's profiles, oldest first. Empty for a brand-new account. */
export async function profilesForAccount(
  supa: SupabaseClient,
  accountId: number
): Promise<Profile[]> {
  const { data } = await supa
    .from("profiles")
    .select("*")
    .eq("account_id", accountId)
    .order("id")
    .returns<Profile[]>();
  return data ?? [];
}

function clean(input: SaveProfileInput) {
  return {
    name: input.name || input.hotelName || input.cityName || "New profile",
    hotel_name: input.hotelName || null,
    city_code: input.cityCode,
    city_name: input.cityName || null,
    currency: input.currency || "USD",
    horizon_days: Math.min(120, Math.max(7, input.horizonDays || 45)),
    adults: Math.min(9, Math.max(1, input.adults || 2)),
    notes: input.notes ?? null,
  };
}

/**
 * Create or update one of this account's profiles, with its tracked hotels.
 *
 * An update is only allowed on a profile the account already owns — a caller
 * passing someone else's id gets the same answer as one passing an id that
 * does not exist, so the endpoint cannot be used to discover which profiles
 * are real.
 */
/** The two limits a profile save has to respect. Looked up by the route. */
export interface ProfileLimits {
  maxProfiles: number;
  maxHorizon: number;
}

// No ceiling at all — what a caller that has not looked up a plan gets.
const NO_LIMITS: ProfileLimits = { maxProfiles: Number.POSITIVE_INFINITY, maxHorizon: 120 };

export async function saveProfile(
  supa: SupabaseClient,
  accountId: number,
  input: SaveProfileInput,
  {
    // The hotel registry is shared and the scoped connection cannot write it;
    // tests pass the same stand-in for both.
    shared = supa,
    // Passed in rather than fetched here, so this module depends on nothing
    // but the database and the rule can be tested with any limit.
    limits = NO_LIMITS,
  }: { shared?: SupabaseClient; limits?: ProfileLimits } = {}
): Promise<SaveResult> {
  if (!input.cityCode || !Array.isArray(input.hotels) || input.hotels.length === 0) {
    return { ok: false, status: 400, error: "Pick a location and at least one hotel to track" };
  }
  if (!input.hotels.some((h) => h.isMine)) {
    // Without this, the dashboard has no baseline to build a grid around and
    // the customer lands on an empty screen with nothing to fix.
    return { ok: false, status: 400, error: "Mark which of these hotels is yours" };
  }

  const fields = clean(input);
  // The plan's horizon is a ceiling on what the collector will price for this
  // account; a longer one costs everyone else's collection window.
  fields.horizon_days = Math.min(fields.horizon_days, limits.maxHorizon);

  let profileId = input.profileId ?? null;
  let created = false;

  if (profileId) {
    const existing = await ownedProfile(supa, accountId, profileId);
    if (!existing) return { ok: false, status: 404, error: "No such profile" };

    const { error } = await supa
      .from("profiles")
      .update(fields)
      .eq("id", profileId)
      .eq("account_id", accountId);
    if (error) return { ok: false, status: 500, error: error.message };
  } else {
    const existing = await profilesForAccount(supa, accountId);
    if (existing.length >= limits.maxProfiles) {
      return {
        ok: false,
        status: 403,
        error: `This plan allows ${limits.maxProfiles} propert${limits.maxProfiles === 1 ? "y" : "ies"}. Contact us to add more.`,
      };
    }
    // The owner is written with the row, not afterwards: a profile that exists
    // for even a moment without one is a profile nobody can see.
    const { data, error } = await supa
      .from("profiles")
      .insert({ ...fields, account_id: accountId })
      .select("id")
      .maybeSingle<{ id: number }>();
    if (error) return { ok: false, status: 500, error: error.message };
    if (!data) return { ok: false, status: 500, error: "The profile could not be created" };
    profileId = data.id;
    created = true;
  }

  // The hotel registry is shared across every account — a hotel is a hotel —
  // so this write goes through the service connection. The scoped one is
  // read-only on this table by design.
  const { error: hotelsError } = await shared
    .from("hotels")
    .upsert(
      input.hotels.map((h) => ({ hotel_id: h.hotelId, name: h.name })),
      { onConflict: "hotel_id" }
    );
  if (hotelsError) return { ok: false, status: 500, error: hotelsError.message };

  const { error: clearError } = await supa
    .from("profile_hotels")
    .delete()
    .eq("profile_id", profileId);
  if (clearError) return { ok: false, status: 500, error: clearError.message };

  const { error: linkError } = await supa.from("profile_hotels").insert(
    input.hotels.map((h) => ({
      profile_id: profileId,
      hotel_id: h.hotelId,
      is_mine: h.isMine,
      role: "comp",
    }))
  );
  if (linkError) return { ok: false, status: 500, error: linkError.message };

  return { ok: true, profileId: profileId as number, created };
}

/** Delete one of this account's profiles. Someone else's is simply not found. */
export async function deleteProfile(
  supa: SupabaseClient,
  accountId: number,
  profileId: number
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const existing = await ownedProfile(supa, accountId, profileId);
  if (!existing) return { ok: false, status: 404, error: "No such profile" };

  const { error } = await supa
    .from("profiles")
    .delete()
    .eq("id", profileId)
    .eq("account_id", accountId);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true };
}
