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
  try {
    serviceClient = createClient(url, key, { auth: { persistSession: false } });
  } catch (e) {
    throw new Error(
      `Supabase client rejected SUPABASE_URL "${url}" — it should look like https://<project-ref>.supabase.co (${(e as Error).message})`
    );
  }
  return serviceClient;
}

/** Whether database-enforced isolation is configured on this deployment. */
export function tenantIsolationReady(): boolean {
  return Boolean(
    cleanValue(process.env.SUPABASE_JWT_SECRET ?? "") &&
      cleanValue(process.env.SUPABASE_ANON_KEY ?? "")
  );
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
