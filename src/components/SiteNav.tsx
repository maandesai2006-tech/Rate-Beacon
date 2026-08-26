"use client";

import Link from "next/link";

/**
 * The public header. Sign in and sign up are both always visible, because the
 * previous single page toggled between them behind a small underlined link and
 * people ended up creating accounts when they meant to sign in.
 */
export default function SiteNav({ signedIn }: { signedIn: boolean }) {
  return (
    <header
      className="sticky top-0 z-40"
      style={{
        background: "color-mix(in oklab, var(--page) 86%, transparent)",
        backdropFilter: "blur(10px)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3.5">
        <Link href="/" className="flex items-center gap-2.5 no-underline">
          <span
            aria-hidden
            className="inline-flex h-[30px] w-[30px] items-center justify-center"
            style={{ background: "var(--accent)", color: "var(--accent-ink)", borderRadius: 7 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M12 2l7 4v6c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z" />
              <path d="M12 8v5" />
              <circle cx="12" cy="16" r="0.6" fill="currentColor" />
            </svg>
          </span>
          <span
            className="text-[17px] font-semibold tracking-tight"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
          >
            Rate Beacon
          </span>
        </Link>

        <nav className="ml-6 hidden items-center gap-1 sm:flex">
          <Link
            href="/#how"
            className="rounded-lg px-3 py-1.5 text-[13px] no-underline"
            style={{ color: "var(--text-secondary)" }}
          >
            How it works
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {signedIn ? (
            <Link href="/app" className="btn-accent px-4 py-2 text-[13px] no-underline">
              Open dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="btn-ghost px-3.5 py-2 text-[13px] no-underline">
                Log in
              </Link>
              <Link href="/signup" className="btn-accent px-4 py-2 text-[13px] no-underline">
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
