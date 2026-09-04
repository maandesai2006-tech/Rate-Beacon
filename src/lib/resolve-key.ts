// Turning a real hotel into one the rate feed can follow.
//
// The map knows every hotel near a property — name, address, coordinates — and
// the rate feed knows hotels only by their TripAdvisor id. Nothing free links
// the two: the provider's own market listing has refused every request shape
// tried, so until now the operator had to find each neighbour on TripAdvisor
// and paste its link. That is the manual step this removes.
//
// The method is a search, not a guess. Gemini is asked, with Google Search
// grounding switched on, for the TripAdvisor page of a specific hotel at a
// specific address; what comes back is a real URL from a real search result,
// and the id is parsed out of it. A language model inventing a plausible id is
// the obvious failure here, so nothing it returns is trusted: every id is put
// to the rate feed first, and one the feed does not recognise is discarded.
// A hotel enters a competitive set because the feed answered for it, never
// because a model said so.

import { GoogleGenAI } from "@google/genai";
import { verifyHotelKey } from "./xotelo";
import { keysInText } from "./hotel-match";

export interface ResolvableHotel {
  name: string;
  address?: string | null;
  /** Town or market, for disambiguating chains. */
  near?: string | null;
}

export interface ResolvedKey {
  name: string;
  hotelKey: string | null;
  /** How it was found, or why it was not. */
  detail: string;
}

export { keysInText };

export function resolverConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/**
 * Find the TripAdvisor id for each hotel, and keep only the ones the rate feed
 * confirms.
 *
 * Hotels are asked for in one prompt rather than one request each: the search
 * is the slow part, and a market's worth of neighbours has to resolve inside a
 * single serverless invocation.
 */
export async function resolveHotelKeys(
  hotels: ResolvableHotel[],
  { market = null, limit = 12 }: { market?: string | null; limit?: number } = {}
): Promise<ResolvedKey[]> {
  const wanted = hotels.slice(0, limit);
  if (wanted.length === 0) return [];

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return wanted.map((h) => ({
      name: h.name,
      hotelKey: null,
      detail: "No search key configured, so the link has to be pasted by hand.",
    }));
  }

  const listing = wanted
    .map((h, i) => `${i + 1}. ${h.name}${h.address ? ` — ${h.address}` : ""}`)
    .join("\n");

  const prompt = [
    "Find the TripAdvisor listing page for each hotel below.",
    market ? `They are all in or near ${market}.` : "",
    "",
    listing,
    "",
    "Search for each one. Reply with one line per hotel, in the same order,",
    "formatted exactly as:",
    "<number>. <full TripAdvisor URL, or NONE>",
    "",
    "Rules:",
    "- The URL must be one you actually found in search results.",
    "- It must be the Hotel_Review page for that exact property at that address,",
    "  not a different branch of the same chain in another town.",
    "- If you cannot find that specific property, write NONE. Never guess an id.",
  ]
    .filter(Boolean)
    .join("\n");

  let text = "";
  try {
    const ai = new GoogleGenAI({ apiKey });
    const res = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
      contents: prompt,
      config: {
        temperature: 0,
        // Grounding is the point: without it the model would be recalling ids
        // from training data, which is exactly the failure mode to avoid.
        tools: [{ googleSearch: {} }],
      },
    });
    text = res.text ?? "";
  } catch (e) {
    return wanted.map((h) => ({
      name: h.name,
      hotelKey: null,
      detail: `Search failed: ${(e as Error).message}`,
    }));
  }

  // Match each reply line back to the hotel it was asked about. A model that
  // drops or reorders lines must not shift every id onto the wrong hotel, so
  // the number is read rather than the position assumed.
  const byIndex = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s*[.):]\s*(.+)$/);
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    const keys = keysInText(m[2]);
    if (keys.length > 0) byIndex.set(idx, keys[0]);
  }

  const results: ResolvedKey[] = [];
  for (let i = 0; i < wanted.length; i++) {
    const hotel = wanted[i];
    const candidate = byIndex.get(i) ?? null;
    if (!candidate) {
      results.push({ name: hotel.name, hotelKey: null, detail: "No TripAdvisor page found." });
      continue;
    }
    // The claim is checked against the feed that will have to price it.
    const verdict = await verifyHotelKey(candidate);
    results.push(
      verdict.verdict === "priceable"
        ? { name: hotel.name, hotelKey: candidate, detail: `Found and priceable — ${verdict.detail}.` }
        : {
            name: hotel.name,
            hotelKey: null,
            detail: `Found ${candidate}, but the rate feed does not recognise it (${verdict.detail}), so it was discarded.`,
          }
    );
  }
  return results;
}
