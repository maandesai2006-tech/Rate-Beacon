// One mailbox sync: read new messages, turn each into a filed report.

import { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret } from "./secrets";
import { fetchReports } from "./mailbox";
import { ingestReport } from "./report-ingest";

export interface SyncOutcome {
  profileId: number;
  scanned: number;
  filed: number;
  skipped: string[];
  /** True when the mailbox still had messages when the time budget ran out. */
  hasMore: boolean;
  lastUid: number;
  error?: string;
}

/** How many messages one IMAP round trip pulls. The edge function caps the payload at 12 MB. */
const BATCH = 5;

export async function syncMailbox(
  supa: SupabaseClient,
  source: {
    id: number;
    profile_id: number;
    host: string;
    port: number;
    username: string;
    secret: string;
    mailbox: string;
    subject_filter: string | null;
    from_filter: string | null;
    last_uid: number;
  },
  /**
   * Milliseconds to keep pulling batches for. A mailbox holding years of
   * reports needs hundreds of round trips, so one call works through as many
   * as it can and reports `hasMore` for the caller to resume — the same
   * pattern the rate refresh uses to live inside Vercel's 60-second ceiling.
   */
  budgetMs = 45_000
): Promise<SyncOutcome> {
  const skipped: string[] = [];
  const startedAt = Date.now();
  let uid = source.last_uid;
  let scannedTotal = 0;
  let filed = 0;
  let hasMore = false;

  try {
    const password = await decryptSecret(source.secret);

    for (;;) {
      const { reports, highestUid, scanned } = await fetchReports(
        {
          host: source.host,
          port: source.port,
          username: source.username,
          password,
          mailbox: source.mailbox,
          subjectFilter: source.subject_filter,
          fromFilter: source.from_filter,
        },
        uid,
        BATCH
      );

      scannedTotal += scanned;

      for (const r of reports) {
        if (r.note) skipped.push(r.note);
        const result = await ingestReport(supa, {
          profileId: source.profile_id,
          text: r.text,
          subject: r.subject,
          fileName: r.fileName ?? undefined,
          pdfBase64: r.pdfBase64,
          source: "email",
        });
        if (result.reportId) {
          filed++;
          if (r.messageId) {
            await supa
              .from("daily_manager_reports")
              .update({ message_id: r.messageId })
              .eq("id", result.reportId);
          }
        } else if (result.error) {
          skipped.push(`${r.subject || "message"}: ${result.error}`);
        }
      }

      // The mailbox is exhausted when a batch advances no further.
      if (highestUid <= uid || scanned === 0) break;
      uid = highestUid;

      // Persist after every batch: a timeout mid-backfill should cost the
      // current batch, not the whole run.
      await supa.from("email_sources").update({ last_uid: uid }).eq("id", source.id);

      if (scanned < BATCH) break;
      if (Date.now() - startedAt > budgetMs) {
        hasMore = true;
        break;
      }
    }

    await supa
      .from("email_sources")
      .update({
        last_uid: uid,
        last_sync_at: new Date().toISOString(),
        last_status: `Checked ${scannedTotal} message${scannedTotal === 1 ? "" : "s"}, filed ${filed}.${
          hasMore ? " More still waiting." : ""
        }`,
      })
      .eq("id", source.id);

    return { profileId: source.profile_id, scanned: scannedTotal, filed, skipped, hasMore, lastUid: uid };
  } catch (e) {
    const message = (e as Error).message;
    await supa
      .from("email_sources")
      .update({ last_uid: uid, last_sync_at: new Date().toISOString(), last_status: `Failed: ${message}` })
      .eq("id", source.id);
    return {
      profileId: source.profile_id,
      scanned: scannedTotal,
      filed,
      skipped,
      hasMore: false,
      lastUid: uid,
      error: message,
    };
  }
}
