import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

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

export function db(): SupabaseClient {
  if (client) return client;
  const url = cleanUrl(process.env.SUPABASE_URL ?? "");
  const key = cleanValue(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. See .env.example."
    );
  }
  try {
    client = createClient(url, key, {
      auth: { persistSession: false },
    });
  } catch (e) {
    throw new Error(
      `Supabase client rejected SUPABASE_URL "${url}" — it should look like https://<project-ref>.supabase.co (${(e as Error).message})`
    );
  }
  return client;
}
