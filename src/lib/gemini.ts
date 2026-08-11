// Universal PMS translator.
//
// Manager's reports have no standard. A Candlewood daily flash, a Holiday Inn
// Express night audit, an OnQ summary and a boutique PMS export all carry the
// same handful of numbers under different labels, in different layouts, some
// of them as multi-column fixed-width text that no regex survives contact with.
//
// Rather than write a parser per vendor, the PDF bytes go straight to Gemini
// with a strict response schema. Gemini reads PDFs natively — no OCR step, and
// scanned reports work as well as digital ones. Temperature is 0 and the model
// is told to return null rather than guess, because a null is a gap the
// dashboard can show honestly and a hallucinated number is not.
//
// Free tier: gemini-2.0-flash allows generous daily requests at no cost, and a
// hotel sends one report a day.

import { GoogleGenAI, Type } from "@google/genai";

export const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

export interface ExtractedReport {
  hotel_name: string | null;
  pms_type: string | null;
  report_date: string | null;
  occupancy_percent: number | null;
  adr: number | null;
  revpar: number | null;
  room_revenue: number | null;
  total_revenue: number | null;
  rooms_sold: number | null;
  rooms_available: number | null;
  out_of_order: number | null;
  no_shows: number | null;
  cancellations: number | null;
  total_reservations: number | null;
  comp_rooms: number | null;
  early_departures: number | null;
  extended_stays: number | null;
  walk_ins: number | null;
  arrivals: number | null;
  departures: number | null;
  stayovers: number | null;
  cash_variance: number | null;
  total_adjustments: number | null;
  direct_bill_transfers: number | null;
  confidence: number | null;
  unreadable: boolean;
  notes: string | null;
}

export class UnreadableReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableReportError";
  }
}

// ── The prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Universal PMS Translator inside a hotel revenue-management system.

Your one job: read a hotel's daily manager's report — whatever property-management system produced it — and return its numbers in a single fixed JSON shape. You will see reports from IHG (Candlewood Daily Flash, Holiday Inn Express night audit, Opera/Concerto exports), Hilton (OnQ, Daily Flash), Marriott (FSPMS, MARSHA summaries), Choice (choiceADVANTAGE), Wyndham, Best Western, and independents on Cloudbeds, Mews, RoomKey, innRoad, WebRezPro, or a spreadsheet somebody built themselves. Layouts differ wildly: two-column key/value, wide fixed-width grids, multi-page audits with a summary on page 1, landscape tables, scans.

HOW TO READ THE REPORT

1. Find the business date. It is the night the audit covers, not the date the email was sent and not the print timestamp. Look for "Business Date", "Audit Date", "For Date", "Report Date", "As of", or a date in the header. If the report shows Today / MTD / YTD columns, every value you return must come from the TODAY (daily / current day) column — never the month-to-date or year-to-date column. Return the date as YYYY-MM-DD. US ordering (MM/DD/YYYY) is the default for these reports.

2. Map labels to fields by meaning, not by exact string. Common aliases:
   - occupancy_percent: "Occupancy", "Occ %", "Occupancy Percentage", "% Occ". If it is a fraction (0.83), convert to 83.0. If the report gives rooms sold and rooms available but no occupancy, leave occupancy_percent null — the caller derives it.
   - adr: "ADR", "Average Daily Rate", "Avg Rate", "Average Room Rate", "Rate Average".
   - revpar: "RevPAR", "Rev PAR", "Revenue Per Available Room".
   - room_revenue: "Room Revenue", "Rooms Revenue", "Guest Room Revenue", "Lodging Revenue", "Transient + Group room revenue" totalled.
   - total_revenue: "Total Revenue", "Grand Total", "Total Sales" — the whole ledger including non-room.
   - rooms_sold: "Rooms Sold", "Rms Sold", "Occupied Rooms", "Total Occupied", "Rooms Occupied".
   - rooms_available: "Rooms Available", "Available Rooms", "Total Rooms", "Room Count", "Inventory", "Rooms in Hotel". If the report shows physical rooms and out-of-order separately, rooms_available is the sellable count actually printed on the report — do not subtract anything yourself.
   - out_of_order: "Out of Order", "OOO", "Out of Service", "OOS", "OO/OS".
   - no_shows: "No Shows", "No-Show", "NoShow".
   - cancellations: "Cancellations", "Cancels", "Cancelled".
   - total_reservations: total reservations on the books for that night — "Total Reservations", "Reservations", or arrivals + stayovers if that is all the report gives.
   - comp_rooms: "Comp Rooms", "Complimentary", "House Use", "Comp/House".
   - early_departures: "Early Departures", "Early Outs", "Early Check-outs".
   - extended_stays: "Extended Stays", "Extensions", "Stay Extensions", "Late Departures Extended".
   - walk_ins: "Walk Ins", "Walk-ins", "Walkins".
   - arrivals: "Arrivals", "Check-ins", "Expected Arrivals" — prefer actual over expected.
   - departures: "Departures", "Check-outs".
   - stayovers: "Stayovers", "Stay Overs", "In House", "Continuing".
   - cash_variance: "Cash Over/Short", "Over/Short", "Cash Variance", "Drawer Variance". Over is positive, short is negative.
   - total_adjustments: "Adjustments", "Allowances", "Rebates", "Refunds", "Corrections". Return the absolute total as a positive number.
   - direct_bill_transfers: "Direct Bill", "City Ledger", "A/R Transfer", "Transfer to A/R".

