// What an account's plan allows.
//
// Limits are rows, not constants, so a customer's ceiling can be changed
// without a deploy. Read once per request where they matter: creating a
// profile, adding competitors, setting a horizon.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PlanLimits {
  plan: string;
  maxProfiles: number;
  maxCompetitors: number;
  maxHorizon: number;
}

const FALLBACK: PlanLimits = { plan: "standard", maxProfiles: 3, maxCompetitors: 15, maxHorizon: 75 };

export async function planLimits(supa: SupabaseClient, accountId: number): Promise<PlanLimits> {
  const { data: account } = await supa
    .from("accounts")
    .select("plan")
    .eq("id", accountId)
    .maybeSingle<{ plan: string | null }>();
  const plan = account?.plan ?? FALLBACK.plan;

  const { data: row } = await supa
    .from("plan_limits")
    .select("plan, max_profiles, max_competitors, max_horizon")
    .eq("plan", plan)
    .maybeSingle<{ plan: string; max_profiles: number; max_competitors: number; max_horizon: number }>();

  if (!row) return { ...FALLBACK, plan };
  return {
    plan: row.plan,
    maxProfiles: row.max_profiles,
    maxCompetitors: row.max_competitors,
    maxHorizon: row.max_horizon,
  };
}
