/**
 * Rate Beacon — Cloudflare Email Worker
 *
 * Where it sits in the pipeline:
 *
 *   PMS night audit  →  email to <alias>@reports.yourdomain.com
 *                         │
 *                         ▼
 *   Cloudflare Email Routing  →  THIS WORKER
 *                         │  (parse MIME, pull PDF/CSV attachments)
 *                         ▼
 *   POST /api/ingest-report on Vercel   (HMAC-signed)
 *                         │
 *                         ▼
 *   Gemini extraction → analysis engine → Supabase
 *
 * Cloudflare Email Routing and Workers are both on the free plan. The Worker
 * does no parsing of hotel *data* — it only unpacks the envelope and hands the
 * bytes on. Anything that needs to change when a PMS changes its layout lives
 * on the Vercel side, so this rarely needs redeploying.
 *
 * Deploy:
 *   cd workers/email-ingest
 *   npm install
 *   npx wrangler secret put INGEST_SECRET
 *   npx wrangler deploy
 * Then in the Cloudflare dashboard: Email → Email Routing → Routing rules →
 * "Send to a Worker" → rate-beacon-email-ingest, with a catch-all rule on the
 * reports.<yourdomain> subdomain so every hotel alias reaches this Worker.
 */

import PostalMime, { type Attachment, type Email } from "postal-mime";

export interface Env {
  /** Absolute URL of the Vercel webhook, e.g. https://ratebeacon.vercel.app/api/ingest-report */
  INGEST_URL: string;
  /** Shared secret, identical to INGEST_SECRET on Vercel. Set with `wrangler secret put`. */
  INGEST_SECRET: string;
  /** Optional comma-separated allow-list of sender domains, e.g. "ihg.com,hilton.com". */
  ALLOWED_SENDER_DOMAINS?: string;
  /** Optional address to bounce unrecognised mail to instead of silently dropping it. */
  FORWARD_UNMATCHED_TO?: string;
}

/** What Cloudflare hands the `email` handler. Typed here so the Worker needs no extra @types. */
interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

/** Attachment types a manager's report actually arrives as. */
const ACCEPTED = [
  { ext: ".pdf", mime: "application/pdf" },
  { ext: ".csv", mime: "text/csv" },
  { ext: ".txt", mime: "text/plain" },
  { ext: ".xls", mime: "application/vnd.ms-excel" },
  { ext: ".xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
];

/** 18 MB of base64 is roughly Vercel's request ceiling; night-audit PDFs are far smaller. */
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

export default {
  async email(message: EmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.INGEST_URL || !env.INGEST_SECRET) {
      // Rejecting rather than dropping means the sender gets a bounce and the
      // report is not silently lost while the Worker is misconfigured.
      message.setReject("Rate Beacon ingest is not configured");
      return;
    }

    if (!senderAllowed(message.from, env.ALLOWED_SENDER_DOMAINS)) {
      message.setReject("Sender not permitted to submit reports");
      return;
    }

    const alias = normaliseAlias(message.to);
    const raw = await streamToUint8(message.raw, message.rawSize);

    let parsed: Email;
    try {
      parsed = await PostalMime.parse(raw);
    } catch (err) {
      message.setReject(`Could not parse message: ${errText(err)}`);
      return;
    }

    const files = pickAttachments(parsed.attachments ?? []);
    const bodyText = (parsed.text ?? "").trim();
    const bodyHtml = (parsed.html ?? "").trim();

    // Some PMS setups mail the flash report in the body rather than attaching
    // it. That is still a usable report, so it is forwarded as a text payload.
    if (files.length === 0 && !bodyText && !bodyHtml) {
      if (env.FORWARD_UNMATCHED_TO) {
        await message.forward(env.FORWARD_UNMATCHED_TO);
        return;
      }
      message.setReject("No report attachment or body found");
      return;
    }

    const payload = {
      alias,
      from: parsed.from?.address ?? message.from,
      to: message.to,
      subject: parsed.subject ?? "",
      messageId: parsed.messageId ?? message.headers.get("message-id") ?? "",
      receivedAt: new Date().toISOString(),
      bodyText: bodyText.slice(0, 200_000),
      bodyHtml: bodyHtml.slice(0, 200_000),
      attachments: files,
    };

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await sign(`${timestamp}.${body}`, env.INGEST_SECRET);

    // waitUntil keeps the SMTP transaction short: Cloudflare accepts the mail
    // and the POST finishes in the background. A failure is retried once,
    // because a dropped night-audit report is a gap nobody notices until the
    // month-end numbers are wrong.
    ctx.waitUntil(
      postWithRetry(env.INGEST_URL, body, {
        "Content-Type": "application/json",
        "X-RateBeacon-Timestamp": timestamp,
        "X-RateBeacon-Signature": `sha256=${signature}`,
      })
    );
  },
} satisfies ExportedHandler<Env>;

// ── helpers ───────────────────────────────────────────────────────────────

/** "Hotel123@Reports.Example.com" → "hotel123". Sub-addressing (+tag) is kept. */
function normaliseAlias(to: string): string {
  const addr = (to.match(/<([^>]+)>/)?.[1] ?? to).trim().toLowerCase();
  return addr.split("@")[0] ?? addr;
}

function senderAllowed(from: string, allowList?: string): boolean {
  const list = (allowList ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return true; // unset means "accept anyone"
  const domain = from.split("@").pop()?.toLowerCase() ?? "";
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

async function streamToUint8(stream: ReadableStream<Uint8Array>, hint: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(hint > 0 ? Math.max(hint, total) : total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.subarray(0, total);
}

interface OutboundAttachment {
  filename: string;
  mimeType: string;
  size: number;
  /** Standard base64, no data: prefix. */
  contentBase64: string;
}

function pickAttachments(attachments: Attachment[]): OutboundAttachment[] {
  const out: OutboundAttachment[] = [];
  for (const att of attachments) {
    const filename = att.filename ?? "report";
    const mime = (att.mimeType ?? "").toLowerCase();
    const lower = filename.toLowerCase();
    const wanted = ACCEPTED.some((a) => lower.endsWith(a.ext) || mime === a.mime);
    if (!wanted) continue;

    const bytes =
      att.content instanceof ArrayBuffer
        ? new Uint8Array(att.content)
        : typeof att.content === "string"
          ? new TextEncoder().encode(att.content)
          : new Uint8Array(att.content as ArrayBufferLike);

    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;

    out.push({
      filename,
      mimeType: mime || guessMime(lower),
      size: bytes.byteLength,
      contentBase64: toBase64(bytes),
    });
  }
  return out;
}

function guessMime(lowerName: string): string {
  return ACCEPTED.find((a) => lowerName.endsWith(a.ext))?.mime ?? "application/octet-stream";
}

/** btoa in chunks — a single call on a multi-MB string blows the argument limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function postWithRetry(url: string, body: string, headers: Record<string, string>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers, body });
      if (res.ok) return;
      // 4xx other than 429 means the payload itself is wrong; retrying will
      // not help and would just re-post a report the API already refused.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.error(`ingest rejected ${res.status}: ${(await res.text()).slice(0, 500)}`);
        return;
      }
    } catch (err) {
      console.error(`ingest attempt ${attempt + 1} failed: ${errText(err)}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  console.error("ingest failed after 3 attempts");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
