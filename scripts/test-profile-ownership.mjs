// Ownership rules for profiles, exercised against a stand-in database.
//
// These are the rules that were missing: profiles were written with no owner,
// so a new customer's profile was invisible to them, and the endpoint took any
// profile id, so one customer could read or overwrite another's. Both are the
// kind of bug that looks fine in a browser you are already signed into, which
// is why they are pinned here instead.
//
// The stand-in implements only the query-builder calls this module makes, and
// it enforces the filters rather than ignoring them — a fake that returned rows
// regardless of .eq() would pass every one of these tests while the real
// database failed.
//
//   node --experimental-strip-types scripts/test-profile-ownership.mjs

import {
  saveProfile,
  deleteProfile,
  ownedProfile,
  profilesForAccount,
} from "../src/lib/profiles.ts";

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

/** A tiny in-memory Postgres stand-in with the filters actually applied. */
function fakeDb(seed = {}) {
  const tables = {
    profiles: seed.profiles ?? [],
    profile_hotels: seed.profile_hotels ?? [],
    hotels: seed.hotels ?? [],
  };
  let nextId = Math.max(0, ...tables.profiles.map((p) => p.id)) + 1;

  function query(table) {
    const filters = [];
    let mode = "select";
    let payload = null;
    let selected = false;

    const applied = () =>
      tables[table].filter((row) => filters.every(([col, val]) => row[col] === val));

    const runner = {
      select() {
        selected = true;
        return runner;
      },
      eq(col, val) {
        filters.push([col, val]);
        return runner;
      },
      in(col, vals) {
        filters.push([col, (row) => vals.includes(row)]);
        filters.pop();
        // Only used for reads we do not assert on here.
        return runner;
      },
      is() {
        return runner;
      },
      limit() {
        return runner;
      },
      order() {
        return runner;
      },
      returns() {
        return runner;
      },
      insert(rows) {
        mode = "insert";
        payload = Array.isArray(rows) ? rows : [rows];
        return runner;
      },
      update(fields) {
        mode = "update";
        payload = fields;
        return runner;
      },
      delete() {
        mode = "delete";
        return runner;
      },
      upsert(rows) {
        mode = "upsert";
        payload = Array.isArray(rows) ? rows : [rows];
        return runner;
      },
      maybeSingle() {
        return runner.then((r) => ({ data: r.data?.[0] ?? null, error: r.error }));
      },
      then(resolve, reject) {
        return Promise.resolve(commit()).then(resolve, reject);
      },
    };

    function commit() {
      if (mode === "insert" || mode === "upsert") {
        const written = payload.map((row) => {
          const withId = table === "profiles" ? { id: nextId++, ...row } : { ...row };
          tables[table].push(withId);
          return withId;
        });
        return { data: selected ? written : null, error: null };
      }
      if (mode === "update") {
        const rows = applied();
        for (const row of rows) Object.assign(row, payload);
        return { data: rows, error: null };
      }
      if (mode === "delete") {
        const rows = applied();
        tables[table] = tables[table].filter((r) => !rows.includes(r));
        return { data: rows, error: null };
      }
      return { data: applied(), error: null };
    }

    return runner;
  }

  return { from: (table) => query(table), tables };
}

const validInput = (over = {}) => ({
  hotelName: "Candlewood Suites Pensacola",
  cityCode: "g34550",
  cityName: "Pensacola, FL",
  currency: "USD",
  horizonDays: 75,
  adults: 2,
  hotels: [
    { hotelId: "g34550-d100", name: "Candlewood Suites Pensacola", isMine: true },
    { hotelId: "g34550-d101", name: "Hampton Inn", isMine: false },
  ],
  ...over,
});

// ── A new account creating its first profile ────────────────────────────
{
  const db = fakeDb();
  const result = await saveProfile(db, 7, validInput());
  check("new profile is created", result.ok === true);
  check("it reports being new", result.ok && result.created === true);

  const row = db.tables.profiles[0];
  check("the owner is written with the row", row?.account_id === 7, `account_id was ${row?.account_id}`);
  check("the profile carries the market", row?.city_code === "g34550");
  check("both hotels are linked", db.tables.profile_hotels.length === 2);
  check("the baseline is marked", db.tables.profile_hotels.some((l) => l.is_mine === true));

  // The whole point: the account can now find what it just made.
  const mine = await profilesForAccount(db, 7);
  check("the account can see its own profile", mine.length === 1);

  const theirs = await profilesForAccount(db, 8);
  check("another account cannot see it", theirs.length === 0);
}

