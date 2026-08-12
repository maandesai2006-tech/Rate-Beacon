// Manager's-report parsing.
//
// Every PMS formats its report differently, so rather than target one vendor
// this reads the report as text (CSV, TSV, spreadsheet-exported text, an HTML
// email body, or extracted PDF text) and looks for labelled numbers. Anything
// unmatched is kept in raw_text so a later parser can do better without
// re-collecting the report.
//
// The layouts this is built against, taken from real reports:
//
//   IHG General Manager Report        Hilton Hotel Statistics
//   ─────────────────────────────     ──────────────────────────
//   Total Rooms 95 950 21,090         OCCUPANCY
//   Rooms Occupied 73 779 18,355      INCLUDING DOWN,
//   ADR $105.69 $107.26 $111.60       COMP, HOUSE USE
//   Occupancy 76.84 % 82.00 %         ROOMS
//                                     90.59 % 85.52 % 88.37 %
//
// Three things make these hard, and each is handled below:
//
//  1. Columns are separated by a *single* space, so splitting on runs of two
//     or more spaces yields one cell per line and finds nothing.
//  2. A label can wrap across up to five lines with its numbers on a later
//     line, so a line-at-a-time reader loses the label.
//  3. Every row carries Today, MTD and YTD side by side. Only the first
//     number is today's. Reading the wrong column silently reports the
//     month's figures as the night's.

export type MetricKey =
  | "occupancy"
  | "adr"
  | "revpar"
  | "rooms_sold"
  | "rooms_available"
  | "room_revenue"
  | "total_revenue"
  | "arrivals"
  | "departures"
  | "stayovers"
  | "no_shows"
  | "cancellations"
  | "out_of_order"
  | "group_rooms"
  | "comp_rooms"
  | "walk_ins"
  | "guests"
  | "other_revenue"
  | "early_departures"
  | "extended_stays"
  | "total_reservations"
  | "cash_variance"
  | "total_adjustments"
  | "direct_bill_transfers";

interface MetricSpec {
  key: MetricKey;
  label: string;
  unit: "percent" | "currency" | "count";
  aliases: string[];
}

