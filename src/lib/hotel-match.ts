// Deciding whether two hotel records describe the same building.
//
// Three sources feed competitor discovery and none of them share an
// identifier: the rate feed keys on TripAdvisor ids, OpenStreetMap keys on its
// own node ids, and a hotel's name is spelled differently by all of them. So
// matching is done on what they do have in common — a name and a position.
//
// Deliberately free of imports: the rule is pure arithmetic and string work,
// and keeping it that way is what lets it be tested on its own.

/** Great-circle distance in miles. */
export function milesBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * A hotel name reduced to what is worth comparing.
 *
 * "Hampton Inn & Suites by Hilton Pensacola Downtown" and "Hampton Inn Suites
 * Pensacola" are the same property to a person and different strings to a
 * computer. Franchise wrappers, punctuation and the filler words that vary
 * between listings all come out; what is left is the part that identifies it.
 */
export function comparableName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+by\s+(ihg|marriott|hilton|wyndham|choice|hyatt|radisson|best western)\b/g, " ")
    .replace(/\b(hotel|hotels|inn|suites|resort|motel|lodge|and|the|an?)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is this the same property as that one?
 *
 * Both halves must agree: the names have to reduce to the same core, and the
 * two records have to sit close enough together to be one building. Name alone
 * matches every Hampton Inn in the country; distance alone matches a hotel to
 * its neighbour across the car park. A record with no coordinates is matched on
 * name — the directory often has not been geocoded yet, and hiding the match
 * would offer the operator the same hotel twice.
 */
export function sameProperty(
  a: { name: string; latitude: number; longitude: number },
  b: { name: string; latitude: number | null; longitude: number | null },
  toleranceMiles = 0.4
): boolean {
  const an = comparableName(a.name);
  const bn = comparableName(b.name);
  if (!an || !bn) return false;
  if (an !== bn && !an.includes(bn) && !bn.includes(an)) return false;
  if (b.latitude == null || b.longitude == null) return true;
  return milesBetween(a, { latitude: b.latitude, longitude: b.longitude }) <= toleranceMiles;
}

/**
 * The town out of a full address.
 *
 * Geocoders return "Holiday Inn Express, 4300 Legendary Drive, Destin, Okaloosa
 * County, Florida, 32541, United States". The town and state are what identify
 * a market to a person and to a search, and getting this wrong is how a Destin
 * property ends up anchored in Pensacola.
 */
export function townOf(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const withoutCountry = parts.slice(0, -1);
  const trimmed = withoutCountry.filter((p) => !/^\d{4,}(-\d+)?$/.test(p));
  const state = trimmed[trimmed.length - 1] ?? null;
  const town =
    trimmed
      .slice(0, -1)
      .reverse()
      .find((p) => !/county$/i.test(p)) ?? null;
  return town && state ? `${town}, ${state}` : town;
}

/**
 * Any TripAdvisor hotel ids in a block of text, in the order they appear.
 *
 * Used on what a grounded search returns. It must find an id in a real result
 * and find nothing at all in prose — an invented id would put a hotel that
 * does not exist into somebody's competitive set.
 */
export function keysInText(text: string): string[] {
  const out: string[] = [];
  // Lookaround on both sides: in a URL the id follows a hyphen
  // ("Hotel_Review-g34467-d1234567-Reviews"), so a hyphen cannot be treated as
  // part of a longer token — but a letter or digit either side means this is a
  // fragment of something else and not an id at all.
  for (const m of text.matchAll(/(?<![a-z0-9])(g\d+)-(d\d+)(?![a-z0-9])/gi)) {
    out.push(`${m[1].toLowerCase()}-${m[2].toLowerCase()}`);
  }
  return [...new Set(out)];
}
