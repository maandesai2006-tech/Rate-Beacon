// Somewhere errors go that is not a browser console.
//
// The background jobs — collection, mailbox sync, report ingest — run with
// nobody watching. When one of them fails the only record used to be a line
// in a serverless log that expires, so a customer's reports could stop
// arriving for a week before anyone noticed. Every catch block that matters
// now writes a row here, and the system check reads the last day of them.
//
// Never throws: an error reporter that can itself fail is worse than none.

import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";

export type ErrorArea =
  | "collection"
  | "mailbox"
  | "ingest"
  | "geocode"
  | "discovery"
  | "auth"
  | "contact"
  | "assistant";

export async function reportError(
  area: ErrorArea,
  error: unknown,
  { accountId = null, detail = null }: { accountId?: number | null; detail?: string | null } = {},
  supa: SupabaseClient = db()
): Promise<void> {
  try {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
    await supa.from("app_errors").insert({
      area,
      message: message.slice(0, 500),
      detail: detail?.slice(0, 4000) ?? (error instanceof Error ? error.stack?.slice(0, 4000) ?? null : null),
      account_id: accountId,
    });
  } catch {
    // Swallowed on purpose.
  }
}

export interface RecentErrors {
  count: number;
  byArea: Record<string, number>;
  latest: { area: string; message: string; occurredAt: string } | null;
}

/** The last 24 hours of failures, for the system check. */
export async function recentErrors(supa: SupabaseClient = db()): Promise<RecentErrors> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data } = await supa
    .from("app_errors")
    .select("area, message, occurred_at")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(500)
    .returns<{ area: string; message: string; occurred_at: string }[]>();

  const rows = data ?? [];
  const byArea: Record<string, number> = {};
  for (const r of rows) byArea[r.area] = (byArea[r.area] ?? 0) + 1;

  return {
    count: rows.length,
    byArea,
    latest: rows[0] ? { area: rows[0].area, message: rows[0].message, occurredAt: rows[0].occurred_at } : null,
  };
}
