import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import SiteNav from "@/components/SiteNav";

export const dynamic = "force-dynamic";

// The public front door.
//
// A visitor decides whether this is worth an account in about fifteen seconds,
// and they decide it by seeing the product, not by reading about it. So the
// page leads with what the grid actually looks like and puts a live demo one
// click away — no form in front of it.

const FEATURES = [
  {
    title: "Competitor rates, every night",
    body:
      "Your compset's published prices for the next month, refreshed daily. See who moved, by how much, and where you sit against the market median.",
  },
  {
    title: "Your direct rate, not the cheapest OTA",
    body:
      "Brand.com pricing is read separately from the OTA listings, so parity gaps show up as what they are — an OTA undercutting you — instead of being averaged away.",
  },
  {
    title: "Manager's reports, read automatically",
    body:
      "Point your night audit at an address once. Every report after that is read, filed against the right property, and checked against fifteen fixed rules.",
  },
  {
    title: "Market conditions on one map",
    body:
      "Rain radar, temperature, traffic and nearby demand drivers over your compset, with a forecast at each of your properties.",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Add your property",
    body: "Paste a TripAdvisor link or search by name. Competitors are found by distance, not guesswork.",
  },
  {
    n: "2",
    title: "Rates start collecting",
    body: "The first pull runs immediately and a daily job keeps it current. Nothing to schedule.",
  },
  {
    n: "3",
    title: "Forward your night audit",
    body: "Optional. Send the report to the address we give you and the analysis appears the next morning.",
  },
];

export default async function LandingPage() {
  const signedIn = Boolean((await cookies()).get(SESSION_COOKIE)?.value);

  return (
    <div style={{ background: "var(--page)", minHeight: "100vh" }}>
      <SiteNav signedIn={signedIn} />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 50% at 50% -10%, color-mix(in oklab, var(--accent) 14%, transparent), transparent 70%)",
          }}
        />
        <div className="relative mx-auto max-w-3xl px-6 pb-14 pt-20 text-center sm:pt-28">
          <span
            className="inline-block rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em]"
            style={{
              background: "var(--accent-soft)",
              color: "var(--accent)",
              border: "1px solid color-mix(in oklab, var(--accent) 28%, transparent)",
            }}
          >
            Rate intelligence for independent hotels
          </span>

          <h1
            className="mt-5 text-4xl font-semibold leading-[1.06] tracking-tight sm:text-6xl"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
          >
            Know what your compset charges
            <br />
            before you set tonight&rsquo;s rate.
          </h1>

          <p
            className="mx-auto mt-5 max-w-xl text-base leading-relaxed sm:text-lg"
            style={{ color: "var(--text-secondary)" }}
          >
            Rate Beacon watches your competitors&rsquo; published prices every day, reads
            your night audit for you, and puts both on one screen — so the
            pricing call takes two minutes instead of an hour of tab-flipping.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup" className="btn-accent px-6 py-3 text-[15px] no-underline">
              Start free
            </Link>
            <Link href="/demo" className="btn-ghost px-6 py-3 text-[15px] no-underline">
              See a live demo
            </Link>
          </div>
          <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
            No card. The demo needs no account.
          </p>
        </div>
      </section>

      {/* What it looks like */}
      <section className="mx-auto max-w-5xl px-6 pb-20">
        <div
          className="overflow-hidden rounded-xl"
          style={{ border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)" }}
        >
          <GridPreview />
        </div>
        <p className="mt-3 text-center text-xs" style={{ color: "var(--text-muted)" }}>
          The rate grid, as it appears on a live account.
        </p>
      </section>

      {/* Features */}
      <section id="how" className="mx-auto max-w-5xl px-6 pb-6">
        <h2
          className="text-center text-2xl font-semibold tracking-tight sm:text-3xl"
          style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
        >
          What it does
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="card card--lift p-6">
              <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                {f.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Steps */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <h2
          className="text-center text-2xl font-semibold tracking-tight sm:text-3xl"
          style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
        >
          Running in an afternoon
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="card p-6">
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold"
                style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
              >
                {s.n}
              </span>
              <h3 className="mt-3 text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                {s.title}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="mx-auto max-w-3xl px-6 pb-20">
        <h2
          className="text-center text-2xl font-semibold tracking-tight sm:text-3xl"
          style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
        >
          Pricing
        </h2>
        <div className="card mt-8 p-8 text-center">
          <p className="kicker">Early access</p>
          <p
            className="mt-2"
            style={{ font: "600 40px/1 var(--font-heading)", color: "var(--text-primary)" }}
          >
            Free
          </p>
          <p className="mt-3 text-sm" style={{ color: "var(--text-secondary)" }}>
            While the product is in early access it is free for one property and
            its competitive set. Get in touch before adding a portfolio and we
            will sort out something sensible.
          </p>
          <Link href="/signup" className="btn-accent mt-6 inline-block px-6 py-3 text-[15px] no-underline">
            Create an account
          </Link>
        </div>
      </section>

      <footer style={{ borderTop: "1px solid var(--border)" }}>
        <div
          className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-6 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <span>Rate Beacon</span>
          <Link href="/demo" className="no-underline" style={{ color: "var(--text-muted)" }}>
            Live demo
          </Link>
          <Link href="/login" className="no-underline" style={{ color: "var(--text-muted)" }}>
            Log in
          </Link>
          <span className="ml-auto">
            Rates from public meta-search listings. Weather from Open-Meteo and NOAA.
          </span>
        </div>
      </footer>
    </div>
  );
}

