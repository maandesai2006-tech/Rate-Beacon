// Fails if a route can read tenant data without being scoped to an account.
//
// Row-level security is the real defence, but it only bites when the request
// carries an account token. This checks the other half: that routes handling a
// signed-in user actually ask for the scoped client. It is a lint, not a
// proof — but it catches the exact mistake that leaks one hotel's data to
// another, which is the one worth catching mechanically rather than by review.
//
//   node scripts/audit-tenant-scope.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src/app/api";

// Tables holding one customer's data. Anything here must be reached through a
// client scoped to an account, or from a job that legitimately spans tenants.
const TENANT_TABLES = [
  "profiles",
  "profile_hotels",
  "baseline_comps",
  "my_rates",
  "manager_reports",
  "report_metrics",
  "daily_manager_reports",
  "daily_insights",
  "email_sources",
  "report_sources",
  "report_inboxes",
  "map_places",
  "events",
  "accounts",
  "sessions",
];

// Routes that are meant to span tenants, each with the reason it is allowed.
const CROSS_TENANT_ALLOWED = {
  "api/cron/snapshot/route.ts": "nightly rate collection runs for every profile",
  "api/cron/reports/route.ts": "nightly mailbox sync runs for every profile",
  "api/cron/map/route.ts": "nightly map refresh runs for every profile",
  "api/auth/login/route.ts": "runs before an account is known",
  "api/auth/signup/route.ts": "creates the account",
  "api/auth/logout/route.ts": "clears a session by token",
  "api/auth/me/route.ts": "resolves the session to an account",
  "api/ingest-report/route.ts": "authenticated by a shared secret, not a session",
  "api/geocode/route.ts": "places hotels in the shared directory",
  "api/demo/grid/route.ts": "public, and reads only shared market data",
  "api/system-check/route.ts": "diagnostics across the deployment",
  "api/setup/route.ts": "creates the first profile for an account",
  "api/reports/inbound/route.ts": "authenticated by a per-profile inbox token, not a session",
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(p);
  }
  return out;
}

let problems = 0;
let checked = 0;
let allowed = 0;

for (const file of walk(ROOT)) {
  const rel = file.replace(/^src\/app\//, "");
  const src = readFileSync(file, "utf8");

  const touches = TENANT_TABLES.filter((t) =>
    new RegExp(`\\.from\\(\\s*["'\`]${t}["'\`]`).test(src)
  );
  if (touches.length === 0) continue;
  checked++;

  if (CROSS_TENANT_ALLOWED[rel]) {
    allowed++;
    console.log(`  allow ${rel} — ${CROSS_TENANT_ALLOWED[rel]}`);
    continue;
  }

  // requireAccount() resolves the session and hands back a client bound to the
  // account; dbForAccount() is the lower-level way to the same thing.
  const usesScoped = /\b(requireAccount|dbForAccount)\s*\(/.test(src);
  const usesService = /\bdb\(\)/.test(src);

  if (!usesScoped) {
    problems++;
    console.log(
      `  FAIL  ${rel} reads ${touches.join(", ")} without an account-scoped client. Use requireAccount().`
    );
  } else if (usesService) {
    problems++;
    console.log(
      `  FAIL  ${rel} still calls db() alongside the scoped client. The unscoped client must not touch tenant tables in a request handler.`
    );
  } else {
    console.log(`  ok    ${rel} — scoped (${touches.join(", ")})`);
  }
}

console.log(
  `\n${checked} route${checked === 1 ? "" : "s"} touch tenant tables · ${allowed} allowed cross-tenant · ${problems} problem${problems === 1 ? "" : "s"}\n`
);
process.exit(problems === 0 ? 0 : 1);
