// The assistant that sits inside the dashboard.
//
// Two rules decide the whole design.
//
// It never states a number it was not given. Every figure it can say comes
// back from one of the tools below, which read the database and the same feeds
// the screens read; the model's job is to choose which question to ask and to
// put the answer into a sentence. A revenue manager who catches an invented
// figure will not trust the product again, and hotels talk to each other.
//
// It cannot reach another customer's data. The tools are handed the
// account-scoped connection, so Postgres itself refuses rows belonging to
// anyone else — the assistant is inside the same wall as the rest of the app,
// not beside it with a service key. A prompt asking it to "show me every
// hotel's occupancy" returns this account's, because that is all the
// connection can see.
//
// Everything it does — read rates, read reports, search for neighbours, add a
// competitor — is a tool the operator could have used by hand. It is a faster
// way to drive the product, not a second product with its own opinions.

import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DAILY_METRIC_COLUMNS } from "./daily-reports";
import { anchorForProfile, searchNearby, DEFAULT_RADIUS_MILES } from "./compset";
import { verifyHotelKey } from "./xotelo";
import { airportTraffic, nearestAirport, trendOf } from "./flights";
import { getHolidays, getWeather } from "./signals";

export interface AssistantTurn {
  role: "user" | "model";
  text: string;
}

export interface AssistantContext {
  supa: SupabaseClient;
  shared: SupabaseClient;
  profileId: number;
  baselineHotelId: string | null;
}

export interface AssistantReply {
  text: string;
  /** Which tools ran, so the operator can see what it looked at. */
  used: string[];
  /** True when the reply changed something rather than only reading. */
  changed: boolean;
}

const SYSTEM = `You are the assistant inside Rate Beacon, a rate-intelligence dashboard used by hotel revenue managers and owners.

How you answer:
- Every number you state must come from a tool result in this conversation. Never estimate, never recall a figure from training, never fill a gap with a plausible value. If a tool did not return it, say you do not have it.
- Call tools before answering questions about rates, reports, competitors, weather or demand. Do not answer from memory.
- Be brief and concrete. A revenue manager wants "You are $12 under the market for Friday, and the market rose 8% this week", not a paragraph of hedging.
- Money in the property's own currency, to the nearest dollar. Percentages to the nearest whole number.
- When something looks wrong in the data — a flagged outlier, a hotel with no rates — say so plainly rather than working around it.
- You may add competitors when asked, but only ones a search returned. Confirm what you added and what was refused.
- If asked something the product does not know (guest reviews, booking pace from a PMS, next year's events), say it is not something Rate Beacon collects.`;

const TOOLS: FunctionDeclaration[] = [
  {
    name: "market_summary",
    description:
      "Rates and the pricing call for upcoming nights: your price, the market median, the gap, demand and any flagged outliers. Use for anything about pricing, the compset, or how a night looks.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        nights: { type: Type.NUMBER, description: "How many nights ahead, from tonight. Default 14, max 60." },
      },
    },
  },
  {
    name: "report_summary",
    description:
      "Manager's report figures for recent nights — occupancy, ADR, RevPAR and what the fifteen rules flagged. Use for questions about performance, occupancy or the night audit.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        nights: { type: Type.NUMBER, description: "How many recent report nights. Default 14, max 60." },
      },
    },
  },
  {
    name: "conditions",
    description:
      "Weather forecast, public holidays and airport traffic near the property. Use for questions about weather, demand drivers or whether the market is filling up.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "find_hotels",
    description:
      "Search for hotels near the property that could join the competitive set. Returns which ones the rate feed can follow. Use before adding any competitor.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Optional name to match, e.g. 'Hampton'. Omit to list everything nearby." },
        radiusMiles: { type: Type.NUMBER, description: "Search radius. Default is the profile's own setting." },
      },
    },
  },
  {
    name: "add_competitors",
    description:
      "Add hotels to the competitive set. Only pass hotel keys returned by find_hotels. Each is checked against the rate feed and refused if it cannot be priced.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        hotelKeys: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "TripAdvisor keys like g34550-d10637341, from find_hotels.",
        },
      },
      required: ["hotelKeys"],
    },
  },
];

