// Account authentication. Passwords are hashed with PBKDF2-SHA256 (210k
// iterations) and a random per-user salt via Web Crypto, so the same code
// runs in Node route handlers and Edge middleware. Sessions are opaque
// random tokens stored server-side and referenced by an httpOnly cookie.

import { SupabaseClient } from "@supabase/supabase-js";

export const SESSION_COOKIE = "rb_session";
const ITERATIONS = 210_000;
const SESSION_DAYS = 30;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    key,
    256
  );
  return toHex(bits);
}

// Constant-time comparison so a wrong password can't be timed out character
// by character.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface Account {
  id: number;
  email: string | null;
  username: string | null;
  password_hash: string;
  password_salt: string;
}

// An identifier is either an email address or a username.
function looksLikeEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

export async function createAccount(
  supa: SupabaseClient,
  identifier: string,
  password: string
): Promise<{ account?: { id: number; label: string }; error?: string }> {
  const clean = identifier.trim();
  if (clean.length < 3) return { error: "Enter an email address or a username" };
  const isEmail = looksLikeEmail(clean);
  if (!isEmail && !/^[a-zA-Z0-9._-]{3,32}$/.test(clean)) {
    return { error: "Usernames may use letters, numbers, dots, dashes and underscores" };
  }
  if (password.length < 5) return { error: "Use a password of at least 5 characters" };

  const salt = randomToken(16);
  const hash = await hashPassword(password, salt);
  const row: {
    email: string | null;
    username: string | null;
    password_hash: string;
    password_salt: string;
  } = {
    email: isEmail ? clean.toLowerCase() : null,
    username: isEmail ? null : clean,
    password_hash: hash,
    password_salt: salt,
  };
  const { data, error } = await supa
    .from("accounts")
    .insert(row)
    .select("id, email, username")
    .single<{ id: number; email: string | null; username: string | null }>();
  if (error) {
    if (error.code === "23505") return { error: "That account already exists" };
    return { error: error.message };
  }
  return { account: { id: data.id, label: data.username ?? data.email ?? clean } };
}

export async function verifyLogin(
  supa: SupabaseClient,
  identifier: string,
  password: string
): Promise<{ accountId?: number; error?: string }> {
  const clean = identifier.trim();
  // Match on email or username, both case-insensitively.
  const { data: candidates } = await supa
    .from("accounts")
    .select("id, email, username, password_hash, password_salt")
    .or(`email.ilike.${clean},username.ilike.${clean}`)
    .limit(1)
    .returns<Account[]>();
  const account = candidates?.[0];
  if (!account) return { error: "Username or password is incorrect" };
  const hash = await hashPassword(password, account.password_salt);
  if (!safeEqual(hash, account.password_hash)) {
    return { error: "Username or password is incorrect" };
  }
  await supa
    .from("accounts")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", account.id);
  return { accountId: account.id };
}

export async function startSession(
  supa: SupabaseClient,
  accountId: number
): Promise<string> {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await supa.from("sessions").insert({ token, account_id: accountId, expires_at: expires });
  return token;
}

export async function accountForSession(
  supa: SupabaseClient,
  token: string | undefined
): Promise<number | null> {
  if (!token) return null;
  const { data } = await supa
    .from("sessions")
    .select("account_id, expires_at")
    .eq("token", token)
    .maybeSingle<{ account_id: number; expires_at: string }>();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) {
    await supa.from("sessions").delete().eq("token", token);
    return null;
  }
  return data.account_id;
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86400;
