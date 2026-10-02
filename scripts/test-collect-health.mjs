// Telling a rate-source outage from a market that is genuinely full.
//
// Getting this wrong in one direction stores fabricated sellouts as market
// facts, which is what happened on seven days in September. Getting it wrong
// in the other direction stalls collection on exactly the nights a revenue
// manager most needs to see: a festival weekend where most of a town is full.
// Both directions are pinned here.
//
//   node --experimental-strip-types scripts/test-collect-health.mjs

import { sourceFailing, runLooksDegraded, pauseUntil, FAST_BREAKER, RUN_SANITY, REPEAT_BACKOFF_MINUTES } from "../src/lib/collect-health.ts";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const look = (hotelId, outcome) => ({ hotelId, outcome });
const many = (n, outcome, hotels = 6) => Array.from({ length: n }, (_, i) => look(`h${i % hotels}`, outcome));

// ── Fast breaker: the source errors ──────────────────────────────────────
check("too few lookups say nothing", !sourceFailing(many(FAST_BREAKER.minSample - 1, "failed")));
check("a run of failures across hotels trips it", sourceFailing(many(8, "failed")));
check("healthy lookups never trip it", !sourceFailing(many(40, "priced")));
check(
  "a market full of empty answers is not a source failure",
  !sourceFailing(many(12, "no_offers")),
  "an empty answer is the source answering"
);
check(
  "one bad hotel key cannot stall the run",
  !sourceFailing(many(12, "failed", 1)),
  "twelve failures on one hotel is that hotel, not the source"
);
check("two hotels failing is still not the source", !sourceFailing(many(12, "failed", 2)));
check(
  "a recovery is seen: only the recent window counts",
  !sourceFailing([...many(30, "failed"), ...many(12, "priced")])
);
check(
  "an outage arriving mid-tick is seen despite earlier good lookups",
  sourceFailing([...many(30, "priced"), ...many(12, "failed")])
);
{
  // 8 failed of 12 is under three quarters.
  const mixed = [...many(8, "failed"), ...many(4, "priced")];
  check("two thirds failing is not enough", !sourceFailing(mixed));
  const worse = [...many(9, "failed"), ...many(3, "priced")];
  check("three quarters failing is", sourceFailing(worse));
}

// ── Run sanity: the source answers with nothing ──────────────────────────
// The real September outage: ~916 lookups, every one empty.
check("an empty run trips once enough is seen", runLooksDegraded(64, 64, 916));
check("but not before enough is seen", !runLooksDegraded(63, 63, 916));
check("a normal day (1% empty) is believed", !runLooksDegraded(916, 10, 916));
check(
  "a festival night is believed",
  !runLooksDegraded(64, 30, 916),
  "47% of tonight sold out is a market, not an outage"
);
check("small accounts are still judged", runLooksDegraded(29, 29, 58));
check("but never on a handful of lookups", !runLooksDegraded(10, 10, 12));
check("the floor holds for tiny accounts", runLooksDegraded(16, 16, 12));
check("an empty run with no plan is ignored", !runLooksDegraded(0, 0, 0));

// ── Backoff ──────────────────────────────────────────────────────────────
{
  const at = pauseUntil(new Date("2026-09-24T00:00:00Z"));
  check("backoff is thirty minutes", at === "2026-09-24T00:30:00.000Z", at);
}
{
  // A source that stays dark all day: each run-level probe costs up to the
  // sanity ceiling in lookups. Escalating after the first outage must keep a
  // dead day cheaper than a healthy one (~916 lookups at today's size).
  const probesAfterFirst = Math.floor((24 * 60 - 30) / REPEAT_BACKOFF_MINUTES);
  const worstCase = RUN_SANITY.ceiling * (1 + probesAfterFirst);
  check("a dead day costs fewer lookups than a healthy one", worstCase < 916, `${worstCase} lookups`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
