import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import SiteNav from "@/components/SiteNav";
import DemoGrid from "@/components/DemoGrid";
import ContactForm from "@/components/ContactForm";
import { buildDemoGrid } from "@/lib/demo";

export const dynamic = "force-dynamic";

// The public front door.
//
// A hotel operator decides in a few seconds whether this is worth their time,
// and they decide it by seeing the thing — so the live grid is the first thing
// below the headline, not a screenshot of it and not a video. Then the one
// question that actually differs by segment (what kind of property), and a way
// to reach a person. Nothing else.

const SEGMENTS = [
  {
    type: "franchised",
    title: "Franchised hotel",
    body: "Brand-site rates, OTA rates and your compset side by side, so a parity gap shows up as what it is.",
  },
  {
    type: "independent",
    title: "Independent hotel",
    body: "No revenue team needed. The nightly call — raise, hold, review — is on the home screen every morning.",
  },
  {
    type: "bnb",
    title: "Bed & breakfast",
    body: "A handful of rooms priced against the inns and small hotels a guest would actually choose between.",
  },
];

const POINTS = [
  {
    title: "Competitor rates, every night",
    body: "Published prices for your compset across the next 75 nights, collected daily in the background. You never press refresh.",
  },
  {
    title: "The competitive set you would pick",
    body: "Neighbours found by distance from your property and checked against the rate feed before they can be added. Nothing joins that cannot be priced.",
  },
  {
    title: "Your night audit, read for you",
    body: "Forward the manager's report once. Every one after that is read, filed against the right property, and checked against fifteen fixed rules.",
  },
  {
    title: "Conditions on the nights you are pricing",
    body: "A sixteen-day forecast at each property, public holidays, and the market's demand signal, on the same rows as the rates.",
  },
];

export default async function LandingPage() {
  const signedIn = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
  const demo = await buildDemoGrid();

  return (
    <div style={{ background: "var(--page)", minHeight: "100vh" }}>
      <SiteNav signedIn={signedIn} />

      {/* Headline and the one action */}
      <section className="mx-auto max-w-6xl px-6 pb-10 pt-16 sm:pt-20">
        <div className="max-w-2xl">
          <span className="kicker">Rate intelligence for hotels</span>
          <h1
            className="mt-3 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
          >
            Know what your compset is charging before you set tonight&rsquo;s rate.
          </h1>
          <p
            className="mt-4 max-w-xl text-base leading-relaxed sm:text-lg"
            style={{ color: "var(--text-secondary)" }}
          >
            Rate Beacon watches your competitors&rsquo; published prices every day, reads
            your night audit, and puts both on one screen. If the property is on
            TripAdvisor, it works — franchised, independent, or a bed and breakfast.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              href={signedIn ? "/app" : "/signup"}
              className="btn-accent px-6 py-3 text-[15px] no-underline"
            >
              {signedIn ? "Open dashboard" : "Start with your hotel"}
            </Link>
            <a href="#contact" className="btn-ghost px-5 py-3 text-[15px] no-underline">
              Talk to us
            </a>
          </div>
        </div>
      </section>

      {/* The product, live */}
      <section className="mx-auto max-w-6xl px-6 pb-16">
        <DemoGrid demo={demo} compact />
        <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
          A real market, read-only, updated by the same nightly job that runs on every
          account. Colour is each hotel&rsquo;s price against that night&rsquo;s market
          median.{" "}
          <Link href="/demo" style={{ color: "var(--text-secondary)" }}>
            Full grid →
          </Link>
        </p>
      </section>

      {/* Who it is for */}
      <section className="mx-auto max-w-6xl px-6 pb-16">
        <h2
          className="text-2xl font-semibold tracking-tight"
          style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
        >
          Which describes your property?
        </h2>
        <p className="mt-2 max-w-xl text-sm" style={{ color: "var(--text-secondary)" }}>
          Pick one and sign-up is set up for it. Not on the list? Tell us what you run and
          we will say plainly whether it fits.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {SEGMENTS.map((s) => (
            <Link
              key={s.type}
              href={signedIn ? "/app" : `/signup?type=${s.type}`}
              className="card card--lift block p-6 no-underline"
            >
              <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                {s.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                {s.body}
              </p>
              <span className="mt-4 inline-block text-sm" style={{ color: "var(--accent)" }}>
                Start →
              </span>
            </Link>
          ))}
        </div>
        <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          Something else — a hostel, serviced apartments, a group of properties?{" "}
          <a href="#contact" style={{ color: "var(--accent)" }}>
            Contact us
          </a>
          .
        </p>
      </section>

      {/* What it does */}
      <section id="how" className="mx-auto max-w-6xl px-6 pb-16" style={{ scrollMarginTop: 80 }}>
        <h2
          className="text-2xl font-semibold tracking-tight"
          style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
        >
          What it does
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {POINTS.map((f) => (
            <div key={f.title} className="card p-6">
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

      {/* Contact */}
      <section id="contact" className="mx-auto max-w-6xl px-6 pb-20" style={{ scrollMarginTop: 80 }}>
        <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2
              className="text-2xl font-semibold tracking-tight"
              style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
            >
              Contact us
            </h2>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              Ask whether it fits your property, how onboarding works, or anything about how
              your data is handled. A person reads every message and replies.
            </p>
          </div>
          <ContactForm />
        </div>
      </section>

      <footer style={{ borderTop: "1px solid var(--border)" }}>
        <div
          className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-6 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <span>© {new Date().getFullYear()} Rate Beacon</span>
          <Link href="/privacy" className="no-underline" style={{ color: "var(--text-muted)" }}>
            Privacy
          </Link>
          <Link href="/terms" className="no-underline" style={{ color: "var(--text-muted)" }}>
            Terms
          </Link>
          <span className="ml-auto">
            Rates from public meta-search listings. Weather from Open-Meteo. Map data ©
            OpenStreetMap contributors.
          </span>
        </div>
      </footer>
    </div>
  );
}