/** One turn: the model may call tools, and answers from what they return. */
export async function askAssistant(
  ctx: AssistantContext,
  history: AssistantTurn[],
  question: string
): Promise<AssistantReply> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return {
      text: "The assistant needs a Gemini key on the deployment (GEMINI_API_KEY). Everything else on the dashboard works without it.",
      used: [],
      changed: false,
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const contents = [
    ...history.slice(-8).map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: "user" as const, parts: [{ text: question }] },
  ];

  const used: string[] = [];
  let changed = false;

  // Three rounds is enough for "search, then add, then say what happened", and
  // bounds what one question can cost.
  for (let round = 0; round < 3; round++) {
    const res = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
      contents,
      config: {
        systemInstruction: SYSTEM,
        temperature: 0.2,
        tools: [{ functionDeclarations: TOOLS }],
      },
    });

    const calls = res.functionCalls ?? [];
    if (calls.length === 0) {
      return { text: res.text?.trim() || "I could not work that out.", used, changed };
    }

    contents.push({
      role: "model",
      parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) as never,
    });

    const replies: unknown[] = [];
    for (const call of calls) {
      used.push(call.name ?? "unknown");
      const result = await runTool(ctx, call.name ?? "", (call.args ?? {}) as Record<string, unknown>);
      if (call.name === "add_competitors") changed = true;
      replies.push({ functionResponse: { name: call.name, response: { result } } });
    }
    contents.push({ role: "user", parts: replies as never });
  }

  return {
    text: "That needed more steps than I can take in one go. Try asking for one thing at a time.",
    used,
    changed,
  };
}

async function runTool(
  ctx: AssistantContext,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const nights = Math.min(60, Math.max(1, Number(args.nights) || 14));

  switch (name) {
    case "market_summary":
      return marketSummary(ctx, nights);
    case "report_summary":
      return reportSummary(ctx, nights);
    case "conditions":
      return conditions(ctx);
    case "find_hotels":
      return findHotels(ctx, String(args.query ?? ""), Number(args.radiusMiles) || null);
    case "add_competitors":
      return addCompetitors(ctx, Array.isArray(args.hotelKeys) ? args.hotelKeys.map(String) : []);
    default:
      return { error: `No tool called ${name}.` };
  }
}

async function marketSummary(ctx: AssistantContext, nights: number) {
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + nights * 86400e3).toISOString().slice(0, 10);

  const { data: links } = await ctx.supa
    .from("profile_hotels")
    .select("hotel_id, is_mine")
    .eq("profile_id", ctx.profileId)
    .returns<{ hotel_id: string; is_mine: boolean }[]>();

  const mineId = ctx.baselineHotelId ?? (links ?? []).find((l) => l.is_mine)?.hotel_id ?? null;
  const compIds = (links ?? []).filter((l) => !l.is_mine).map((l) => l.hotel_id);
  const ids = [...compIds, ...(mineId ? [mineId] : [])];
  if (ids.length === 0) return { note: "No hotels are tracked on this profile yet." };

  const [{ data: rates }, { data: names }, { data: overrides }] = await Promise.all([
    ctx.supa
      .from("latest_rates")
      .select("hotel_id, check_in, price, available, is_anomaly")
      .in("hotel_id", ids)
      .gte("check_in", today)
      .lte("check_in", end)
      .returns<{ hotel_id: string; check_in: string; price: number | null; available: boolean; is_anomaly: boolean | null }[]>(),
    ctx.shared.from("hotels").select("hotel_id, name").in("hotel_id", ids).returns<{ hotel_id: string; name: string }[]>(),
    ctx.supa
      .from("my_rates")
      .select("check_in, price")
      .eq("profile_id", ctx.profileId)
      .gte("check_in", today)
      .returns<{ check_in: string; price: number }[]>(),
  ]);

  const nameOf = new Map((names ?? []).map((h) => [h.hotel_id, h.name]));
  const manual = new Map((overrides ?? []).map((r) => [r.check_in, Number(r.price)]));
  const byDate = new Map<string, { comps: number[]; flagged: number; mine: number | null }>();

  for (const r of rates ?? []) {
    const bucket = byDate.get(r.check_in) ?? { comps: [], flagged: 0, mine: null };
    if (r.hotel_id === mineId) {
      bucket.mine = r.available && r.price != null ? Number(r.price) : null;
    } else if (r.available && r.price != null) {
      if (r.is_anomaly) bucket.flagged++;
      else bucket.comps.push(Number(r.price));
    }
    byDate.set(r.check_in, bucket);
  }

  const rows = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, b]) => {
      const sorted = [...b.comps].sort((x, y) => x - y);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null;
      const mine = manual.get(date) ?? b.mine;
      return {
        date,
        yourRate: mine,
        marketMedian: median,
        gapPct: mine != null && median ? Math.round(((mine - median) / median) * 100) : null,
        competitorsPriced: sorted.length,
        flaggedOutliers: b.flagged,
      };
    });

  return {
    yourHotel: mineId ? (nameOf.get(mineId) ?? mineId) : null,
    competitors: compIds.map((id) => nameOf.get(id) ?? id),
    nights: rows,
  };
}

