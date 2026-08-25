import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import SiteNav from "@/components/SiteNav";

export const dynamic = "force-dynamic";

// A demo a stranger can open without an account.
//
// It draws on a real market — the prices are the ones the meta-search
// publishes, which are public either way — but it is deliberately read-only
// and carries no manager's-report data. A night audit is a hotel's internal
// operating record; putting a real one behind a public URL to sell software
// would be indefensible, so this shows the rate side and says plainly that
// the reporting side is only visible on your own account.

interface DemoCell {
  hotel: string;
  prices: (number | null)[];
}

interface DemoPayload {
  market: string;
  capturedAt: string | null;
  dates: string[];
  rows: DemoCell[];
  medians: (number | null)[];
  note?: string;
  error?: string;
}

async function loadDemo(): Promise<DemoPayload | null> {
  try {
    const base = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";
    const res = await fetch(`${base}/api/demo/grid`, { next: { revalidate: 900 } });
    if (!res.ok) return null;
    return (await res.json()) as DemoPayload;
  } catch {
    return null;
  }
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    timeZone: "UTC",
  });
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

        {!demo || demo.error || demo.rows.length === 0 ? (
          <div className="card p-8">
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              {demo?.error ??
                demo?.note ??
                "The demo market has no rates collected yet. Create an account and the first pull runs immediately."}
            </p>
          </div>
        ) : (
          <>
            <div className="card overflow-hidden">
              <div
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <span className="kicker">{demo.market}</span>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {demo.rows.length} hotels · next {demo.dates.length} nights
                </span>
                {demo.capturedAt && (
                  <span className="ml-auto text-xs" style={{ color: "var(--text-muted)" }}>
                    updated {new Date(demo.capturedAt).toLocaleString()}
                  </span>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr>
                      <th
                        className="th-label sticky left-0 z-10 px-5 py-2.5 text-left"
                        style={{ background: "var(--surface)" }}
                      >
                        Hotel
                      </th>
                      {demo.dates.map((d) => (
                        <th key={d} className="th-label px-4 py-2.5 text-right whitespace-nowrap">
                          {dayLabel(d)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {demo.rows.map((r) => (
                      <tr key={r.hotel} style={{ borderTop: "1px solid var(--gridline)" }}>
                        <td
                          className="sticky left-0 z-10 max-w-[240px] truncate px-5 py-2.5"
                          style={{ background: "var(--surface)", color: "var(--text-secondary)" }}
                          title={r.hotel}
                        >
                          {r.hotel}
                        </td>
                        {r.prices.map((p, i) => {
                          const med = demo.medians[i];
                          const delta = p != null && med ? ((p - med) / med) * 100 : null;
                          const tone =
                            delta == null
                              ? "var(--text-muted)"
                              : delta <= -5
                                ? "var(--div-low)"
                                : delta >= 5
                                  ? "var(--div-high)"
                                  : "var(--text-secondary)";
                          return (
                            <td
                              key={i}
                              className="px-4 py-2.5 text-right tabular-nums"
                              style={{ color: tone }}
                              title={
                                delta == null
                                  ? "no rate captured"
                                  : `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% vs median`
                              }
                            >
                              {p == null ? "—" : `$${Math.round(p)}`}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    <tr style={{ borderTop: "1px solid var(--border)" }}>
                      <td
                        className="sticky left-0 z-10 px-5 py-2.5 font-semibold"
                        style={{ background: "var(--surface)", color: "var(--text-primary)" }}
                      >
                        Market median
                      </td>
                      {demo.medians.map((m, i) => (
                        <td
                          key={i}
                          className="px-4 py-2.5 text-right font-semibold tabular-nums"
                          style={{ color: "var(--text-primary)" }}
                        >
                          {m == null ? "—" : `$${Math.round(m)}`}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--text-secondary)" }}>
              <span>Colour = price against the market median:</span>
              {[
                ["var(--div-low)", "cheaper"],
                ["var(--text-secondary)", "at market"],
                ["var(--div-high)", "pricier"],
              ].map(([c, label]) => (
                <span key={label} className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />
                  {label}
                </span>
              ))}
            </div>
          </>
        )}

        <div className="card mt-8 p-6">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            What the demo leaves out
          </h2>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            Published competitor rates are public, so showing them here costs
            nobody anything. Your night-audit figures are not — occupancy, ADR,
            cash variance and the rest are a hotel&rsquo;s internal operating
            record. The manager&rsquo;s-report reader, the fifteen checks and the
            conditions map are only ever visible inside your own account.
          </p>
          <Link href="/signup" className="btn-accent mt-5 inline-block px-5 py-2.5 text-[14px] no-underline">
            Create an account
          </Link>
        </div>
      </main>
    </div>
  );
}