// Aliases are matched case-insensitively against a normalised label. Order
// within a metric does not matter; order of *appearance in the report* does,
// because the first acceptable match for a metric wins.
export const METRICS: MetricSpec[] = [
  {
    key: "occupancy",
    label: "Occupancy",
    unit: "percent",
    aliases: [
      "occupancy", "occ", "occ %", "occupancy %", "occupancy percent", "occ pct",
      // Hilton prints the qualifier as part of the label.
      "occupancy including down comp house use rooms",
      "occupancy excluding down comp house use rooms",
    ],
  },
  {
    key: "adr",
    label: "ADR",
    unit: "currency",
    aliases: [
      "adr", "average daily rate", "avg daily rate", "average rate", "avg rate",
      "adr including comp house use rooms", "adr excluding comp house use rooms",
      "average room rate", "rate average",
    ],
  },
  {
    key: "revpar",
    label: "RevPAR",
    unit: "currency",
    aliases: ["revpar", "rev par", "revenue per available room"],
  },
  {
    key: "rooms_sold",
    label: "Rooms sold",
    unit: "count",
    aliases: [
      "rooms sold", "rms sold", "room sold", "occupied rooms", "rooms occupied",
      "sold rooms", "total occupied",
    ],
  },
  {
    key: "rooms_available",
    label: "Rooms available",
    unit: "count",
    // "Available Rooms" is deliberately absent: on an IHG report it means
    // rooms still *unsold* (Total 95 = Occupied 73 + Available 22), so
    // reading it as inventory yields a 331% occupancy. It is recovered
    // below only when nothing better is present.
    aliases: [
      "total rooms", "rooms in hotel", "room count", "inventory",
      "physical rooms", "total room count",
    ],
  },
  {
    key: "room_revenue",
    label: "Room revenue",
    unit: "currency",
    aliases: ["room revenue", "rooms revenue", "guest room revenue", "lodging revenue", "room rev"],
  },
  {
    key: "total_revenue",
    label: "Total revenue",
    unit: "currency",
    aliases: ["total revenue", "total rev", "grand total revenue", "total sales"],
  },
  {
    key: "arrivals",
    label: "Arrivals",
    unit: "count",
    aliases: ["arrivals", "number of arrivals", "arrivals today", "check ins", "checkins", "check-ins"],
  },
  {
    key: "departures",
    label: "Departures",
    unit: "count",
    aliases: ["departures", "number of departures", "check outs", "checkouts", "check-outs"],
  },
  {
    key: "stayovers",
    label: "Stayovers",
    unit: "count",
    aliases: ["stayovers", "stay overs", "in house", "inhouse", "continuing"],
  },
  {
    key: "no_shows",
    label: "No-shows",
    unit: "count",
    aliases: ["no shows", "no-shows", "noshow", "no show", "no show reservations"],
  },
  {
    key: "cancellations",
    label: "Cancellations",
    unit: "count",
    aliases: ["cancellations", "cancels", "cancelled", "canceled", "cancelled reservations"],
  },
  {
    key: "out_of_order",
    label: "Out of order",
    unit: "count",
    aliases: ["out of order", "ooo", "ooo rooms", "out of service", "oos", "oos rooms"],
  },
  {
    key: "group_rooms",
    label: "Group rooms",
    unit: "count",
    aliases: ["group rooms", "group block", "group rooms in house"],
  },
  {
    key: "comp_rooms",
    label: "Comp rooms",
    unit: "count",
    aliases: ["comp rooms", "complimentary rooms", "comps", "house rooms", "house use rooms"],
  },
  { key: "walk_ins", label: "Walk-ins", unit: "count", aliases: ["walk ins", "walk-ins", "walkins"] },
  {
    key: "guests",
    label: "Guests",
    unit: "count",
    aliases: ["guests", "total guests", "total in house guests", "pax"],
  },
  {
    key: "other_revenue",
    label: "Other revenue",
    unit: "currency",
    aliases: ["other revenue", "f&b revenue", "food and beverage", "misc revenue", "ancillary revenue"],
  },
  {
    key: "early_departures",
    label: "Early departures",
    unit: "count",
    aliases: ["early departures", "early outs", "early check outs", "early checkouts"],
  },
  {
    key: "extended_stays",
    label: "Extended stays",
    unit: "count",
    aliases: ["extended departures", "extended stays", "stay extensions", "extensions"],
  },
  {
    key: "total_reservations",
    label: "Reservations",
    unit: "count",
    aliases: ["total reservations", "reservations"],
  },
  {
    key: "cash_variance",
    label: "Cash over / short",
    unit: "currency",
    aliases: ["cash over short", "over short", "cash variance", "drawer variance", "cash over/short"],
  },
  {
    key: "total_adjustments",
    label: "Adjustments",
    unit: "currency",
    aliases: ["adjustments", "total adjustments", "allowances", "rebates", "refunds", "corrections"],
  },
  {
    key: "direct_bill_transfers",
    label: "Direct bill",
    unit: "currency",
    aliases: ["direct bill", "city ledger", "a/r transfer", "ar transfer", "transfer to a/r"],
  },
];

// A label carrying any of these is about a different column, a different day,
// a subtotal, or a per-person count — never the night's headline figure.
// Rejecting the whole row is safer than trying to salvage part of the label.
const DISQUALIFYING = [
  "tomorrow",
  "next",
  "last year",
  "ly-",
  "y-t-d",
  "m-t-d",
  "booked today",
  "same day",
  "per group",
  "average room revenue",
  "transient",
  "group block room",
  "group member",
  "individual",
  "persons",
  "adults",
  "children",
  "collected taxes",
  "excluding ooo",
  "with out of order",
  "extended stay departures",
  "travel agent",
  "company rooms",
  "zero rate",
  "dirty",
  "clean",
  "ready",
  "late cancellations",
  "arrival guests",
  "departing guests",
  "day use",
];

// Header and section lines. They carry no value and must not be glued onto
// the label of the row that follows them.
const STRUCTURAL = /actual\s+today|m-t-d|y-t-d|^\s*(type|description)\b|^page\s*\d|^\s*statistics\s*$/i;

function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_|]+/g, " ")
    .replace(/[^a-z0-9%&\s./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:\-\s]+$/, "");
}

// "$1,234.56" → 1234.56 · "78.5%" → 78.5 · "(120)" → -120 · "-$88.00" → -88
function parseNumber(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()]/g, "");
  s = s.replace(/[$£€,\s]/g, "").replace(/%$/, "").replace(/^-/, "");
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

export interface ExtractedMetric {
  metric: MetricKey;
  value: number;
  unit: string;
}

/** A row reduced to its label and the first (Today) number on it. */
interface Row {
  label: string;
  value: number;
}

