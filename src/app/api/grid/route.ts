import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { addDaysISO, dateRange, todayISO, weekdayOf } from "@/lib/dates";
import { adviceFor, demandScore, median, positionOf } from "@/lib/insights";
import { getHolidays, getWeather } from "@/lib/signals";
import type {
  GridResponse,
  GridRow,
  Hotel,
  Profile,
  Quote,
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
    const profileId = Number(req.nextUrl.searchParams.get("profileId")) || null;
    return await buildGrid(profileId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

async function buildGrid(profileId: number | null) {
  const supa = db();
  const today = todayISO();

  let profileQuery = supa.from("profiles").select("*").order("id").limit(1);
  if (profileId) profileQuery = supa.from("profiles").select("*").eq("id", profileId).limit(1);
  const profileRes = await profileQuery.maybeSingle<Profile>();
  if (profileRes.error) throw new Error(`Database query failed: ${profileRes.error.message}`);
  const profile = profileRes.data;
  if (!profile) return NextResponse.json({ configured: false });

  const linksRes = await supa
    .from("profile_hotels")
    .select("hotel_id, is_mine, hotels(name, rating, review_count)")
    .eq("profile_id", profile.id)
    .returns<
      {
        hotel_id: string;
        is_mine: boolean;
        hotels: { name: string; rating: number | null; review_count: number | null } | null;
      }[]
    >();
  if (linksRes.error) throw new Error(`Database query failed: ${linksRes.error.message}`);
  const hotels: Hotel[] = (linksRes.data ?? []).map((l) => ({
    hotel_id: l.hotel_id,
    name: l.hotels?.name ?? l.hotel_id,
    is_mine: l.is_mine,
    rating: l.hotels?.rating ?? null,
    review_count: l.hotels?.review_count ?? null,
  }));
  if (hotels.length === 0) return NextResponse.json({ configured: false });

  const hotelIds = hotels.map((h) => h.hotel_id);
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

  const rows: GridRow[] = dateRange(today, profile.horizon_days).map((date) => {
    const cells: Record<string, RateCell> = {};
    for (const h of hotels) {
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

  const payload: GridResponse & { configured: boolean } = {
    configured: true,
    profile,
    hotels,
    rows,
    weekdayAvg,
    lastCapturedAt: lastCapRes.data?.[0]?.captured_at ?? null,
  };
  return NextResponse.json(payload);
}
