"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Sign in and sign up share a form but not a page.
 *
 * They used to be one page with a mode toggle behind a small underlined link,
 * and people who meant to sign in ended up creating accounts instead. Two
 * routes, each with the other clearly offered, removes the ambiguity.
 */
export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/app";

  const signup = mode === "signup";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (signup && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    if (signup && password.length < 8) {
      setError("Use at least 8 characters. Short passwords are guessable in seconds.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password, propertyType: params.get("type") ?? undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Something went wrong");
      // A fresh account has no profile yet, so it goes straight to setup.
      window.location.href = signup ? "/setup" : next;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card w-full max-w-sm p-8">
      <h1
        className="text-2xl font-semibold tracking-tight"
        style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
      >
        {signup ? "Create your account" : "Welcome back"}
      </h1>
      <p className="mt-1.5 text-sm" style={{ color: "var(--text-secondary)" }}>
        {signup
          ? "A username is enough — an email is optional."
          : "Sign in with your username or email."}
      </p>

      <label className="mt-6 block text-xs" style={{ color: "var(--text-secondary)" }}>
        Username or email
        <input
          type="text"
          autoComplete="username"
          autoFocus
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className="input mt-1"
          required
        />
      </label>

      <label className="mt-3 block text-xs" style={{ color: "var(--text-secondary)" }}>
        Password
        <input
          type="password"
          autoComplete={signup ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input mt-1"
          required
        />
      </label>

      {signup && (
        <label className="mt-3 block text-xs" style={{ color: "var(--text-secondary)" }}>
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="input mt-1"
            required
          />
        </label>
      )}

      {error && (
        <p
          className="mt-3 rounded-lg px-3 py-2 text-sm"
          style={{
            color: "var(--status-critical)",
            background: "color-mix(in srgb, var(--status-critical) 8%, transparent)",
          }}
          role="alert"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !identifier || !password}
        className="btn-accent mt-5 w-full px-4 py-2.5"
      >
        {busy ? "Working…" : signup ? "Create account" : "Sign in"}
      </button>

      <p className="mt-5 text-center text-sm" style={{ color: "var(--text-secondary)" }}>
        {signup ? (
          <>
            Already have an account?{" "}
            <Link href="/login" style={{ color: "var(--accent)" }}>
              Sign in
            </Link>
          </>
        ) : (
          <>
            No account yet?{" "}
            <Link href="/signup" style={{ color: "var(--accent)" }}>
              Create one
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
