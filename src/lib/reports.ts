// Manager's-report parsing.
//
// Every PMS formats its report differently, so rather than target one vendor
// this reads the report as text (CSV, TSV, spreadsheet-exported text, an HTML
// email body, or extracted PDF text) and looks for labelled numbers. Each
// metric carries a list of aliases seen across the common systems; anything
// unmatched is kept in raw_text so a later parser can do better without
// re-collecting the report.

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
  | "other_revenue";

interface MetricSpec {
  key: MetricKey;
  label: string;
  unit: "percent" | "currency" | "count";
  aliases: string[];
}

// Aliases are matched case-insensitively against a normalised label.
export const METRICS: MetricSpec[] = [
  {
    key: "occupancy",
    label: "Occupancy",
    unit: "percent",
    aliases: ["occupancy", "occ", "occ %", "occupancy %", "occupancy percent", "occ pct"],
  },
  {
    key: "adr",
    label: "ADR",
    unit: "currency",
    aliases: ["adr", "average daily rate", "avg daily rate", "average rate", "avg rate"],
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
    aliases: ["rooms sold", "rms sold", "occupied rooms", "rooms occupied", "sold rooms", "total occupied"],
  },
  {
    key: "rooms_available",
    label: "Rooms available",
    unit: "count",
    aliases: ["rooms available", "available rooms", "rooms avail", "total rooms", "room count", "inventory"],
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
  { key: "arrivals", label: "Arrivals", unit: "count", aliases: ["arrivals", "arrivals today", "check ins", "checkins", "check-ins"] },
  { key: "departures", label: "Departures", unit: "count", aliases: ["departures", "check outs", "checkouts", "check-outs"] },
  { key: "stayovers", label: "Stayovers", unit: "count", aliases: ["stayovers", "stay overs", "in house", "inhouse"] },
  { key: "no_shows", label: "No-shows", unit: "count", aliases: ["no shows", "no-shows", "noshow", "no show"] },
  { key: "cancellations", label: "Cancellations", unit: "count", aliases: ["cancellations", "cancels", "cancelled", "canceled"] },
  { key: "out_of_order", label: "Out of order", unit: "count", aliases: ["out of order", "ooo", "out of service", "oos"] },
  { key: "group_rooms", label: "Group rooms", unit: "count", aliases: ["group rooms", "group", "group block"] },
  { key: "comp_rooms", label: "Comp rooms", unit: "count", aliases: ["comp rooms", "complimentary rooms", "comps"] },
  { key: "walk_ins", label: "Walk-ins", unit: "count", aliases: ["walk ins", "walk-ins", "walkins"] },
  { key: "guests", label: "Guests", unit: "count", aliases: ["guests", "total guests", "adults", "pax"] },
  { key: "other_revenue", label: "Other revenue", unit: "currency", aliases: ["other revenue", "f&b revenue", "food and beverage", "misc revenue", "ancillary revenue"] },
];

function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_|]+/g, " ")
    .replace(/[^a-z0-9%&\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:\-\s]+$/, "");
}

// "$1,234.56" → 1234.56 · "78.5%" → 78.5 · "(120)" → -120
function parseNumber(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "");
  s = s.replace(/[$£€,\s]/g, "").replace(/%$/, "");
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

export interface ExtractedMetric {
  metric: MetricKey;
  value: number;
  unit: string;
}

// Pull "label … number" pairs out of any line-oriented text.
export function extractMetrics(text: string): ExtractedMetric[] {
  const found = new Map<MetricKey, number>();
  const lines = text
    .replace(/<[^>]+>/g, "\t") // strip HTML tags, keeping cell boundaries
    .replace(/&nbsp;/gi, " ")
    .split(/[\r\n]+/);

  for (const rawLine of lines) {
    // Thousands separators must go before splitting, or "$8,843.05" becomes
    // two cells and the metric reads as 8.
    const line = rawLine.replace(/(\d),(?=\d{3}(\D|$))/g, "$1");
    // Split on tabs, commas, or runs of 2+ spaces — covers CSV, TSV and the
    // fixed-width text most PMS reports produce.
    const cells = line
      .split(/\t|,|\s{2,}|\|/)
      .map((c) => c.trim().replace(/^"|"$/g, "").trim())
      .filter(Boolean);
    if (cells.length < 2) continue;

    for (let i = 0; i < cells.length; i++) {
      const label = normalizeLabel(cells[i]);
      if (!label) continue;
      const spec = METRICS.find((m) =>
        m.aliases.some((a) => label === a || label.startsWith(`${a} `) || label.endsWith(` ${a}`))
      );
      if (!spec || found.has(spec.key)) continue;
      // Take the first parseable number to the right of the label.
      for (let j = i + 1; j < cells.length; j++) {
        const n = parseNumber(cells[j]);
        if (n != null) {
          found.set(spec.key, n);
          break;
        }
      }
    }
  }

  // Occupancy sometimes arrives as a fraction (0.83) rather than a percent.
  const occ = found.get("occupancy");
  if (occ != null && occ > 0 && occ <= 1) found.set("occupancy", occ * 100);

  // Derive what the report left out but implies.
  const sold = found.get("rooms_sold");
  const avail = found.get("rooms_available");
  const roomRev = found.get("room_revenue");
  if (found.get("occupancy") == null && sold != null && avail) {
    found.set("occupancy", (sold / avail) * 100);
  }
  if (found.get("adr") == null && roomRev != null && sold) {
    found.set("adr", roomRev / sold);
  }
  if (found.get("revpar") == null && roomRev != null && avail) {
    found.set("revpar", roomRev / avail);
  }

  return [...found.entries()].map(([metric, value]) => ({
    metric,
    value,
    unit: METRICS.find((m) => m.key === metric)!.unit,
  }));
}

// Business date: an explicit "for <date>" wins, else the first date found.
export function extractReportDate(text: string, fallback: string): string {
  const patterns = [
    /(?:business date|for date|report date|date)[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /(?:business date|for date|report date|date)[:\s]+(\d{4}-\d{2}-\d{2})/i,
    /(\d{4}-\d{2}-\d{2})/,
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const iso = toISO(m[1]);
    if (iso) return iso;
  }
  return fallback;
}

function toISO(s: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!m) return null;
  const [, a, b, cRaw] = m;
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

  let best: { hotelId: string; matchedBy: string; score: number } | null = null;
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
    if (score >= 0.6 && (!best || score > best.score)) {
      best = { hotelId: h.hotel_id, matchedBy: `keywords ${hits.join(", ")}`, score };
    }
  }
  return best ? { hotelId: best.hotelId, matchedBy: best.matchedBy } : null;
}
