import { NextResponse } from "next/server";
import { db, dbForAccount, tenantConfig } from "@/lib/db";
import { hydrationState, registerSchedulerTarget } from "@/lib/hydration";
import { hotelsNear, lastOverpassErrors } from "@/lib/overpass";

// A one-click health report, in plain language. Every external dependency is
// probed from the server (they are not reachable from a browser), so the
// answer to "why is X empty?" is visible in the app instead of requiring
// someone to open API URLs by hand.
export const maxDuration = 60;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function timed(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; ms: number; body: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, cache: "no-store" });
    const body = (await res.text()).slice(0, 400);
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, body: (e as Error).message };
  }
}

export async function GET() {
  const checks: Check[] = [];
  const supa = db();

  // 1. Database
  try {
    const { count } = await supa
      .from("rate_snapshots")
      .select("id", { count: "exact", head: true });
    checks.push({ name: "Database", ok: true, detail: `Connected. ${count ?? 0} rate snapshots stored.` });
  } catch (e) {
    checks.push({ name: "Database", ok: false, detail: (e as Error).message });
  }

  // 2. Rate feed
  const inD = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  const outD = new Date(Date.now() + 15 * 86400e3).toISOString().slice(0, 10);
  const rates = await timed(
    `https://data.xotelo.com/api/rates?hotel_key=g34550-d10637341&chk_in=${inD}&chk_out=${outD}&currency=USD&adults=2&rooms=1`
  );
  let ratesOk = false;
  try {
    const j = JSON.parse(rates.body.startsWith("{") ? rates.body : "{}");
    ratesOk = rates.ok && !j.error;
  } catch {
    ratesOk = false;
  }
  checks.push({
    name: "Rate feed (prices)",
    ok: ratesOk,
    detail: ratesOk
      ? `Responding in ${rates.ms}ms.`
      : `HTTP ${rates.status} in ${rates.ms}ms. ${rates.body.slice(0, 180)}`,
  });

  // 3. Hotel listing — the source of ratings and competitor discovery. The
  // endpoint rejects some parameter shapes, so probe the known variants and
  // report which (if any) answers.
  const inL = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  const outL = new Date(Date.now() + 15 * 86400e3).toISOString().slice(0, 10);
  const listVariants: [string, string][] = [
    ["basic", `location_key=g34550&offset=0&limit=30`],
    ["sorted", `location_key=g34550&offset=0&limit=30&sort=best_value`],
    ["dated", `location_key=g34550&chk_in=${inL}&chk_out=${outL}&offset=0&limit=30&currency=USD&adults=2&rooms=1`],
    ["dated-min", `location_key=g34550&chk_in=${inL}&chk_out=${outL}&offset=0&limit=30`],
    ["bare", `location_key=g34550`],
  ];
  let listWinner = "";
  let listCount = 0;
  const listNotes: string[] = [];
  for (const [label, qs] of listVariants) {
    const r = await timed(`https://data.xotelo.com/api/list?${qs}`);
    let n = 0;
    let msg = "";
    try {
      const j = JSON.parse(r.body.startsWith("{") ? r.body : "{}");
      n = (j.result?.list ?? []).length;
      if (j.error) msg = typeof j.error === "string" ? j.error : JSON.stringify(j.error);
    } catch {
      msg = r.body.slice(0, 90);
    }
    if (n > 0) {
      listWinner = label;
      listCount = n;
      break;
    }
    listNotes.push(`${label}: ${msg.slice(0, 90) || `HTTP ${r.status}`}`);
  }
  checks.push({
    name: "Hotel listing (ratings, discovery)",
    ok: listCount > 0,
    detail:
      listCount > 0
        ? `Works using the "${listWinner}" parameter shape — returned ${listCount} hotels.`
        : `Every parameter shape was rejected. ${listNotes.join(" | ")}`,
  });

  // 4. Map source
  // Use the same code path the map itself uses, so the check cannot disagree
  // with the feature.
  const t0 = Date.now();
  const osm = await hotelsNear(30.478, -87.209, 3000, 5);
  checks.push({
    name: "Map source (OpenStreetMap)",
    ok: osm.length > 0,
    detail:
      osm.length > 0
        ? `Responding in ${Date.now() - t0}ms, ${osm.length} sample hotels nearby.`
        : lastOverpassErrors.length > 0
          ? `Every Overpass mirror refused: ${lastOverpassErrors.join(" | ")}`
          : "No hotels found near the test point, and no mirror reported an error.",
  });

  // 5. Geocoding
  const geo = await timed(
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=Candlewood%20Suites%20Pensacola",
    { headers: { "User-Agent": "RateBeacon/1.0 (health check)" } }
  );
  checks.push({
    name: "Geocoding",
    ok: geo.ok,
    detail: geo.ok ? `Responding in ${geo.ms}ms.` : `HTTP ${geo.status}. ${geo.body.slice(0, 160)}`,
  });

  // 6. Mail reader (runs outside Vercel, which cannot open IMAP sockets)
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = await timed(`${url}/functions/v1/mailbox-fetch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        apikey: key ?? "",
      },
      body: JSON.stringify({ host: "", username: "", password: "" }),
    });
    // A 400 here means the function is deployed and validating input.
    const reachable = r.status === 400 || r.status === 200 || r.status === 502;
    checks.push({
      name: "Mail reader",
      ok: reachable,
      detail: reachable
        ? `Deployed and responding in ${r.ms}ms.`
        : `Not reachable (HTTP ${r.status}). ${r.body.slice(0, 140)}`,
    });
  } catch (e) {
    checks.push({ name: "Mail reader", ok: false, detail: (e as Error).message });
  }

  // 7. Coverage summary
  try {
    const [{ count: hotels }, { count: located }, { count: rated }, { count: places }] = await Promise.all([
      supa.from("hotels").select("hotel_id", { count: "exact", head: true }),
      supa.from("hotels").select("hotel_id", { count: "exact", head: true }).not("latitude", "is", null),
      supa.from("hotels").select("hotel_id", { count: "exact", head: true }).not("rating", "is", null),
      supa.from("map_places").select("id", { count: "exact", head: true }),
    ]);
    checks.push({
      name: "Coverage",
      ok: (located ?? 0) > 0,
      detail: `${hotels ?? 0} hotels tracked · ${located ?? 0} placed on the map · ${rated ?? 0} with a review score · ${places ?? 0} nearby map pins.`,
    });
  } catch (e) {
    checks.push({ name: "Coverage", ok: false, detail: (e as Error).message });
  }

  // 8. Tenant isolation
  //
  // Two accounts share one database, so the question that matters to a buyer
  // is whether the database itself refuses to hand one account another's rows
  // — not whether the application code remembers to filter. This probes it
  // rather than reporting configuration: it connects as a real account and
  // counts what that connection can see against what the service role can see.
  // A live policy shows the account its own rows and nothing else.
  try {
    const config = tenantConfig();
    if (!config.ready) {
      checks.push({
        name: "Tenant isolation",
        ok: false,
        detail: `Running on the service key, so row-level security is bypassed and separation depends on application filters alone. ${config.problem}`,
      });
    } else {
      const { data: accounts } = await supa
        .from("accounts")
        .select("id")
        .order("id")
        .limit(1)
        .returns<{ id: number }[]>();
      const accountId = accounts?.[0]?.id ?? null;

      const { count: total } = await supa
        .from("profiles")
        .select("id", { count: "exact", head: true });
      const { count: own } = accountId
        ? await supa
            .from("profiles")
            .select("id", { count: "exact", head: true })
            .eq("account_id", accountId)
        : { count: 0 };

      if (!accountId) {
        checks.push({
          name: "Tenant isolation",
          ok: false,
          detail: "No accounts exist yet, so there is nothing to test isolation against.",
        });
      } else {
        const scoped = await dbForAccount(accountId);
        const { count: visible, error } = await scoped
          .from("profiles")
          .select("id", { count: "exact", head: true });

        // The fallback is silent by design, so the check has to notice it.
        const stillFallingBack = tenantConfig().problem;
        if (error) {
          checks.push({
            name: "Tenant isolation",
            ok: false,
            detail: `The scoped connection was rejected: ${error.message}`,
          });
        } else if (stillFallingBack) {
          checks.push({
            name: "Tenant isolation",
            ok: false,
            detail: `Running on the service key. ${stillFallingBack}`,
          });
        } else if ((visible ?? 0) > (own ?? 0)) {
          checks.push({
            name: "Tenant isolation",
            ok: false,
            detail: `Account ${accountId} can see ${visible} profiles but owns only ${own}. Row-level security is not covering this table.`,
          });
        } else if ((total ?? 0) <= (own ?? 0)) {
          checks.push({
            name: "Tenant isolation",
            ok: true,
            detail: `Enforced by the database. Only one account exists, so there is no second tenant to be hidden from it yet — it sees its own ${visible} profiles.`,
          });
        } else {
          checks.push({
            name: "Tenant isolation",
            ok: true,
            detail: `Enforced by the database. Account ${accountId} sees its own ${visible} of ${total} profiles; the rest are invisible to it.`,
          });
        }
      }
    }
  } catch (e) {
    checks.push({ name: "Tenant isolation", ok: false, detail: (e as Error).message });
  }

  // 9. Rate collection
  //
  // The one check that answers "why is the grid empty?" — a day's collection
  // is thousands of upstream calls and runs in the background, so what matters
  // is whether it is progressing, not whether any single request worked.
  try {
    const target = await registerSchedulerTarget();
    const state = await hydrationState();
    const stale =
      state.status === "collecting" &&
      state.lastTickAt != null &&
      Date.now() - new Date(state.lastTickAt).getTime() > 20 * 60_000;

    checks.push({
      name: "Rate collection",
      ok: state.status === "complete" || (state.status === "collecting" && !stale),
      detail:
        state.status === "complete"
          ? `Today's collection finished: ${state.rowsWritten} prices across ${state.total} hotel-nights.`
          : state.status === "collecting"
            ? stale
              ? `Stalled at ${state.percent}% — the last slice ran ${new Date(state.lastTickAt as string).toLocaleTimeString()}. The scheduler calls ${target ?? "the deployment"} every five minutes; check CRON_SECRET matches on both sides.`
              : `In progress: ${state.percent}% of ${state.total} hotel-nights, ${state.rowsWritten} prices stored.`
            : `Not started today. The scheduler calls ${target ?? "the deployment"} every five minutes; it starts on the first tick.`,
    });
  } catch (e) {
    checks.push({ name: "Rate collection", ok: false, detail: (e as Error).message });
  }

  return NextResponse.json({ checkedAt: new Date().toISOString(), checks });
}
