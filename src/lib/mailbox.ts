// Reads manager's reports straight from a mailbox over IMAP.
//
// This is the "set it up once" path: the operator enters their existing email
// login, and the app checks that mailbox on a schedule from then on. It works
// with any IMAP provider (one.com, Gmail, Outlook, Fastmail…), so nothing
// about it is specific to one host, and it needs no domain or forwarding rule.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { pdfToText } from "./pdf";

export interface MailboxConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  mailbox: string;
  subjectFilter?: string | null;
  fromFilter?: string | null;
}

export interface FetchedReport {
  uid: number;
  messageId: string | null;
  subject: string;
  from: string;
  date: string | null;
  fileName: string | null;
  text: string;
  note?: string;
}

export async function testConnection(cfg: MailboxConfig): Promise<{ ok: boolean; detail: string }> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox || "INBOX");
    try {
      const box = client.mailbox;
      const count = typeof box === "object" && box ? box.exists : 0;
      return { ok: true, detail: `Connected. ${count} message${count === 1 ? "" : "s"} in ${cfg.mailbox || "INBOX"}.` };
    } finally {
      lock.release();
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  } finally {
    await client.logout().catch(() => {});
  }
}

// Everything newer than `sinceUid`, with PDF (and other) attachments turned
// into text. Bounded so one run cannot exceed the function time limit.
export async function fetchReports(
  cfg: MailboxConfig,
  sinceUid: number,
  max = 15
): Promise<{ reports: FetchedReport[]; highestUid: number; scanned: number; note?: string }> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
  });
  const reports: FetchedReport[] = [];
  let highestUid = sinceUid;
  let scanned = 0;

  await client.connect();
  const lock = await client.getMailboxLock(cfg.mailbox || "INBOX");
  try {
    const range = `${sinceUid + 1}:*`;
    for await (const msg of client.fetch(
      { uid: range },
      { uid: true, envelope: true, source: true }
    )) {
      if (msg.uid <= sinceUid) continue;
      highestUid = Math.max(highestUid, msg.uid);
      scanned++;
      if (reports.length >= max) break;

      const subject = msg.envelope?.subject ?? "";
      const from = msg.envelope?.from?.[0]?.address ?? "";
      if (cfg.subjectFilter && !subject.toLowerCase().includes(cfg.subjectFilter.toLowerCase())) continue;
      if (cfg.fromFilter && !from.toLowerCase().includes(cfg.fromFilter.toLowerCase())) continue;
      if (!msg.source) continue;

      const parsed = await simpleParser(msg.source);
      const pieces: string[] = [];
      let fileName: string | null = null;
      let note: string | undefined;

      for (const att of parsed.attachments ?? []) {
        const name = att.filename ?? "attachment";
        const isPdf =
          att.contentType === "application/pdf" || /\.pdf$/i.test(name);
        if (isPdf) {
          try {
            const out = await pdfToText(new Uint8Array(att.content));
            if (out.hasTextLayer) {
              pieces.push(out.text);
              fileName = name;
            } else {
              note = `${name} is a scanned image with no text layer, so nothing could be read from it.`;
            }
          } catch (e) {
            note = `${name} could not be read: ${(e as Error).message}`;
          }
        } else if (/\.(csv|tsv|txt|htm|html)$/i.test(name)) {
          pieces.push(att.content.toString("utf8"));
          fileName = fileName ?? name;
        }
      }

      // Fall back to the message body when there is no usable attachment.
      if (pieces.length === 0) {
        const body = parsed.text ?? parsed.html ?? "";
        if (body) pieces.push(typeof body === "string" ? body : String(body));
      }
      const text = pieces.join("\n\n").trim();
      if (!text) continue;

      reports.push({
        uid: msg.uid,
        messageId: parsed.messageId ?? null,
        subject,
        from,
        date: parsed.date ? parsed.date.toISOString().slice(0, 10) : null,
        fileName,
        text,
        note,
      });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return { reports, highestUid, scanned };
}
