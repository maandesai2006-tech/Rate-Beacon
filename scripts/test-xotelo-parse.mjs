// The hotel-listing response is parsed by shape, not by field name, because
// the upstream API is undocumented and has renamed fields before. These cases
// are the envelopes it has been seen to return and the ones it plausibly could
// — the point is that a rename must not empty the compset picker.
//
//   node --experimental-strip-types scripts/test-xotelo-parse.mjs

import { hotelsInResponse } from "../src/lib/xotelo-list.ts";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// 1. The documented /list envelope.
const list = {
  list: [
    {
      key: "g34550-d10637341",
      name: "Candlewood Suites Pensacola",
      rating: 4.5,
      review_count: 210,
      geo: { latitude: 30.478, longitude: -87.209 },
      price_ranges: { minimum: 129 },
    },
    { key: "g34550-d111111", name: "Holiday Inn Express", rating: 4.0, review_count: 90 },
  ],
};
const a = hotelsInResponse(list);
check("list: two hotels", a.length, 2);
check("list: key", a[0].hotelKey, "g34550-d10637341");
check("list: name", a[0].name, "Candlewood Suites Pensacola");
check("list: coords", [a[0].latitude, a[0].longitude], [30.478, -87.209]);
check("list: price", a[0].price, 129);
check("list: rating", a[0].rating, 4.5);
check("list: reviews", a[0].reviewCount, 210);
check("list: missing coords stay null", [a[1].latitude, a[1].longitude], [null, null]);

// 2. A renamed envelope with renamed fields — the case that used to return
//    nothing at all.
const renamed = {
  hotels: {
    items: [
      {
        hotel_key: "g34550-d222222",
        title: "Hampton Inn",
        review_summary: { rating: 4.2, count: 77 },
        coordinates: { lat: 30.5, lng: -87.2 },
        min_price: 149,
      },
    ],
  },
};
const b = hotelsInResponse(renamed);
check("renamed: found", b.length, 1);
check("renamed: name from title", b[0].name, "Hampton Inn");
check("renamed: rating from summary", b[0].rating, 4.2);
check("renamed: reviews from summary", b[0].reviewCount, 77);
check("renamed: coords from lat/lng", [b[0].latitude, b[0].longitude], [30.5, -87.2]);
check("renamed: price from min_price", b[0].price, 149);

// 3. Numbers arriving as strings, as JSON APIs often do.
const strings = {
  result: [{ id: "g34550-d333333", name: "Comfort Inn", latitude: "30.41", longitude: "-87.19", rating: "3.8" }],
};
const c = hotelsInResponse(strings);
check("strings: coords parsed", [c[0].latitude, c[0].longitude], [30.41, -87.19]);
check("strings: rating parsed", c[0].rating, 3.8);

// 4. Things that are not hotels must not become hotels.
check("empty object", hotelsInResponse({}).length, 0);
check("null", hotelsInResponse(null).length, 0);
check("location without a hotel id", hotelsInResponse({ list: [{ key: "g34550", name: "Pensacola" }] }).length, 0);
check("hotel key but no name", hotelsInResponse({ list: [{ key: "g34550-d1" }] }).length, 0);

// 5. A hotel nested under its parent location keeps its own key, not the
//    parent's — the "parent_key" trap.
const nested = {
  location: {
    location_key: "g34550",
    name: "Pensacola",
    hotels: [{ parent_key: "g34550-d999999", hotel_key: "g34550-d444444", name: "Courtyard" }],
  },
};
const d = hotelsInResponse(nested);
check("nested: only the hotel", d.length, 1);
check("nested: own key wins", d[0].hotelKey, "g34550-d444444");

// 6. The same hotel twice collapses to one entry.
const dupes = {
  list: [
    { key: "g34550-d555555", name: "Best Western" },
    { key: "g34550-d555555", name: "Best Western" },
  ],
};
check("duplicates collapse", hotelsInResponse(dupes).length, 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