// Split a physical line into its leading label text and its numbers. A cell
// separator of tab, comma, pipe or two-plus spaces is honoured when present,
// so CSV and fixed-width reports still work; otherwise single spaces are used.
function splitRow(rawLine: string): { label: string; numbers: number[] } {
  // Thousands separators must go before any comma split, or "$8,843.05"
  // becomes two cells and the metric reads as 8.
  const line = rawLine.replace(/(\d),(?=\d{3}(\D|$))/g, "$1");
  const delimited = /\t|,|\s{2,}|\|/.test(line);
  const tokens = delimited
    ? line.split(/\t|,|\s{2,}|\|/).map((c) => c.trim().replace(/^"|"$/g, "").trim()).filter(Boolean)
    : line.trim().split(/\s+/);

  const labelParts: string[] = [];
  const numbers: number[] = [];
  for (const token of tokens) {
    if (token === "%") continue; // "76.84 %" — the sign is its own token
    const n = parseNumber(token);
    if (n == null) {
      // Text appearing after the numbers have started is a footnote, not a
      // label; the row's identity is whatever preceded the first number.
      if (numbers.length === 0) labelParts.push(token);
    } else {
      numbers.push(n);
    }
  }
  return { label: normalizeLabel(labelParts.join(" ")), numbers };
}

// Turn the report into label/value rows, rejoining labels that wrapped.
function toRows(text: string): Row[] {
  const lines = text
    .replace(/<[^>]+>/g, "\t")
    .replace(/&nbsp;/gi, " ")
    .split(/[\r\n]+/);

  const rows: Row[] = [];
  let carried: string[] = [];

  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (STRUCTURAL.test(raw)) {
      carried = [];
      continue;
    }

    const { label, numbers } = splitRow(raw);

    if (numbers.length === 0) {
      // No numbers: this is a label, or part of one that continues below.
      if (label) carried.push(label);
      if (carried.length > 5) carried.shift();
      continue;
    }

    const full = [...carried, label].filter(Boolean).join(" ").trim();
    carried = [];
    if (!full) continue;
    // The Today column is the first number on the row.
    rows.push({ label: full, value: numbers[0] });
  }

  return rows;
}

function matchMetric(label: string): MetricKey | null {
  if (DISQUALIFYING.some((d) => label.includes(d))) return null;
  // Exact first, so "adr" never loses to a longer label that merely contains it.
  for (const spec of METRICS) {
    if (spec.aliases.some((a) => label === a)) return spec.key;
  }
  for (const spec of METRICS) {
    if (spec.aliases.some((a) => label.startsWith(`${a} `) || label.endsWith(` ${a}`))) {
      return spec.key;
    }
  }
  return null;
}

