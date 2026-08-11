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
  error?: string;
}

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
  }
): Promise<SyncOutcome> {
  const skipped: string[] = [];
  try {
    const password = await decryptSecret(source.secret);
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
      source.last_uid,
      5
    );

    let filed = 0;
    for (const r of reports) {
      if (r.note) skipped.push(r.note);
      const result = await ingestReport(supa, {
        profileId: source.profile_id,
        text: r.text,
        subject: r.subject,
        fileName: r.fileName ?? undefined,
        source: "email",
      });
      if (result.reportId) {
        filed++;
        if (r.messageId) {
          await supa
            .from("manager_reports")
            .update({ message_id: r.messageId })
            .eq("id", result.reportId);
        }
      } else if (result.error) {
        skipped.push(`${r.subject || "message"}: ${result.error}`);
      }
    }

    await supa
      .from("email_sources")
      .update({
        last_uid: highestUid,
        last_sync_at: new Date().toISOString(),
        last_status: `Checked ${scanned} message${scanned === 1 ? "" : "s"}, filed ${filed}.`,
      })
      .eq("id", source.id);

    return { profileId: source.profile_id, scanned, filed, skipped };
  } catch (e) {
    const message = (e as Error).message;
    await supa
      .from("email_sources")
      .update({ last_sync_at: new Date().toISOString(), last_status: `Failed: ${message}` })
      .eq("id", source.id);
    return { profileId: source.profile_id, scanned: 0, filed: 0, skipped, error: message };
  }
}
