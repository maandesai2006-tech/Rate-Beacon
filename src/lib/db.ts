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
//                        an access token carrying the account id, so Postgres
//                        refuses rows belonging to anyone else.
//
// The difference matters because the previous arrangement relied on every
// route remembering to filter by account_id. That holds until one route
// forgets, and then one hotel reads another's data. Under the scoped client a
// forgotten filter returns nothing instead.
//
// The token is minted by Supabase rather than signed here. Signing our own
// HS256 token worked only on projects that still verify with a shared secret;
// projects on the newer asymmetric signing keys reject it with "No suitable
// key or wrong key type", and the private half of those keys is never exposed,
// so no configuration could have fixed it. Instead each account has a Supabase
// auth user whose app_metadata carries the account id — writable only by the
// service role — and the app signs in as that user to obtain a token the
// project itself issued. That works under either key system and survives a
// rotation, and the app holds no signing key at all.

let serviceClient: SupabaseClient | null = null;

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<number, CachedToken>();
const scopedClients = new Map<string, SupabaseClient>();

// Why isolation is not in force right now, if it is not. Set at the point of
// failure so the system check can report the real reason instead of guessing.
let runtimeProblem: string | null = null;

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
  // A value copied from the dashboard's hidden display cannot go in a header,
  // and the raw failure ("Cannot convert argument to a ByteString") points at
  // nothing.
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
 * Judge the isolation configuration before it is ever used.
 *
 * A key copied out of the Supabase dashboard's masked display carries bullet
 * characters, which are not valid in an HTTP header — and that surfaced as
 * "Cannot convert argument to a ByteString" on the login request, which tells
 * nobody anything. Anything that cannot go in a header is rejected here
 * instead, the deployment falls back to the service key, and the reason is
 * reported by the system check. A pasted-wrong environment variable should
 * cost isolation, never the ability to sign in.
 *
 * Exported and pure so it can be tested without a database.
 */
export function describeTenantConfig(rawAnon: string, rawAppSecret: string): TenantConfig {
  const anon = cleanValue(rawAnon);
  const appSecret = cleanValue(rawAppSecret);

  if (!anon) {
    return {
      ready: false,
      problem:
        "SUPABASE_ANON_KEY is not set, so the app connects with the service key and row-level security is bypassed.",
    };
  }

  // Header values must be single-byte. Bullets, curly quotes and non-breaking
  // spaces all come from copying a rendered page rather than the value.
  const bad = [...anon].find((ch) => ch.charCodeAt(0) > 255 || ch.charCodeAt(0) < 0x20);
  if (bad) {
    const label =
      bad === "•"
        ? "a bullet (•)"
        : `"${bad}" (U+${bad.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")})`;
    return {
      ready: false,
      problem: `SUPABASE_ANON_KEY contains ${label}, so it is the dashboard's masked display rather than the key itself. Reveal it in Supabase → Project Settings → API and copy the whole value.`,
    };
  }
  if (/\s/.test(anon)) {
    return {
      ready: false,
      problem: "SUPABASE_ANON_KEY contains a space or line break — it was copied with wrapping.",
    };
  }

  const looksLikeJwt = anon.split(".").length === 3 && anon.startsWith("ey");
  const looksLikePublishable = /^sb_publishable_/.test(anon);
  if (!looksLikeJwt && !looksLikePublishable) {
    return {
      ready: false,
      problem:
        'SUPABASE_ANON_KEY does not look like a Supabase key — it should be a three-part JWT starting with "ey", or start with "sb_publishable_".',
    };
  }

  if (!appSecret || appSecret.length < 16) {
    return {
      ready: false,
      problem:
        "APP_SECRET is not set (or is too short). It derives each account's Supabase credentials, so isolation cannot be established without it.",
    };
  }

  return { ready: true, problem: null };
}

/** The isolation configuration of this deployment, judged from the environment. */
export function tenantConfig(): TenantConfig {
  const config = describeTenantConfig(
    process.env.SUPABASE_ANON_KEY ?? "",
    process.env.APP_SECRET ?? ""
  );
  // A configuration that looks right but failed in practice is worse news than
  // one that is missing, so the runtime failure wins the report.
  if (config.ready && runtimeProblem) return { ready: false, problem: runtimeProblem };
  return config;
}

/** Whether database-enforced isolation is configured on this deployment. */
export function tenantIsolationReady(): boolean {
  return tenantConfig().ready;
}

