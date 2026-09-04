import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import SiteNav from "@/components/SiteNav";
import { buildDemoGrid, type DemoGrid as DemoGridData } from "@/lib/demo";
import DemoGrid from "@/components/DemoGrid";

export const dynamic = "force-dynamic";

// A demo a stranger can open without an account.
//
// It draws on a real market — the prices are the ones the meta-search
// publishes, which are public either way — but it is deliberately read-only
// and carries no manager's-report data. A night audit is a hotel's internal
// operating record; putting a real one behind a public URL to sell software
// would be indefensible, so this shows the rate side and says plainly that
// the reporting side is only visible on your own account.

// Read straight from the database. The previous version fetched this page's
// own API over HTTP and turned any failure into "no data" — see lib/demo.ts.
async function loadDemo(): Promise<DemoGridData> {
  return buildDemoGrid();
}


export default async function DemoPage() {
  const signedIn = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
  const demo = await loadDemo();

  return (
    <div style={{ background: "var(--page)", minHeight: "100vh" }}>
      <SiteNav signedIn={signedIn} />

      <main className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-8 max-w-2xl">
          <span className="kicker">Live demo</span>
          <h1
            className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
          >
            A real market, live
          </h1>
          <p className="mt-3 text-base leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            These are the prices this compset is publishing right now, collected by
            the same daily job that runs on a paid account. Read-only, no sign-in.
          </p>
        </div>

        <DemoGrid demo={demo} />
      </main>
    </div>
  );
}