// Pull "label … number" pairs out of any line-oriented text.
export function extractMetrics(text: string): ExtractedMetric[] {
  const found = new Map<MetricKey, number>();
  // Kept aside rather than trusted: on some reports this is unsold rooms, on
  // others it is inventory. Only used when nothing better turned up, and only
  // if it is consistent with the rooms actually sold.
  let ambiguousAvailable: number | null = null;

  for (const row of toRows(text)) {
    if (ambiguousAvailable == null && /^(available rooms|rooms available|rooms avail)$/.test(row.label)) {
      ambiguousAvailable = row.value;
    }
    const key = matchMetric(row.label);
    if (!key || found.has(key)) continue;
    found.set(key, row.value);
  }

  // Occupancy sometimes arrives as a fraction (0.83) rather than a percent.
  const occ = found.get("occupancy");
  if (occ != null && occ > 0 && occ <= 1) found.set("occupancy", occ * 100);

  const sold = found.get("rooms_sold");

  // Recover inventory from the ambiguous label only when it is the *larger*
  // reading — i.e. it plainly is not the count of rooms left to sell.
  if (found.get("rooms_available") == null && ambiguousAvailable != null) {
    if (sold == null || ambiguousAvailable >= sold) {
      found.set("rooms_available", ambiguousAvailable);
    } else if (sold != null) {
      // Total = sold + still-available. This is the IHG reading.
      found.set("rooms_available", sold + ambiguousAvailable);
    }
  }

  // A stated inventory below the rooms sold is a misread label, not a fact.
  const avail = found.get("rooms_available");
  if (avail != null && sold != null && avail < sold) found.delete("rooms_available");

  // Derive what the report left out but implies.
  const available = found.get("rooms_available");
  const roomRev = found.get("room_revenue");
  if (found.get("occupancy") == null && sold != null && available) {
    found.set("occupancy", (sold / available) * 100);
  }
  if (found.get("adr") == null && roomRev != null && sold) {
    found.set("adr", roomRev / sold);
  }
  if (found.get("revpar") == null && roomRev != null && available) {
    found.set("revpar", roomRev / available);
  }

  return [...found.entries()].map(([metric, value]) => ({
    metric,
    value,
    unit: METRICS.find((m) => m.key === metric)!.unit,
  }));
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Business date: the night the audit covers.
 *
 * These reports carry two dates — "Date: Aug 10, 2026" (the night) and
 * "Report run date: Aug 11, 2026" (the morning it printed). Taking the wrong
 * one files every report a day late; taking neither files them all under
 * today, which collapses a whole mailbox onto a single row.
 */
export function extractReportDate(text: string, fallback: string): string {
  const labelled = [
    /(?:^|\n)\s*(?:business|audit|for|report)?\s*date\s*[:\-]\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4})/i,
    /(?:^|\n)\s*(?:business|audit|for|report)?\s*date\s*[:\-]\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /(?:^|\n)\s*(?:business|audit|for|report)?\s*date\s*[:\-]\s*(\d{4}-\d{2}-\d{2})/i,
  ];

  // A line beginning "Report run date" is when it printed, not what it covers.
  const cleaned = text.replace(/report\s+run\s+date\s*[:\-][^\n]*/gi, "");

  for (const re of labelled) {
    const m = cleaned.match(re);
    const iso = m ? toISO(m[1]) : null;
    if (iso) return iso;
  }

  // Nothing labelled — take the first date-shaped thing anywhere.
  for (const re of [
    /([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/,
    /(\d{4}-\d{2}-\d{2})/,
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
  ]) {
    const m = cleaned.match(re);
    const iso = m ? toISO(m[1]) : null;
    if (iso) return iso;
  }
  return fallback;
}

function toISO(s: string): string | null {
  const trimmed = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // "Aug 10, 2026" / "August 10 2026" / "Aug. 10, 26"
  const named = trimmed.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (named) {
    const month = MONTHS[named[1].slice(0, 3).toLowerCase()];
    const day = Number(named[2]);
    const yearRaw = Number(named[3]);
    const year = named[3].length === 2 ? 2000 + yearRaw : yearRaw;
    if (month && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return null;
  }

  const numeric = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!numeric) return null;
  const [, a, b, cRaw] = numeric;
  const year = cRaw.length === 2 ? 2000 + Number(cRaw) : Number(cRaw);
  // US ordering (month first) — the format these reports use.
  const month = Number(a);
  const day = Number(b);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Which tracked hotel does this report belong to? Matches the hotel's name,
// then distinctive words from it, against the report text and subject.
export function matchHotel(
  text: string,
  subject: string,
  hotels: { hotel_id: string; name: string }[]
): { hotelId: string; matchedBy: string } | null {
  const haystack = `${subject}\n${text}`.toLowerCase();
  const generic = new Set([
    "hotel", "inn", "suites", "suite", "motel", "by", "the", "and", "at", "of",
    "resort", "express", "area", "north", "south", "east", "west", "downtown",
  ]);

  let best: { hotelId: string; matchedBy: string; score: number; hits: number } | null = null;
  for (const h of hotels) {
    const name = h.name.toLowerCase();
    if (haystack.includes(name)) {
      return { hotelId: h.hotel_id, matchedBy: `full name "${h.name}"` };
    }
    const words = name
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !generic.has(w));
    if (words.length === 0) continue;
    const hits = words.filter((w) => haystack.includes(w));
    const score = hits.length / words.length;
    if (score < 0.6) continue;

    // A one-word name like "Destin Inn & Suites" scores a perfect 1.0 against
    // any Destin report, and would beat a four-word name that also matched
    // perfectly. Break ties on the number of distinctive words actually
    // matched, so the more specific name wins.
    const better =
      !best || hits.length > best.hits || (hits.length === best.hits && score > best.score);
    if (better) {
      best = {
        hotelId: h.hotel_id,
        matchedBy: `keywords ${hits.join(", ")}`,
        score,
        hits: hits.length,
      };
    }
  }
  return best ? { hotelId: best.hotelId, matchedBy: best.matchedBy } : null;
}