function anonClient(): SupabaseClient {
  return createClient(supabaseUrl(), cleanValue(process.env.SUPABASE_ANON_KEY ?? ""), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// The account's Supabase identity. Both values are derived rather than stored:
// the address is never mailed and the password never leaves the server, so the
// only secret involved is APP_SECRET, which already guards stored credentials.
function accountEmail(accountId: number): string {
  return `account-${accountId}@accounts.rate-beacon.app`;
}

function accountPassword(accountId: number): string {
  const secret = cleanValue(process.env.APP_SECRET ?? "");
  const digest = createHmac("sha256", secret).update(`supabase-auth:${accountId}`).digest("base64url");
  // Suffixed so it satisfies any password policy the project has enabled.
  return `${digest}Aa1!`;
}

/**
 * The auth user backing an account, created on first use.
 *
 * Adopts an existing user when one is already registered for the address —
 * which happens when the accounts row was reset, or when a deployment was
 * restored from a backup — rather than failing on the duplicate.
 */
async function ensureAuthUser(accountId: number): Promise<string | null> {
  const admin = db();
  const email = accountEmail(accountId);
  const password = accountPassword(accountId);
  const app_metadata = { account_id: String(accountId) };

  const { data: row } = await admin
    .from("accounts")
    .select("id, auth_user_id")
    .eq("id", accountId)
    .maybeSingle<{ id: number; auth_user_id: string | null }>();
  // No account, no identity: this guards against a caller (a health probe, a
  // stale session) conjuring auth users for ids that do not exist.
  if (!row) {
    runtimeProblem = `No account ${accountId} exists, so no scoped connection was made.`;
    return null;
  }
  if (row.auth_user_id) return row.auth_user_id;

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata,
  });

  let userId = created.data?.user?.id ?? null;

  if (!userId) {
    const message = created.error?.message ?? "";
    if (!/already|registered|exists/i.test(message)) {
      runtimeProblem = `Could not create the Supabase user backing this account: ${message}`;
      return null;
    }
    // Already registered: find it, then bring it back in line with what this
    // deployment expects.
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    userId = link.data?.user?.id ?? null;
    if (!userId) {
      runtimeProblem = `A Supabase user already exists for this account but could not be read: ${link.error?.message ?? "no user returned"}`;
      return null;
    }
    await admin.auth.admin.updateUserById(userId, { password, app_metadata });
  }

  await admin.from("accounts").update({ auth_user_id: userId }).eq("id", accountId);
  return userId;
}

/** A Supabase-issued access token for one account, cached until it nears expiry. */
async function accessTokenFor(accountId: number): Promise<string | null> {
  const cached = tokenCache.get(accountId);
  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;

  const userId = await ensureAuthUser(accountId);
  if (!userId) return null;

  const email = accountEmail(accountId);
  const password = accountPassword(accountId);
  const anon = anonClient();

  let signIn = await anon.auth.signInWithPassword({ email, password });

  // APP_SECRET may have been rotated since the user was created, which changes
  // the derived password. Reset it once rather than locking the account out.
  if (signIn.error) {
    await db().auth.admin.updateUserById(userId, {
      password,
      app_metadata: { account_id: String(accountId) },
    });
    signIn = await anon.auth.signInWithPassword({ email, password });
  }

  const session = signIn.data?.session;
  if (!session?.access_token) {
    runtimeProblem = `Supabase would not issue a token for this account: ${signIn.error?.message ?? "no session returned"}`;
    return null;
  }

  const expiresAt = session.expires_at ? session.expires_at * 1000 : Date.now() + 55 * 60_000;
  tokenCache.set(accountId, { token: session.access_token, expiresAt });
  if (tokenCache.size > 500) tokenCache.delete(tokenCache.keys().next().value as number);
  runtimeProblem = null;
  return session.access_token;
}

/**
 * A client that can only see one account's rows.
 *
 * Falls back to the service client when a token cannot be obtained, so the app
 * keeps working on a deployment that has not been switched over yet, or one
 * where the keys are wrong. That fallback is the old behaviour — safe only
 * because the routes still carry their own filters — and it is reported by
 * tenantConfig() so the system check can say plainly which mode is live.
 */
export async function dbForAccount(accountId: number): Promise<SupabaseClient> {
  if (!describeTenantConfig(process.env.SUPABASE_ANON_KEY ?? "", process.env.APP_SECRET ?? "").ready) {
    return db();
  }

  let token: string | null = null;
  try {
    token = await accessTokenFor(accountId);
  } catch (e) {
    runtimeProblem = `Could not establish a scoped connection: ${(e as Error).message}`;
  }
  if (!token) return db();

  const cached = scopedClients.get(token);
  if (cached) return cached;

  const client = createClient(supabaseUrl(), cleanValue(process.env.SUPABASE_ANON_KEY ?? ""), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  // Keyed by token, so a refreshed token makes a new client and the old one
  // falls out rather than presenting an expired credential.
  scopedClients.set(token, client);
  if (scopedClients.size > 200) {
    const oldest = scopedClients.keys().next().value;
    if (oldest !== undefined) scopedClients.delete(oldest);
  }

  return client;
}
