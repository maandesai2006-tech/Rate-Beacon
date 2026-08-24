import { Suspense } from "react";
import Link from "next/link";
import AuthForm from "@/components/AuthForm";

export const dynamic = "force-dynamic";

export default function SignupPage() {
  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-6 p-6"
      style={{ background: "var(--page)" }}
    >
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

      <Suspense fallback={null}>
        <AuthForm mode="signup" />
      </Suspense>

      <Link href="/demo" className="text-xs no-underline" style={{ color: "var(--text-muted)" }}>
        Just looking? See the live demo
      </Link>
    </main>
  );
}
