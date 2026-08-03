import { NextRequest, NextResponse } from "next/server";
import { listHotels, parseTripAdvisorRef } from "@/lib/xotelo";

// Two modes:
//   ?ref=<TripAdvisor URL or key>  → parse it; if it names a hotel, echo it
//                                    back, and list neighbors in its location
//   ?locationKey=g123&offset=0     → page through hotels in a location
//
// A pasted hotel link must resolve even when the location listing fails
// (Xotelo's /list is flaky and isn't needed to add one hotel by URL), so the
// listing runs best-effort and its failure is reported alongside the hotel
// rather than failing the whole request.
export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get("ref")?.trim();
  const locationKeyParam = req.nextUrl.searchParams.get("locationKey")?.trim();
  const offset = Number(req.nextUrl.searchParams.get("offset")) || 0;

  let locationKey = locationKeyParam ?? null;
  let pastedHotel: { hotelKey: string; name: string | null } | null = null;

  if (ref) {
    const parsed = parseTripAdvisorRef(ref);
    if (!parsed.locationKey && !parsed.hotelKey) {
      return NextResponse.json(
        {
          error:
            "Couldn't find a TripAdvisor id in that link. Open the hotel on tripadvisor.com and paste the page URL — it looks like …/Hotel_Review-g187147-d197685-Reviews-….html",
        },
        { status: 400 }
      );
    }
    locationKey = parsed.locationKey;
    if (parsed.hotelKey) {
      pastedHotel = { hotelKey: parsed.hotelKey, name: parsed.name };
    }
  }
  if (!locationKey) {
    return NextResponse.json({ error: "ref or locationKey required" }, { status: 400 });
  }

  let hotels: { hotelKey: string; name: string }[] = [];
  let listError: string | null = null;
  try {
    hotels = await listHotels(locationKey, offset, 30);
  } catch (e) {
    listError = (e as Error).message;
  }

  if (pastedHotel) {
    // Prefer the listing's cleaner name when we can find it there.
    const match = hotels.find((h) => h.hotelKey === pastedHotel!.hotelKey);
    if (match) pastedHotel.name = match.name;
    if (!pastedHotel.name) pastedHotel.name = pastedHotel.hotelKey;
    return NextResponse.json({ locationKey, pastedHotel, hotels, listError });
  }

  // No specific hotel was pasted, so the listing is the whole answer.
  if (listError) {
    return NextResponse.json({ error: listError }, { status: 502 });
  }
  return NextResponse.json({ locationKey, pastedHotel: null, hotels, listError: null });
}
