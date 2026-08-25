import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { addDaysISO, dateRange, todayISO, weekdayOf } from "@/lib/dates";
import { adviceFor, demandScore, median, positionOf } from "@/lib/insights";
import { getHolidays, getWeather } from "@/lib/signals";
import type {
  Baseline,
  GridResponse,
  GridRow,
  Hotel,
  Profile,
  Quote,
  RankStat,
  RateCell,
  RowSignals,
} from "@/lib/types";

export const dynamic = "force-dynamic";

interface SnapshotRow {
  hotel_id: string;
  check_in: string;
  captured_on: string;
  price: number | null;
  price_low: number | null;
  rate_source: string | null;
  offers: Quote[] | null;
  available: boolean;
  captured_at?: string;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
    if (!auth.ok) return auth.response;
    const { accountId, supa } = auth;
    const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;
    const baselineId = req.nextUrl.searchParams.get("baselineId");
    return await buildGrid(supa, profileId, baselineId, accountId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

async function buildGrid(
  supa: SupabaseClient,
  profileId: number | null,
  baselineIdParam: string | null,
  accountId: number
) {
  const today = todayISO();

  let profileQuery = supa
    .from("profiles")
    .select("*")
    .eq("account_id", accountId)
    .order("id")
    .limit(1);
  if (profileId) {
    profileQuery = supa
      .from("profiles")
      .select("*")
      .eq("account_id", accountId)
      .eq("id", profileId)
      .limit(1);
  }
  const profileRes = await profileQuery.maybeSingle<Profile>();
  if (profileRes.error) throw new Error(`Database query failed: ${profileRes.error.message}`);
  const profile = profileRes.data;
  if (!profile) return NextResponse.json({ configured: false });

  type HotelRow = {
    name: string;
    rating: number | null;
    review_count: number | null;
    latitude: number | null;
    longitude: number | null;
  };
  const [linksRes, compsRes] = await Promise.all([
    supa
      .from("profile_hotels")
      .select("hotel_id, is_mine, role, hotels(name, rating, review_count, latitude, longitude)")
      .eq("profile_id", profile.id)
      .returns<{ hotel_id: string; is_mine: boolean; role: string; hotels: HotelRow | null }[]>(),
    supa
      .from("baseline_comps")
      .select("baseline_hotel_id, comp_hotel_id")
      .eq("profile_id", profile.id)
      .returns<{ baseline_hotel_id: string; comp_hotel_id: string }[]>(),
  ]);
  if (linksRes.error) throw new Error(`Database query failed: ${linksRes.error.message}`);

  const roleById = new Map((linksRes.data ?? []).map((l) => [l.hotel_id, l.role]));
  const allTracked: Hotel[] = (linksRes.data ?? []).map((l) => ({
    hotel_id: l.hotel_id,
    name: l.hotels?.name ?? l.hotel_id,
    is_mine: l.is_mine,
    rating: l.hotels?.rating ?? null,
    review_count: l.hotels?.review_count ?? null,
    latitude: l.hotels?.latitude ?? null,
    longitude: l.hotels?.longitude ?? null,
  }));
  if (allTracked.length === 0) return NextResponse.json({ configured: false });

  // Competitor sets per baseline; they may overlap.
  const compsByBaseline = new Map<string, string[]>();
  for (const c of compsRes.data ?? []) {
    const list = compsByBaseline.get(c.baseline_hotel_id) ?? [];
    list.push(c.comp_hotel_id);
    compsByBaseline.set(c.baseline_hotel_id, list);
  }

  const baselines: Baseline[] = allTracked
    .filter((h) => h.is_mine)
    .map((h) => ({
      hotel_id: h.hotel_id,
      name: h.name,
      compCount: compsByBaseline.get(h.hotel_id)?.length ?? 0,
    }));

  const activeBaselineId =
    (baselineIdParam && baselines.some((b) => b.hotel_id === baselineIdParam)
      ? baselineIdParam
      : baselines[0]?.hotel_id) ?? null;

  // The grid shows the active baseline plus its own discovered competitor
  // set. Before discovery has run there are no edges; fall back to tracked
  // hotels in the SAME TripAdvisor location only — never the whole profile,
  // which would mix unrelated markets (e.g. Destin under a Pensacola hotel).
  const baselineLocation = activeBaselineId ? activeBaselineId.split("-")[0] : null;
  const compIds =
    activeBaselineId && (compsByBaseline.get(activeBaselineId)?.length ?? 0) > 0
      ? (compsByBaseline.get(activeBaselineId) as string[])
      : allTracked
          .filter(
            (h) =>
              h.hotel_id !== activeBaselineId &&
              !h.is_mine &&
              h.hotel_id.split("-")[0] === baselineLocation
          )
          .map((h) => h.hotel_id);
  const compIdSet = new Set(compIds);
  const compsAreDiscovered = (compsByBaseline.get(activeBaselineId ?? "")?.length ?? 0) > 0;

  const byId = new Map(allTracked.map((h) => [h.hotel_id, h]));
  // Which of the columns are hotels this operator also owns. is_mine stays
  // reserved for the single baseline the grid's arithmetic is built around,
  // so the fact is carried separately rather than overloaded onto it.
  const ownedIds = new Set(baselines.map((b) => b.hotel_id));
  const hotels: Hotel[] = [
    ...(activeBaselineId && byId.has(activeBaselineId)
      ? [{ ...(byId.get(activeBaselineId) as Hotel), is_mine: true, is_portfolio: false }]
      : []),
    ...allTracked
      .filter((h) => compIdSet.has(h.hotel_id) && h.hotel_id !== activeBaselineId)
      .map((h) => ({ ...h, is_mine: false, is_portfolio: ownedIds.has(h.hotel_id) })),
  ];

  // Map context: located hotels in the profile that aren't in the grid. They
  // carry prices for the map only and never affect the median or advice.
  const gridIds = new Set(hotels.map((h) => h.hotel_id));
  const mapExtras: Hotel[] = allTracked.filter(
    (h) =>
      !gridIds.has(h.hotel_id) &&
      roleById.get(h.hotel_id) === "map" &&
      h.latitude != null &&
      h.longitude != null
  );

  const hotelIds = [...gridIds, ...mapExtras.map((h) => h.hotel_id)];
  const horizonEnd = addDaysISO(today, profile.horizon_days);
  const [latestRes, histRes, myRatesRes, lastCapRes] = await Promise.all([
    supa
      .from("latest_rates")
      .select("*")
      .in("hotel_id", hotelIds)
      .gte("check_in", today)
      .lt("check_in", horizonEnd)
      .returns<SnapshotRow[]>(),
    // Recent history for momentum: snapshots captured in the last 14 days.
    supa
      .from("rate_snapshots")
      .select("hotel_id, check_in, captured_on, price, available")
      .in("hotel_id", hotelIds)
      .gte("check_in", today)
      .lt("check_in", horizonEnd)
      .gte("captured_on", addDaysISO(today, -14))
      .returns<SnapshotRow[]>(),
    supa
      .from("my_rates")
      .select("check_in, price")
      .eq("profile_id", profile.id)
      .gte("check_in", today)
      .lt("check_in", horizonEnd),
    supa
      .from("rate_snapshots")
      .select("captured_at")
      .order("captured_at", { ascending: false })
      .limit(1),
  ]);

  const { data: mapPlaceRows } = await supa
    .from("map_places")
    .select("osm_id, name, latitude, longitude, distance_km, hotel_id")
    .eq("profile_id", profile.id)
    .eq("baseline_hotel_id", activeBaselineId ?? "")
    .order("distance_km");

  // External demand signals (all best-effort).
  const horizonYears = [...new Set([today, horizonEnd].map((d) => Number(d.slice(0, 4))))];
  const [holidays, weather, eventsRes] = await Promise.all([
    getHolidays(profile.country_code || "US", horizonYears),
    profile.latitude != null && profile.longitude != null
      ? getWeather(profile.latitude, profile.longitude)
      : Promise.resolve(new Map()),
    supa
      .from("events")
      .select("event_date, name")
      .eq("profile_id", profile.id)
      .gte("event_date", today)
      .lt("event_date", horizonEnd)
      .order("event_date"),
  ]);
  const holidayByDate = new Map(holidays.map((h) => [h.date, h.name]));
  const eventsByDate = new Map<string, string[]>();
  for (const e of (eventsRes.data ?? []) as { event_date: string; name: string }[]) {
    const list = eventsByDate.get(e.event_date) ?? [];
    list.push(e.name);
    eventsByDate.set(e.event_date, list);
  }

  const latest = latestRes.data ?? [];
  const hist = histRes.data ?? [];
  const myManual = new Map(
    (myRatesRes.data ?? []).map((r: { check_in: string; price: number | null }) => [
      r.check_in,
      r.price,
    ])
  );

  const latestByKey = new Map<string, SnapshotRow>();
  for (const r of latest) latestByKey.set(`${r.hotel_id}|${r.check_in}`, r);

  // Oldest capture within the window per (hotel, date) for momentum.
  const oldestByKey = new Map<string, SnapshotRow>();
  for (const r of hist) {
    const k = `${r.hotel_id}|${r.check_in}`;
    const prev = oldestByKey.get(k);
    if (!prev || r.captured_on < prev.captured_on) oldestByKey.set(k, r);
  }

  const myHotel = hotels.find((h) => h.is_mine) ?? null;
  const comps = hotels.filter((h) => !h.is_mine);

  // Ladder standing: rank by price (1 = most expensive) per night, comparing
  // the latest capture with the one before it for a day-over-day move, plus a
  // mean position across the next 30 nights.
  const capturesByKey = new Map<string, SnapshotRow[]>();
  for (const r of hist) {
    const k = `${r.hotel_id}|${r.check_in}`;
    const list = capturesByKey.get(k) ?? [];
    list.push(r);
    capturesByKey.set(k, list);
  }
  function ranksFor(date: string, pick: (rows: SnapshotRow[]) => SnapshotRow | undefined) {
    const priced = hotels
      .map((h) => {
        const rows = (capturesByKey.get(`${h.hotel_id}|${date}`) ?? [])
          .slice()
          .sort((a, b) => a.captured_on.localeCompare(b.captured_on));
        const snap = pick(rows);
        return snap?.available && snap.price != null
          ? { id: h.hotel_id, price: snap.price }
          : null;
      })
      .filter((x): x is { id: string; price: number } => x != null)
      .sort((a, b) => b.price - a.price);
    const map = new Map<string, number>();
    priced.forEach((p, i) => map.set(p.id, i + 1));
    return map;
  }

  const rows: GridRow[] = dateRange(today, profile.horizon_days).map((date) => {
    const cells: Record<string, RateCell> = {};
    // Map-context hotels get cells too so the map can show their prices;
    // they are excluded from the competitor stats below.
    for (const h of [...hotels, ...mapExtras]) {
      const s = latestByKey.get(`${h.hotel_id}|${date}`);
      cells[h.hotel_id] = {
        price: s?.price ?? null,
        priceLow: s?.price_low ?? s?.price ?? null,
        source: s?.rate_source ?? null,
        direct: s?.rate_source?.includes("(direct)") ?? false,
        offers: s?.offers ?? [],
        available: s ? s.available : true,
        capturedOn: s?.captured_on ?? null,
      };
    }

    const compPrices = comps
      .map((h) => cells[h.hotel_id])
      .filter((c) => c.available && c.price != null)
      .map((c) => c.price as number);
    const soldOutCount = comps.filter((h) => {
      const c = cells[h.hotel_id];
      return c.capturedOn != null && !c.available;
    }).length;

    const mkt = median(compPrices);

    const oldPrices = comps
      .map((h) => oldestByKey.get(`${h.hotel_id}|${date}`))
      .filter(
        (s): s is SnapshotRow =>
          s != null && s.available && s.price != null &&
          s.captured_on < (latestByKey.get(`${s.hotel_id}|${date}`)?.captured_on ?? "")
      )
      .map((s) => s.price as number);
    const oldMkt = median(oldPrices);
    const momentumPct =
      mkt != null && oldMkt != null && oldMkt > 0
        ? ((mkt - oldMkt) / oldMkt) * 100
        : null;

    const manual = myManual.get(date) ?? null;
    const live =
      myHotel && cells[myHotel.hotel_id]?.available
        ? cells[myHotel.hotel_id].price
        : null;
    const myPrice = manual ?? live;
    const myPriceSource = manual != null ? "manual" : live != null ? "live" : null;

    const demand = demandScore(soldOutCount, comps.length, momentumPct);
    const position = positionOf(myPrice, mkt);

    // Booking pace: sold-out comps now vs the oldest capture in the window,
    // computed over comps that have both readings.
    let oldSold = 0;
    let nowSoldAmongOld = 0;
    let paced = 0;
    for (const h of comps) {
      const oldSnap = oldestByKey.get(`${h.hotel_id}|${date}`);
      const nowSnap = latestByKey.get(`${h.hotel_id}|${date}`);
      if (!oldSnap || !nowSnap || oldSnap.captured_on >= nowSnap.captured_on) continue;
      paced++;
      if (!oldSnap.available) oldSold++;
      if (!nowSnap.available) nowSoldAmongOld++;
    }
    const paceDelta = paced > 0 ? nowSoldAmongOld - oldSold : null;

    // Parity: is an OTA undercutting the baseline hotel's brand-site rate?
    let parity: RowSignals["parity"] = null;
    if (myHotel) {
      const mc = cells[myHotel.hotel_id];
      if (mc.direct && mc.price != null && mc.offers.length > 0) {
        const cheapest = mc.offers[0];
        if (cheapest.total < mc.price - 1) {
          parity = { undercut: mc.price - cheapest.total, by: cheapest.name };
        }
      }
    }

    const holiday = holidayByDate.get(date) ?? null;
    const nearHoliday =
      holiday != null ||
      holidayByDate.has(addDaysISO(date, 1)) ||
      holidayByDate.has(addDaysISO(date, -1));
    const dayEvents = eventsByDate.get(date) ?? [];

    const signals: RowSignals = {
      holiday,
      nearHoliday,
      weather: weather.get(date) ?? null,
      eventCount: dayEvents.length,
      topEvents: dayEvents.slice(0, 3),
      paceDelta,
      parity,
    };

    return {
      date,
      cells,
      myPrice,
      myPriceSource,
      median: mkt,
      min: compPrices.length ? Math.min(...compPrices) : null,
      max: compPrices.length ? Math.max(...compPrices) : null,
      compCount: compPrices.length,
      soldOutCount,
      demand,
      momentumPct,
      position,
      advice: adviceFor(position, demand),
      signals,
    };
  });

  const weekdayAvg = Array.from({ length: 7 }, (_, weekday) => {
    const meds = rows
      .filter((r) => weekdayOf(r.date) === weekday && r.median != null)
      .map((r) => r.median as number);
    return { weekday, avgMedian: meds.length ? median(meds) : null };
  });

  // Tonight's ladder, the previous capture's ladder, and the 30-night mean.
  const rankToday = ranksFor(today, (rows) => rows[rows.length - 1]);
  const rankPrev = ranksFor(today, (rows) => (rows.length >= 2 ? rows[rows.length - 2] : undefined));
  const next30 = dateRange(today, Math.min(30, profile.horizon_days));
  const ranksPerDate = next30.map((d) => ranksFor(d, (rows) => rows[rows.length - 1]));

  const rankStats: RankStat[] = hotels.map((h) => {
    const now = rankToday.get(h.hotel_id) ?? null;
    const before = rankPrev.get(h.hotel_id) ?? null;
    const positions = ranksPerDate
      .map((m) => m.get(h.hotel_id))
      .filter((v): v is number => v != null);
    return {
      hotel_id: h.hotel_id,
      rankToday: now,
      // Ladder is most-expensive-first, so a smaller number is higher up.
      rankDelta: now != null && before != null ? before - now : null,
      avgRank30: positions.length
        ? positions.reduce((a, b) => a + b, 0) / positions.length
        : null,
      pricedCount: rankToday.size,
    };
  });

  const payload: GridResponse & { configured: boolean } = {
    configured: true,
    profile,
    baselines,
    activeBaselineId,
    compsAreDiscovered,
    rankStats,
    hotels,
    mapHotels: mapExtras,
    mapPlaces: mapPlaceRows ?? [],
    rows,
    weekdayAvg,
    lastCapturedAt: lastCapRes.data?.[0]?.captured_at ?? null,
  };
  return NextResponse.json(payload);
}