3. Number handling. Strip currency symbols, thousands separators and stray spaces. "$8,843.05" is 8843.05. Parenthesised numbers are negative: "(120.00)" is -120.00. Percentages lose the % sign. Counts are whole numbers.

4. Return null for anything the report does not contain. This is the most important rule. Do not infer, do not average, do not carry a value over from a different column or a different date, and never invent a plausible number. A null is correct and useful; a guess corrupts the hotel's history.

5. Do not compute derived values. If ADR is absent but room revenue and rooms sold are present, still return adr as null. The system derives those itself, consistently, so that a derived number is always distinguishable from a reported one.

6. hotel_name: the property name as printed on the report. pms_type: one of ihg, hilton, marriott, choice, wyndham, bestwestern, cloudbeds, mews, opera, independent, unknown — your best read of which system produced it.

7. confidence: 0.0 to 1.0, how sure you are that the values you filled in came from the right column of the right report for the right date. A clean digital single-property daily flash is around 0.95. A skewed scan where you had to guess column alignment is around 0.4.

8. If the document is not a hotel manager's report at all, or is so degraded that you cannot read any figures, set unreadable to true, leave every metric null, and explain in notes.

9. notes: one short sentence, only when something a human should know is true — a value you were unsure about, a column you had to pick between, a report covering multiple properties. Otherwise null.

Return only the JSON object described by the response schema. No prose, no markdown fences, no commentary.`;

// The schema mirrors daily_manager_reports column for column, so what Gemini
// returns can be written to the row with no remapping layer to drift.
const num = { type: Type.NUMBER, nullable: true } as const;
const int = { type: Type.INTEGER, nullable: true } as const;
const str = { type: Type.STRING, nullable: true } as const;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    hotel_name: str,
    pms_type: str,
    report_date: { type: Type.STRING, nullable: true, description: "Business date as YYYY-MM-DD" },
    occupancy_percent: num,
    adr: num,
    revpar: num,
    room_revenue: num,
    total_revenue: num,
    rooms_sold: int,
    rooms_available: int,
    out_of_order: int,
    no_shows: int,
    cancellations: int,
    total_reservations: int,
    comp_rooms: int,
    early_departures: int,
    extended_stays: int,
    walk_ins: int,
    arrivals: int,
    departures: int,
    stayovers: int,
    cash_variance: num,
    total_adjustments: num,
    direct_bill_transfers: num,
    confidence: num,
    unreadable: { type: Type.BOOLEAN },
    notes: str,
  },
  required: ["unreadable"],
} as const;

const EMPTY: ExtractedReport = {
  hotel_name: null,
  pms_type: null,
  report_date: null,
  occupancy_percent: null,
  adr: null,
  revpar: null,
  room_revenue: null,
  total_revenue: null,
  rooms_sold: null,
  rooms_available: null,
  out_of_order: null,
  no_shows: null,
  cancellations: null,
  total_reservations: null,
  comp_rooms: null,
  early_departures: null,
  extended_stays: null,
  walk_ins: null,
  arrivals: null,
  departures: null,
  stayovers: null,
  cash_variance: null,
  total_adjustments: null,
  direct_bill_transfers: null,
  confidence: null,
  unreadable: false,
  notes: null,
};

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export interface ExtractInput {
  /** Base64 of the attachment, no data: prefix. */
  base64?: string;
  mimeType?: string;
  fileName?: string;
  /** Used when the report arrived as email body text rather than a file. */
  text?: string;
  subject?: string;
}

/**
 * Send one report to Gemini and get the normalised row back.
 * Throws UnreadableReportError when the document cannot be read at all, so the
 * caller can record the failure against the raw report instead of writing an
 * empty day into the hotel's history.
 */
export async function extractReport(input: ExtractInput): Promise<ExtractedReport> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set. See .env.example.");
  if (!input.base64 && !input.text) throw new Error("Nothing to extract: no file and no text");

  const ai = new GoogleGenAI({ apiKey });

  const parts: Record<string, unknown>[] = [];
  if (input.base64) {
    parts.push({
      inlineData: {
        mimeType: input.mimeType || "application/pdf",
        data: input.base64,
      },
    });
  }
  parts.push({
    text: [
      input.subject ? `Email subject: ${input.subject}` : null,
      input.fileName ? `File name: ${input.fileName}` : null,
      input.text ? `Report text:\n${input.text.slice(0, 100_000)}` : null,
      "Extract this manager's report into the required JSON.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const res = await withRetry(() =>
    ai.models.generateContent({
      model: DEFAULT_MODEL,
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        // Extraction is a transcription task, not a creative one.
        temperature: 0,
        maxOutputTokens: 2048,
      },
    })
  );

  const raw = res.text?.trim();
  if (!raw) throw new UnreadableReportError("Gemini returned an empty response");

  let parsed: Record<string, unknown>;
  try {
    // responseMimeType pins this to JSON, but a stray fence has been seen
    // when the model decides to be helpful.
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new UnreadableReportError(`Gemini returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const out = coerce(parsed);
  if (out.unreadable) {
    throw new UnreadableReportError(
      out.notes || "Gemini could not read any figures from this document"
    );
  }
  return out;
}

