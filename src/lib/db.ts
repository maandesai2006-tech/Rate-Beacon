import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";

// Two clients, on purpose.
//
//   db()                 the service role. Bypasses row-level security, so it
//                        is for work that legitimately spans tenants: the
//                        nightly rate collection, the shared hotel directory,
//                        signing in (which happens before an account is known).
//
//   dbForAccount(id)     scoped to one account. Connects with the anon key and
//                        a signed token carrying the account id, so Postgres
//                        refuses rows belonging to anyone else.
//
// The difference matters because the previous arrangement relied on every
// route remembering to filter by account_id. That holds until one route
// forgets, and then one hotel reads another's data. Under the scoped client a
// forgotten filter returns nothing instead.

let serviceClient: SupabaseClient | null = null;
const scopedClients = new Map<number, SupabaseClient>();

// Forgive the common copy-paste mishaps in env values: surrounding quotes,
// stray whitespace/newlines, a trailing slash or /rest/v1 suffix on the URL,
// and a missing https:// prefix.
function cleanValue(raw: string): string {
  return raw.trim().replace(/^['"]+|['"]+$/g, "").trim();
}

function cleanUrl(raw: string): string {
  let v = cleanValue(raw);
  v = v.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "").replace(/\/+$/, "");
  if (v && !/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v;
}

function supabaseUrl(): string {
  const url = cleanUrl(process.env.SUPABASE_URL ?? "");
  if (!url) throw new Error("SUPABASE_URL is not set. See .env.example.");
  return url;
}

export function db(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const url = supabaseUrl();
  const key = cleanValue(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set. See .env.example.");
  }
  // Same trap as the anon key: a value copied from the dashboard's masked
  // display cannot go in a header, and the raw failure is unreadable.
  if ([...key].some((ch) => ch.charCodeAt(0) > 255)) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY contains characters that cannot go in a request header (usually • from the dashboard's hidden display). Reveal the key in Project Settings → API and copy the whole value."
    );
  }
  try {
    serviceClient = createClient(url, key, { auth: { persistSession: false } });
  } catch (e) {
    throw new Error(
      `Supabase client rejected SUPABASE_URL "${url}" — it should look like https://<project-ref>.supabase.co (${(e as Error).message})`
    );
  }
  return serviceClient;
}

export interface TenantConfig {
  ready: boolean;
  /** Plain-English reason it is not ready, or null when it is. */
  problem: string | null;
}

/**
 * Judge the two isolation values before they are ever used.
 *
 * A key copied out of the Supabase dashboard's masked display carries bullet
 * characters, which are not valid in an HTTP header — and the failure surfaced
 * as "Cannot convert argument to a ByteString" on the login request, which
 * tells nobody anything. Anything that cannot go in a header is rejected here
 * instead, the deployment falls back to the service key, and the reason is
 * reported by the system check. A pasted-wrong environment variable should
 * cost isolation, never the ability to sign in.
 *
 * Exported and pure so it can be tested without a database.
 */
export function describeTenantConfig(rawAnon: string, rawSecret: string): TenantConfig {
  const anon = cleanValue(rawAnon);
  const secret = cleanValue(rawSecret);

  if (!anon && !secret) {
    return {
      ready: false,
      problem:
        "SUPABASE_ANON_KEY and SUPABASE_JWT_SECRET are not set, so the app connects with the service key and row-level security is bypassed.",
    };
  }
  if (!anon) return { ready: false, problem: "SUPABASE_ANON_KEY is not set." };
  if (!secret) return { ready: false, problem: "SUPABASE_JWT_SECRET is not set." };

  // Header values must be single-byte. Bullets, curly quotes and non-breaking
  // spaces all come from copying a rendered page rather than the value.
  const bad = [...anon].find((ch) => ch.charCodeAt(0) > 255 || ch.charCodeAt(0) < 0x20);
  if (bad) {
    const label = bad === "\u2022" ? "a bullet (•)" : `"${bad}" (U+${bad.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")})`;
    return {
      ready: false,
      problem: `SUPABASE_ANON_KEY contains ${label}, so it is the dashboard's masked display rather than the key itself. Reveal it in Supabase → Project Settings → API and copy the whole value.`,
    };
  }
  if (/\s/.test(anon)) {
    return { ready: false, problem: "SUPABASE_ANON_KEY contains a space or line break — it was copied with wrapping." };
  }

  const looksLikeJwt = anon.split(".").length === 3 && anon.startsWith("ey");
  const looksLikePublishable = /^sb_publishable_/.test(anon);
  if (!looksLikeJwt && !looksLikePublishable) {
    return {
      ready: false,
      problem:
        "SUPABASE_ANON_KEY does not look like a Supabase key — it should be a three-part JWT starting with \"ey\", or start with \"sb_publishable_\".",
    };
  }
  if (looksLikePublishable) {
    // The scoped client authenticates with a token this app signs using the
    // project's legacy JWT secret; a publishable key belongs to the newer
    // system and will not verify against it.
    return {
      ready: false,
      problem:
        "SUPABASE_ANON_KEY is a publishable key (sb_publishable_…). Use the legacy anon key from Project Settings → API → Project API keys, which is what the JWT secret signs against.",
    };
  }

  if (secret.length < 24 || [...secret].some((ch) => ch.charCodeAt(0) > 255)) {
    return {
      ready: false,
      problem:
        "SUPABASE_JWT_SECRET does not look like the project's JWT secret — reveal it in Project Settings → API → JWT Settings and copy the whole value.",
    };
  }

  return { ready: true, problem: null };
}

/** The isolation configuration of this deployment, judged from the environment. */
export function tenantConfig(): TenantConfig {
  return describeTenantConfig(
    process.env.SUPABASE_ANON_KEY ?? "",
    process.env.SUPABASE_JWT_SECRET ?? ""
  );
}

/** Whether database-enforced isolation is configured on this deployment. */
export function tenantIsolationReady(): boolean {
  return tenantConfig().ready;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A short-lived HS256 token carrying the account id.
 *
 * PostgREST verifies the signature and exposes the payload as
 * request.jwt.claims, which is what the RLS policies read. The token never
 * leaves the server and lives about an hour, so a leaked one is worth little.
 */
function accountToken(accountId: number): string {
  const secret = cleanValue(process.env.SUPABASE_JWT_SECRET ?? "");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      role: "authenticated",
      account_id: String(accountId),
      iat: now,
      exp: now + 3600,
    })
  );
  const signature = base64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}

/**
 * A client that can only see one account's rows.
 *
 * Falls back to the service client when the JWT secret is not configured, so
 * the app keeps working on a deployment that has not been switched over yet.
 * The fallback is the old behaviour — safe only because the routes still carry
 * their own filters — and it is reported by tenantIsolationReady() so the
 * system check can say plainly which mode is live.
 */
export function dbForAccount(accountId: number): SupabaseClient {
  if (!tenantIsolationReady()) return db();

  const cached = scopedClients.get(accountId);
  if (cached) return cached;

  const client = createClient(supabaseUrl(), cleanValue(process.env.SUPABASE_ANON_KEY ?? ""), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accountToken(accountId)}` } },
  });

  // Tokens expire after an hour; a cached client would keep presenting a dead
  // one. Keeping the cache small and short-lived is simpler than refreshing.
  scopedClients.set(accountId, client);
  if (scopedClients.size > 200) {
    const oldest = scopedClients.keys().next().value;
    if (oldest !== undefined) scopedClients.delete(oldest);
  }
  setTimeout(() => scopedClients.delete(accountId), 45 * 60_000).unref?.();

  return client;
}
