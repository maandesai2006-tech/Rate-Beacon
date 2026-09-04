import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import SiteNav from "@/components/SiteNav";

export const dynamic = "force-dynamic";

// What the product collects, where it goes, and how to get it removed —
// written from what the code actually does, not from a template. A draft for
// counsel to review before customers rely on it, and honest about that.

export default async function PrivacyPage() {
  const signedIn = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
  return (
    <div style={{ background: "var(--page)", minHeight: "100vh" }}>
      <SiteNav signedIn={signedIn} />
      <main className="prose-page mx-auto max-w-3xl px-6 py-12">
        <span className="kicker">Privacy</span>
        <h1
          className="mt-2 text-3xl font-semibold tracking-tight"
          style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
        >
          How Rate Beacon handles your data
        </h1>
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
          Last updated September 2026. This describes what the software actually does; it has
          not yet been reviewed by a lawyer, and it will be updated when it has.
        </p>

        <Section title="What we collect">
          <ul>
            <li>
              <b>Account details.</b> A username or email address and a password. Passwords
              are stored as a salted PBKDF2-SHA256 hash and are never recoverable by us.
            </li>
            <li>
              <b>Your properties and competitive set.</b> The hotels you track, identified by
              their public TripAdvisor listing, and which of them are yours.
            </li>
            <li>
              <b>Manager&rsquo;s reports</b>, if you choose to send them. The nightly figures
              (occupancy, ADR, RevPAR and similar) are stored so the analysis can run. The
              report text itself is kept as evidence of what was read, encrypted at rest under
              a key that only the application holds.
            </li>
            <li>
              <b>Mailbox credentials</b>, if you connect a mailbox for report collection.
              Encrypted at rest with AES-256-GCM. Used only to read messages addressed to the
              reporting inbox.
            </li>
            <li>
              <b>Contact form messages</b>, with the email address you give us to reply to.
            </li>
          </ul>
        </Section>

        <Section title="What we do not collect">
          <ul>
            <li>Guest names, guest contact details, or payment information of any kind.</li>
            <li>Advertising identifiers or third-party tracking. There is no analytics beacon on these pages.</li>
          </ul>
        </Section>

        <Section title="Where it is stored and who processes it">
          <p>
            The application runs on Vercel (United States) and stores data in a Supabase
            Postgres database (US-East). Each account&rsquo;s rows are isolated by database
            policy, so one customer&rsquo;s connection cannot read another&rsquo;s.
          </p>
          <p>To do its job, the service sends limited data to:</p>
          <ul>
            <li>
              <b>Xotelo / TripAdvisor meta-search</b> — hotel identifiers only, to read
              published prices. Nothing about your account is sent.
            </li>
            <li>
              <b>Open-Meteo</b> — the coordinates of your properties, for the forecast.
            </li>
            <li>
              <b>OpenStreetMap (Nominatim, Overpass)</b> — hotel names and coordinates, to
              place properties and find nearby ones.
            </li>
            <li>
              <b>Google Gemini</b> — only when a manager&rsquo;s report cannot be read by the
              built-in parser (a scan or an unfamiliar layout). The report is sent to extract
              its figures and is not used to train models under the API terms in force.
            </li>
          </ul>
        </Section>

        <Section title="How long we keep it">
          <ul>
            <li>Competitor rate history: every capture for 30 days, then one record per hotel-night.</li>
            <li>Manager&rsquo;s reports: for as long as the account exists.</li>
            <li>Sessions: 30 days from sign-in.</li>
            <li>Contact messages: until answered and then archived.</li>
          </ul>
        </Section>

        <Section title="Deleting your data">
          <p>
            You can delete your account from the dashboard at any time. That removes your
            profiles, tracked hotels, competitive sets, manual rates, reports and their
            analysis, mailbox credentials and sessions, immediately and permanently. Public
            market data — hotel names and published prices — is not yours or ours and is not
            affected.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about any of this go through the{" "}
            <Link href="/#contact">contact form</Link>. A person replies.
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