// Trust the schema, verify the values: the model can still return "83%" or a
// date in the wrong format, and a bad type reaching Postgres is a 500.
function coerce(raw: Record<string, unknown>): ExtractedReport {
  const out: ExtractedReport = { ...EMPTY };

  const numeric = (v: unknown): number | null => {
    if (v == null) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v !== "string") return null;
    const negative = /^\(.*\)$/.test(v.trim());
    const cleaned = v.replace(/[()$£€,%\s]/g, "");
    if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
    const n = parseFloat(cleaned);
    if (!Number.isFinite(n)) return null;
    return negative ? -Math.abs(n) : n;
  };

  for (const key of Object.keys(EMPTY) as (keyof ExtractedReport)[]) {
    if (key === "unreadable") continue;
    if (key === "hotel_name" || key === "pms_type" || key === "notes" || key === "report_date") {
      const v = raw[key];
      (out[key] as string | null) = typeof v === "string" && v.trim() ? v.trim() : null;
      continue;
    }
    (out[key] as number | null) = numeric(raw[key]);
  }

  out.unreadable = raw.unreadable === true;

  // Occupancy occasionally comes back as a fraction despite the instruction.
  if (out.occupancy_percent != null && out.occupancy_percent > 0 && out.occupancy_percent <= 1) {
    out.occupancy_percent = out.occupancy_percent * 100;
  }
  // An occupancy over 100 is real (overbooking against a reduced sellable
  // count) but over 200 means a column was misread.
  if (out.occupancy_percent != null && (out.occupancy_percent < 0 || out.occupancy_percent > 200)) {
    out.occupancy_percent = null;
  }
  if (out.confidence != null) {
    out.confidence = Math.min(1, Math.max(0, out.confidence));
  }
  if (out.report_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.report_date)) {
    out.report_date = normaliseDate(out.report_date);
  }
  // Counts must be whole.
  for (const k of [
    "rooms_sold", "rooms_available", "out_of_order", "no_shows", "cancellations",
    "total_reservations", "comp_rooms", "early_departures", "extended_stays",
    "walk_ins", "arrivals", "departures", "stayovers",
  ] as const) {
    if (out[k] != null) out[k] = Math.round(out[k] as number);
  }

  return out;
}

function normaliseDate(s: string): string | null {
  const m = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const [, a, b, cRaw] = m;
    const year = cRaw.length === 2 ? 2000 + Number(cRaw) : Number(cRaw);
    const month = Number(a);
    const day = Number(b);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const iso = s.match(/\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : null;
}

// 429 and 5xx from the free tier are common enough to be worth handling; the
// whole route still finishes well inside Vercel's 60-second ceiling.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = /429|rate limit|quota|503|502|500|UNAVAILABLE|deadline/i.test(msg);
      if (!retryable || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
    }
  }
  throw lastError;
}
