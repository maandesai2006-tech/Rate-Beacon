# Manager's-report pipeline

Night-audit report in, flagged insights out, running unattended, on free tiers
only.

```
  PMS night audit
        │  emails its daily flash / night audit
        ▼
  cw-pensacola@reports.<yourdomain>          Cloudflare Email Routing  (free)
        │
        ▼
  workers/email-ingest/src/worker.ts         Cloudflare Worker         (free)
        │  parses MIME, pulls the PDF/CSV, HMAC-signs the payload
        ▼
  POST /api/ingest-report                    Vercel Function           (free)
        │
        ├─ src/lib/gemini.ts                 Gemini 2.0 Flash          (free)
        │    Universal PMS Translator → strict JSON
        │    falls back to src/lib/reports.ts (regex) with no API key
        │
        ├─ src/lib/analysisEngine.ts         15 deterministic rules
        │
        └─ src/lib/daily-reports.ts          Supabase                  (free)
             daily_manager_reports + daily_insights
        ▼
  /dashboard/[hotelId]                       Next.js RSC
```

## Why it is split this way

The Worker only unpacks the envelope. It never looks at a hotel number, so a
PMS changing its report layout never requires a Worker redeploy — that change
lands entirely in the Vercel half, which deploys on a git push.

Extraction is a model's job and analysis is not. Gemini reads the PDF, which is
what a model is genuinely good at: it copes with a scan, a landscape grid, a
Today/MTD/YTD layout, and a vendor nobody wrote a parser for. It is told to
return `null` rather than guess, at temperature 0, so a gap stays a gap. Every
threshold, comparison and flag after that is plain TypeScript — the same
numbers always produce the same flags, and each flag states the figure and the
threshold it used so a manager can check it.

## Tables

| Table | Holds |
| --- | --- |
| `manager_reports` | Raw ingest ledger — subject, message id, extracted text. Lets a report be re-parsed without going back to the mailbox. |
| `daily_manager_reports` | One normalised row per hotel per business date. What everything downstream reads. |
| `daily_insights` | The flags the engine raised for that row. Replaced, not appended, when a report is re-ingested. |
| `report_inboxes` | `alias → profile + hotel`. Onboarding a hotel is one insert, not a redeploy. |

RLS is on for all four with an explicit deny for `anon` and `authenticated`.
Every read goes through a server-side route holding the service-role key; the
browser never holds a Supabase credential.

## Setup

### 1. Supabase

Apply `supabase/migrations/006_gemini_report_pipeline.sql`, then add one row per
property:

```sql
insert into report_inboxes (alias, profile_id, hotel_id, label) values
  ('cw-pensacola', 1, 'g34550-d10637341', 'Candlewood Suites Pensacola');
```

Leave `hotel_id` null to let the extractor decide which of the profile's tracked
hotels a report belongs to — useful when several properties share one alias.

### 2. Gemini key

<https://aistudio.google.com> → **Get API key**. Free tier, no card. Set
`GEMINI_API_KEY` in the Vercel project.

Without the key the route still works: it falls back to the built-in text
parser, which handles clean digital reports and fails on scans. The dashboard
shows which extractor produced each row.

### 3. Vercel

```
INGEST_SECRET   a long random string
GEMINI_API_KEY  from step 2
GEMINI_MODEL    optional, defaults to gemini-2.0-flash
```

### 4. Cloudflare

Add your domain to Cloudflare (free plan), then **Email → Email Routing →
Enable**.

```bash
cd workers/email-ingest
npm install
npx wrangler secret put INGEST_SECRET   # same value as on Vercel
npx wrangler deploy
```

Edit `wrangler.toml` so `INGEST_URL` points at your deployment, then in the
dashboard add a **catch-all** rule on the reports subdomain with the action
**Send to a Worker → rate-beacon-email-ingest**. Every `<alias>@reports.…`
address now reaches the Worker.

### 5. Point the PMS at it

Add `cw-pensacola@reports.<yourdomain>` to the property's night-audit
distribution list. Nothing else is needed; the first report populates
`/dashboard/g34550-d10637341`.

## The fifteen rules

| # | Flag | Fires when |
| --- | --- | --- |
| 1 | `revpar_delta` | RevPAR moved more than 5% night over night |
| 2 | `adr_drop` | ADR under the property's own 30-report average by 5%+ (under $100 before there is history) |
| 3 | `near_sell_out` | Occupancy above 95% — "Near Sell-Out (Maximize Rate)" |
| 4 | `out_of_order_spike` | More than 3 rooms out of order |
| 5 | `no_show_rate` | No-shows above 3% of reservations, not a raw count |
| 6 | `comp_rooms` | More than 5 comp or house-use rooms |
| 7 | `early_departures` | More than 2 early departures |
| 8 | `extended_stays` | More than 3 stays extended, when the report carries the field |
| 9 | `cash_variance` | Any non-zero drawer variance |
| 10 | `walk_in_volume` | More than 5 walk-ins — "High Walk-in Demand - Check Rate" |
| 11 | `adjustments` | More than $100 in adjustments, allowances or refunds |
| 12 | `revenue_reconciliation` | ADR × rooms sold misses room revenue by more than $5 |
| 13 | `compset_underpriced` | ADR below the compset average while occupancy is above 90% |
| 14 | `pacing_weakness` | Occupancy well under what this property normally runs on that weekday |
| 15 | `direct_bill` | More than $500 transferred to direct bill / city ledger |

Rules 13 and 14 are the two the original spec marked "mocked". They are not
mocked here. Rule 13 reads the real compset average out of `rate_snapshots` —
the same prices the rate grid shows — and **skips** when the compset was not
priced for that night, rather than comparing against a placeholder. Rule 14
compares a Thursday against this property's own Thursdays once there are three
of them, and only falls back to the flat 50% line before that. A rule with no
real input stays silent; nothing on this dashboard comes from a number that was
invented.

Thresholds live in `DEFAULT_THRESHOLDS` in `src/lib/analysisEngine.ts` and can
be overridden per call.

```bash
node --experimental-strip-types scripts/test-analysis-engine.mjs
```

covers all fifteen, both the firing and the non-firing side.

## Cost

| | Free allowance | This app uses |
| --- | --- | --- |
| Cloudflare Email Routing | unlimited | 1–2 emails/hotel/day |
| Cloudflare Workers | 100k requests/day | same |
| Gemini 2.0 Flash | generous daily request quota | 1 request/report |
| Vercel Functions | 100 GB-hours/month | a few seconds/report |
| Supabase | 500 MB database | a few KB/report |

At one report per hotel per day, a hundred hotels stays inside every free tier.
