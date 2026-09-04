// Reading TripAdvisor ids out of what a search returns, and reading the town
// out of an address.
//
// Both are the load-bearing halves of automatic competitor discovery: the
// address decides which market a property is anchored in, and the id is what
// makes a neighbour followable. Neither can be tested against the network from
// here, so what is pinned is the parsing — the part that decides whether a
// real search result becomes a real competitor or a wrong one.
//
//   node --experimental-strip-types scripts/test-key-resolution.mjs

import { keysInText, townOf } from "../src/lib/hotel-match.ts";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

// ── Ids out of search results ───────────────────────────────────────────
check(
  "a full TripAdvisor URL yields its id",
  keysInText(
    "https://www.tripadvisor.com/Hotel_Review-g34467-d1234567-Reviews-Holiday_Inn_Express-Destin_Florida.html"
  )[0] === "g34467-d1234567"
);
check(
  "a country domain works too",
  keysInText("https://www.tripadvisor.co.uk/Hotel_Review-g186338-d193089-Reviews-The_Savoy-London.html")[0] ===
    "g186338-d193089"
);
check("a bare id is accepted", keysInText("the key is g34550-d10637341 apparently")[0] === "g34550-d10637341");
check("ids are lowercased", keysInText("G34550-D999")[0] === "g34550-d999");
check("duplicates collapse", keysInText("g1-d2 and again g1-d2").length === 1);
check(
  "several results keep their order",
  JSON.stringify(keysInText("first g10-d20, then g30-d40")) === JSON.stringify(["g10-d20", "g30-d40"])
);

// The failure that matters: nothing shaped like an id must be invented from
// text that has none.
check("no id in ordinary prose", keysInText("I could not find that hotel on TripAdvisor.").length === 0);
check("NONE yields nothing", keysInText("3. NONE").length === 0);
check("a location key alone is not a hotel", keysInText("https://www.tripadvisor.com/Hotels-g34467-Destin.html").length === 0);
check("a bare number is not an id", keysInText("d1234567 on its own").length === 0);
check("a longer number does not partially match", keysInText("g34550-d1063734199999x").length === 0);

// ── The town out of an address ──────────────────────────────────────────
check(
  "a full geocoder address gives town and state",
  townOf(
    "Holiday Inn Express & Suites, 4300 Legendary Drive, Destin, Okaloosa County, Florida, 32541, United States"
  ) === "Destin, Florida",
  townOf("Holiday Inn Express & Suites, 4300 Legendary Drive, Destin, Okaloosa County, Florida, 32541, United States")
);
check(
  "the county is skipped",
  townOf("Candlewood Suites, 7827 N Davis Hwy, Pensacola, Escambia County, Florida, 32514, United States") ===
    "Pensacola, Florida"
);
check("a short address gives nothing rather than a guess", townOf("Somewhere, USA") === null);
check("no address gives nothing", townOf(null) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
