// Deciding whether two hotel records are the same property.
//
// Competitor discovery now merges three sources, and one of them — the map —
// carries no id the rate feed understands. Matching those hotels against the
// ones we can already price is what decides whether an operator is shown a
// clean list or the same hotel twice, once addable and once asking for a link.
//
// Both halves of the rule earn their place here: name alone matches every
// Hampton Inn in the country, and distance alone matches a hotel to the one
// across the car park.
//
//   node --experimental-strip-types scripts/test-compset-matching.mjs

import { comparableName, sameProperty } from "../src/lib/hotel-match.ts";

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

// ── Reducing a name to what identifies the hotel ────────────────────────
check(
  "franchise wrapper is dropped",
  comparableName("Hampton Inn & Suites by Hilton Pensacola") ===
    comparableName("Hampton Inn Suites Pensacola"),
  `"${comparableName("Hampton Inn & Suites by Hilton Pensacola")}" vs "${comparableName("Hampton Inn Suites Pensacola")}"`
);
check(
  "punctuation and case do not matter",
  comparableName("CANDLEWOOD SUITES, PENSACOLA") === comparableName("Candlewood Suites Pensacola")
);
check(
  "filler words are dropped",
  comparableName("The Gulf View Hotel") === comparableName("Gulf View")
);
check(
  "two different brands stay different",
  comparableName("Hampton Inn Pensacola") !== comparableName("Holiday Inn Pensacola")
);
check("a name reduced to nothing is empty", comparableName("The Hotel") === "");

// ── The same building, seen by two sources ──────────────────────────────
const osm = { name: "Hampton Inn & Suites Pensacola", latitude: 30.4213, longitude: -87.2169 };

check(
  "same name, same spot → same property",
  sameProperty(osm, { name: "Hampton Inn Suites by Hilton Pensacola", latitude: 30.4215, longitude: -87.2171 })
);
check(
  "same name, other side of town → not the same property",
  !sameProperty(osm, { name: "Hampton Inn Suites Pensacola", latitude: 30.52, longitude: -87.31 }),
  "a chain's second location must not absorb the first"
);
check(
  "different hotel at the same address → not the same property",
  !sameProperty(osm, { name: "Courtyard by Marriott Pensacola", latitude: 30.4214, longitude: -87.217 }),
  "neighbours share coordinates to three decimals"
);
check(
  "a name that contains the other still matches",
  sameProperty(osm, { name: "Hampton Inn", latitude: 30.4216, longitude: -87.2168 })
);
check(
  "an unplaced record matches on name alone",
  sameProperty(osm, { name: "Hampton Inn Suites Pensacola", latitude: null, longitude: null }),
  "the directory often has no coordinates yet, and hiding the match would offer it twice"
);
check(
  "an unplaced record with a different name does not match",
  !sameProperty(osm, { name: "Days Inn Pensacola", latitude: null, longitude: null })
);
check(
  "a blank name never matches",
  !sameProperty(osm, { name: "   ", latitude: 30.4213, longitude: -87.2169 })
);

// ── The tolerance is a real distance, not a coordinate comparison ───────
check(
  "a quarter of a mile away is the same property",
  sameProperty(osm, { name: "Hampton Inn Pensacola", latitude: 30.4247, longitude: -87.2169 })
);
check(
  "two miles away is not",
  !sameProperty(osm, { name: "Hampton Inn Pensacola", latitude: 30.4503, longitude: -87.2169 })
);
check(
  "the tolerance can be widened by the caller",
  sameProperty(osm, { name: "Hampton Inn Pensacola", latitude: 30.4503, longitude: -87.2169 }, 3)
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