/**
 * A small, honest still of the grid. Deliberately a hand-built figure rather
 * than a screenshot: it stays sharp at any width, works in both themes, and
 * carries no real property's pricing.
 */
function GridPreview() {
  const nights = ["Fri 12", "Sat 13", "Sun 14", "Mon 15", "Tue 16"];
  const rows: { name: string; mine?: boolean; prices: (number | null)[] }[] = [
    { name: "Your hotel", mine: true, prices: [189, 219, 164, 132, 128] },
    { name: "Competitor A", prices: [199, 229, 171, 139, 135] },
    { name: "Competitor B", prices: [175, 205, 158, 129, null] },
    { name: "Competitor C", prices: [212, 248, 180, 145, 141] },
  ];
  const medians = nights.map((_, i) => {
    const vals = rows.slice(1).map((r) => r.prices[i]).filter((v): v is number => v != null);
    return vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)] ?? null;
  });

  return (
    <div style={{ background: "var(--surface)" }}>
      <div
        className="flex items-center gap-2 px-5 py-3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <span className="kicker">Rate grid</span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          illustrative figures
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr>
              <th className="th-label px-5 py-2.5 text-left">Hotel</th>
              {nights.map((n) => (
                <th key={n} className="th-label px-4 py-2.5 text-right">
                  {n}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} style={{ borderTop: "1px solid var(--gridline)" }}>
                <td
                  className="px-5 py-2.5 whitespace-nowrap"
                  style={{
                    color: r.mine ? "var(--accent)" : "var(--text-secondary)",
                    fontWeight: r.mine ? 700 : 400,
                  }}
                >
                  {r.name}
                </td>
                {r.prices.map((p, i) => {
                  const med = medians[i];
                  const delta = p != null && med ? ((p - med) / med) * 100 : null;
                  const tone =
                    r.mine || delta == null
                      ? "var(--text-primary)"
                      : delta <= -5
                        ? "var(--div-low)"
                        : delta >= 5
                          ? "var(--div-high)"
                          : "var(--text-secondary)";
                  return (
                    <td
                      key={i}
                      className="px-4 py-2.5 text-right tabular-nums"
                      style={{ color: p == null ? "var(--text-muted)" : tone }}
                    >
                      {p == null ? "—" : `$${p}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
