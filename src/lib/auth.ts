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
  email: string;
  password_hash: string;
  password_salt: string;
}

export async function createAccount(
  supa: SupabaseClient,
  email: string,
  password: string
): Promise<{ account?: { id: number; email: string }; error?: string }> {
  const clean = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return { error: "Enter a valid email address" };
  if (password.length < 8) return { error: "Use a password of at least 8 characters" };

  const salt = randomToken(16);
  const hash = await hashPassword(password, salt);
  const { data, error } = await supa
    .from("accounts")
    .insert({ email: clean, password_hash: hash, password_salt: salt })
    .select("id, email")
    .single<{ id: number; email: string }>();
  if (error) {
    if (error.code === "23505") return { error: "That email already has an account" };
    return { error: error.message };
  }
  return { account: data };
}

export async function verifyLogin(
  supa: SupabaseClient,
  email: string,
  password: string
): Promise<{ accountId?: number; error?: string }> {
  const clean = email.trim().toLowerCase();
  const { data: account } = await supa
    .from("accounts")
    .select("id, email, password_hash, password_salt")
    .eq("email", clean)
    .maybeSingle<Account>();
  if (!account) return { error: "Email or password is incorrect" };
  const hash = await hashPassword(password, account.password_salt);
  if (!safeEqual(hash, account.password_hash)) {
    return { error: "Email or password is incorrect" };
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
