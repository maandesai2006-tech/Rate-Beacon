// Reads manager's reports from a mailbox.
//
// The IMAP conversation happens in a Supabase Edge Function, not here:
// Vercel's serverless runtime cannot open raw TCP sockets, so a direct
// connection to port 993 always times out. That function speaks IMAP and
// returns raw MIME, which this module parses with the same libraries as
// before. Any IMAP host works, so the setup replicates for any operator.

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

interface EdgeResponse {
  ok: boolean;
  error?: string;
  total?: number;
  scanned?: number;
  returned?: number;
  highestUid?: number;
  messages?: { uid: number; raw: string }[];
}

async function callEdge(body: Record<string, unknown>): Promise<EdgeResponse> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  const res = await fetch(`${url}/functions/v1/mailbox-fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      apikey: key,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as EdgeResponse;
  if (!res.ok && !json.error) {
    throw new Error(`Mail reader returned ${res.status}`);
  }
  return json;
}

export async function testConnection(
  cfg: MailboxConfig
): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await callEdge({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password,
      mailbox: cfg.mailbox || "INBOX",
      probeOnly: true,
    });
    if (!r.ok) return { ok: false, detail: r.error ?? "Could not sign in" };
    return {
      ok: true,
      detail: `Connected. ${r.total ?? 0} message${r.total === 1 ? "" : "s"} in ${cfg.mailbox || "INBOX"}.`,
    };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Everything newer than `sinceUid`, with PDF (and other) attachments turned
// into text.
export async function fetchReports(
  cfg: MailboxConfig,
  sinceUid: number,
  max = 5
): Promise<{ reports: FetchedReport[]; highestUid: number; scanned: number }> {
  const r = await callEdge({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    password: cfg.password,
    mailbox: cfg.mailbox || "INBOX",
    sinceUid,
    max,
  });
  if (!r.ok) throw new Error(r.error ?? "Could not read the mailbox");

  const reports: FetchedReport[] = [];
  for (const m of r.messages ?? []) {
    const parsed = await simpleParser(Buffer.from(base64ToBytes(m.raw)));
    const subject = parsed.subject ?? "";
    const from = parsed.from?.value?.[0]?.address ?? "";
    if (cfg.subjectFilter && !subject.toLowerCase().includes(cfg.subjectFilter.toLowerCase())) continue;
    if (cfg.fromFilter && !from.toLowerCase().includes(cfg.fromFilter.toLowerCase())) continue;

    const pieces: string[] = [];
    let fileName: string | null = null;
    let note: string | undefined;

    for (const att of parsed.attachments ?? []) {
      const name = att.filename ?? "attachment";
      const isPdf = att.contentType === "application/pdf" || /\.pdf$/i.test(name);
      if (isPdf) {
        try {
          const out = await pdfToText(new Uint8Array(att.content));
          if (out.hasTextLayer) {
            pieces.push(out.text);
            fileName = name;
          } else {
            note = `${name} is a scan with no text layer, so nothing could be read from it.`;
          }
        } catch (e) {
          note = `${name} could not be read: ${(e as Error).message}`;
        }
      } else if (/\.(csv|tsv|txt|htm|html)$/i.test(name)) {
        pieces.push(att.content.toString("utf8"));
        fileName = fileName ?? name;
      }
    }

    if (pieces.length === 0) {
      const body = parsed.text ?? parsed.html ?? "";
      if (body) pieces.push(typeof body === "string" ? body : String(body));
    }
    const text = pieces.join("\n\n").trim();
    if (!text) continue;

    reports.push({
      uid: m.uid,
      messageId: parsed.messageId ?? null,
      subject,
      from,
      date: parsed.date ? parsed.date.toISOString().slice(0, 10) : null,
      fileName,
      text,
      note,
    });
  }

  return {
    reports,
    highestUid: r.highestUid ?? sinceUid,
    scanned: r.scanned ?? 0,
  };
}