// ── The rules that stop a caller reaching another account's profile ─────
{
  const db = fakeDb({
    profiles: [
      { id: 1, account_id: 1, name: "Theirs", city_code: "g111" },
      { id: 2, account_id: 2, name: "Mine", city_code: "g222" },
    ],
  });

  check("owned profile is readable", (await ownedProfile(db, 2, 2))?.name === "Mine");
  check("someone else's is not readable", (await ownedProfile(db, 2, 1)) === null);

  const overwrite = await saveProfile(db, 2, validInput({ profileId: 1, cityCode: "g999" }));
  check("cannot overwrite another account's profile", overwrite.ok === false);
  check("the refusal is a not-found, not a hint", !overwrite.ok && overwrite.status === 404);
  check(
    "the other profile is untouched",
    db.tables.profiles.find((p) => p.id === 1).city_code === "g111"
  );

  const destroy = await deleteProfile(db, 2, 1);
  check("cannot delete another account's profile", destroy.ok === false);
  check("it still exists", db.tables.profiles.some((p) => p.id === 1));

  const own = await deleteProfile(db, 2, 2);
  check("can delete its own", own.ok === true);
  check("and it is gone", !db.tables.profiles.some((p) => p.id === 2));
}

// ── Updating a profile the account does own ─────────────────────────────
{
  const db = fakeDb({
    profiles: [{ id: 5, account_id: 3, name: "Old", city_code: "g111", horizon_days: 30 }],
    profile_hotels: [{ profile_id: 5, hotel_id: "g111-d1", is_mine: true }],
  });

  const result = await saveProfile(db, 3, validInput({ profileId: 5, name: "New" }));
  check("an owned profile updates", result.ok === true);
  check("it does not report being new", result.ok && result.created === false);
  check("no second profile appears", db.tables.profiles.length === 1);
  check("the fields change", db.tables.profiles[0].name === "New");
  check("the owner is unchanged", db.tables.profiles[0].account_id === 3);
  check(
    "the tracked set is replaced, not appended",
    db.tables.profile_hotels.length === 2,
    `had ${db.tables.profile_hotels.length} links`
  );
}

// ── Input that would produce an unusable dashboard ──────────────────────
{
  const db = fakeDb();
  const noHotels = await saveProfile(db, 1, validInput({ hotels: [] }));
  check("a profile with no hotels is refused", noHotels.ok === false);

  const noMarket = await saveProfile(db, 1, validInput({ cityCode: "" }));
  check("a profile with no market is refused", noMarket.ok === false);

  const noBaseline = await saveProfile(
    db,
    1,
    validInput({ hotels: [{ hotelId: "g1-d1", name: "Someone else", isMine: false }] })
  );
  check("a profile with no hotel of your own is refused", noBaseline.ok === false);
  check(
    "and it says what to do about it",
    !noBaseline.ok && /which of these hotels is yours/i.test(noBaseline.error)
  );
  check("none of them were written", db.tables.profiles.length === 0);
}

// ── Plan limits, as passed in by the route ──────────────────────────────
{
  const db = fakeDb({
    profiles: [
      { id: 1, account_id: 9, name: "One", city_code: "g1" },
      { id: 2, account_id: 9, name: "Two", city_code: "g2" },
    ],
  });
  const limits = { maxProfiles: 2, maxHorizon: 30 };

  const third = await saveProfile(db, 9, validInput(), { limits });
  check("a third profile on a two-profile plan is refused", third.ok === false);
  check("the refusal names the plan's ceiling", !third.ok && /allows 2/.test(third.error));
  check("nothing was written", db.tables.profiles.length === 2);

  const edit = await saveProfile(db, 9, validInput({ profileId: 1, horizonDays: 90 }), { limits });
  check("editing an existing profile is still allowed at the cap", edit.ok === true);
  check(
    "the horizon is clamped to the plan",
    db.tables.profiles.find((p) => p.id === 1).horizon_days === 30,
    `horizon was ${db.tables.profiles.find((p) => p.id === 1).horizon_days}`
  );

  const unlimited = fakeDb();
  const free = await saveProfile(unlimited, 9, validInput({ horizonDays: 90 }));
  check("with no limits given, nothing is clamped or refused", free.ok === true && unlimited.tables.profiles[0].horizon_days === 90);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