async function reportSummary(ctx: AssistantContext, nights: number) {
  const since = new Date(Date.now() - nights * 86400e3).toISOString().slice(0, 10);
  const cols = ["report_date", "hotel_id", ...DAILY_METRIC_COLUMNS].join(", ");

  const { data: reports } = await ctx.supa
    .from("daily_manager_reports")
    .select(cols)
    .eq("profile_id", ctx.profileId)
    .gte("report_date", since)
    .order("report_date", { ascending: false })
    .limit(60)
    .returns<Record<string, unknown>[]>();

  if (!reports?.length) {
    return { note: "No manager's reports have been filed for this profile in that window." };
  }

  const ids = reports.map((r) => r.id).filter(Boolean);
  const { data: flags } = ids.length
    ? await ctx.supa
        .from("daily_insights")
        .select("report_id, message, severity")
        .in("report_id", ids as number[])
        .returns<{ report_id: number; message: string; severity: string }[]>()
    : { data: [] as { report_id: number; message: string; severity: string }[] };

  return {
    nights: reports.map((r) => ({
      date: r.report_date,
      occupancyPct: r.occupancy_pct ?? null,
      adr: r.adr ?? null,
      revpar: r.revpar ?? null,
      roomsSold: r.rooms_sold ?? null,
    })),
    flags: (flags ?? []).map((f) => ({ message: f.message, severity: f.severity })),
  };
}

async function conditions(ctx: AssistantContext) {
  const { anchor } = await anchorForProfile(ctx.supa, ctx.profileId, {
    shared: ctx.shared,
    baselineHotelId: ctx.baselineHotelId,
  });
  if (!anchor) return { note: "The property has no position yet, so conditions cannot be read." };

  const [weather, holidays] = await Promise.all([
    getWeather(anchor.latitude, anchor.longitude),
    getHolidays("US", [new Date().getFullYear()]),
  ]);

  let flights: unknown = { note: "No airport found near the property." };
  if (anchor.baselineHotelId) {
    const airport = await nearestAirport(ctx.shared, anchor.baselineHotelId, anchor.latitude, anchor.longitude);
    if (airport) {
      const series = await airportTraffic(ctx.shared, airport.icao, 14);
      const { changePct } = trendOf(series, "day");
      flights = {
        airport: `${airport.name} (${airport.icao})`,
        milesAway: Math.round(airport.distanceMiles),
        recentDays: series.slice(-7),
        arrivalsChangePctVsPreviousDay: changePct == null ? null : Math.round(changePct),
        caveat: "Counts of flights seen by community receivers, not passengers. The change matters, not the absolute number.",
      };
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  return {
    town: anchor.cityName,
    weather: [...weather.entries()]
      .filter(([date]) => date >= today)
      .slice(0, 10)
      .map(([date, w]) => ({ date, highF: w.tMax, lowF: w.tMin, precipChancePct: w.precipProb, summary: w.label })),
    upcomingHolidays: holidays.filter((h) => h.date >= today).slice(0, 5),
    airportTraffic: flights,
  };
}

async function findHotels(ctx: AssistantContext, query: string, radiusMiles: number | null) {
  const { anchor, error } = await anchorForProfile(ctx.supa, ctx.profileId, {
    shared: ctx.shared,
    baselineHotelId: ctx.baselineHotelId,
  });
  if (!anchor) return { error };

  const results = await searchNearby(ctx.supa, ctx.profileId, anchor, {
    query,
    radiusMiles: radiusMiles ?? DEFAULT_RADIUS_MILES,
    limit: 25,
  });

  return {
    measuredFrom: { hotel: anchor.baselineHotelId, address: anchor.address, town: anchor.cityName },
    hotels: results.map((r) => ({
      hotelKey: r.hotelKey,
      name: r.name,
      milesAway: r.distanceMiles == null ? null : Math.round(r.distanceMiles * 10) / 10,
      canBePriced: r.priceable,
      alreadyTracked: r.alreadyTracked,
    })),
  };
}

async function addCompetitors(ctx: AssistantContext, hotelKeys: string[]) {
  const wanted = hotelKeys.filter((k) => /^g\d+-d\d+$/i.test(k)).slice(0, 10);
  if (wanted.length === 0) return { error: "No valid hotel keys were given." };

  const added: string[] = [];
  const refused: { hotelKey: string; reason: string }[] = [];

  for (const key of wanted) {
    const verdict = await verifyHotelKey(key);
    if (verdict.verdict !== "priceable") {
      refused.push({ hotelKey: key, reason: verdict.detail });
      continue;
    }
    const { error } = await ctx.supa.from("profile_hotels").upsert(
      { profile_id: ctx.profileId, hotel_id: key, is_mine: false, role: "comp" },
      { onConflict: "profile_id,hotel_id", ignoreDuplicates: true }
    );
    if (error) {
      refused.push({ hotelKey: key, reason: error.message });
      continue;
    }
    if (ctx.baselineHotelId) {
      await ctx.supa.from("baseline_comps").upsert(
        {
          profile_id: ctx.profileId,
          baseline_hotel_id: ctx.baselineHotelId,
          comp_hotel_id: key,
          discovered_at: new Date().toISOString(),
        },
        { onConflict: "profile_id,baseline_hotel_id,comp_hotel_id", ignoreDuplicates: true }
      );
    }
    added.push(key);
  }

  return {
    added,
    refused,
    note: added.length ? "Their rates collect on the next run." : "Nothing was added.",
  };
}
