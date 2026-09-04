// Which strings the geocoder tries, for the names hotels actually trade under.
//
// Both baseline hotels on the deployment went unplaced because they were
// asked for verbatim — "Candlewood Suites Pensacola University Area by IHG" is
// how a franchise lists itself, not how a map indexes it. The value of the
// query builder is entirely in which variants it produces and in what order,
// so that is what is pinned.
//
//   node --experimental-strip-types scripts/test-geocode-queries.mjs

import { geocodeQueries } from "../src/lib/geo.ts";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const candlewood = geocodeQueries("Candlewood Suites Pensacola University Area by IHG", "Pensacola, FL");
check("verbatim name is tried first", candlewood[0] === "Candlewood Suites Pensacola University Area by IHG, Pensacola, FL", candlewood[0]);
check("franchise wrapper is dropped", candlewood.some((q) => q === "Candlewood Suites Pensacola University Area, Pensacola, FL"));
check("brand plus town is the last resort", candlewood.some((q) => q === "Candlewood Suites Pensacola, Pensacola, FL"), candlewood.join(" | "));
check("no duplicates", new Set(candlewood).size === candlewood.length);

const hampton = geocodeQueries("Hampton Inn & Suites Pensacola I-10 N University Town Plaza", "Pensacola, FL");
check("road designation and plaza are dropped", hampton.some((q) => /^Hampton Inn Pensacola, Pensacola, FL$/.test(q)), hampton.join(" | "));

const redroof = geocodeQueries("Red Roof Inn Pensacola - I-10 at Davis Hwy", "Pensacola, FL");
check("locality after a dash is dropped", redroof.some((q) => q === "Red Roof Inn Pensacola, Pensacola, FL"), redroof.join(" | "));

const residence = geocodeQueries("Residence Inn Pensacola Airport/Medical Center", "Pensacola, FL");
check("slash suffix is dropped", residence.some((q) => q === "Residence Inn Pensacola, Pensacola, FL"), residence.join(" | "));

const hiex = geocodeQueries("Holiday Inn Express & Suites Destin E - Commons Mall", "Destin, FL");
check("town is appended when the name lacks it", hiex.every((q) => !q.endsWith(", Destin, FL") || q.includes("Destin")));
check("a variant without the town is also tried", hiex.some((q) => !q.includes(", Destin, FL")));

const plain = geocodeQueries("The Grand Hotel", null);
check("no town means no town suffix", plain.every((q) => !q.includes(",")));
check("short fragments are not tried", geocodeQueries("Inn", "Destin, FL").every((q) => q.length >= 4));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
