import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import SiteNav from "@/components/SiteNav";

export const dynamic = "force-dynamic";

// Plain terms. A draft for counsel, and says so.

export default async function TermsPage() {
  const signedIn = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
  return (
    <div style={{ background: "var(--page)", minHeight: "100vh" }}>
      <SiteNav signedIn={signedIn} />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <span className="kicker">Terms of service</span>
        <h1
          className="mt-2 text-3xl font-semibold tracking-tight"
          style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
        >
          Terms
        </h1>
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
          Last updated September 2026. Not yet reviewed by a lawyer; it will be updated when it has.
        </p>

        <Section title="The service">
          <p>
            Rate Beacon collects publicly published hotel rates for the properties you choose
            to track, reads the manager&rsquo;s reports you choose to send, and presents both
            with analysis. It is decision support. Pricing decisions, and their results, are
            yours.
          </p>
        </Section>

        <Section title="Your account">
          <ul>
            <li>You are responsible for the credentials you create and for who you share them with.</li>
            <li>Track only properties you are entitled to track, and send only reports you are entitled to send.</li>
            <li>Each account is for one business. A group of properties is one account with several profiles.</li>
          </ul>
        </Section>

        <Section title="Data sources and accuracy">
          <p>
            Competitor rates come from public meta-search listings and reflect what those
            listings showed at the time of collection. They can be stale, incomplete, or
            wrong, and a hotel can be absent from them entirely. Weather, holidays and map
            data come from third-party services with their own terms. None of it is a
            guarantee of anything.
          </p>
        </Section>

        <Section title="Availability">
          <p>
            The service runs on third-party infrastructure and depends on third-party data
            feeds. It is offered as is, and may be unavailable or degraded from time to time.
            The system check inside the product says what is and is not working.
          </p>
        </Section>

        <Section title="Ending the agreement">
          <p>
            You can delete your account, and everything it holds, from the dashboard at any
            time. We may suspend an account that is used to scrape, resell or otherwise
            misuse the data it has access to.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions go through the <Link href="/#contact">contact form</Link>.
          </p>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
        {title}
      </h2>
      <div className="legal-body mt-2 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {children}
      </div>
    </section>
  );
}
