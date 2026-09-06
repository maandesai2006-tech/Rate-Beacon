// Shared by the grid and collector so a forecast never silently uses a
// different market. An empty explicitly configured compset stays empty.
export interface ForecastHotel {
  hotel_id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

export function forecastCompIds(
  baselineId: string,
  configuredIds: string[],
  hotels: ForecastHotel[],
  radiusMiles: number
): string[] {
  const byId = new Map(hotels.map((h) => [h.hotel_id, h]));
  const baseline = byId.get(baselineId);
  if (!baseline) return [];
  const radiusKm = (Number.isFinite(radiusMiles) && radiusMiles > 0 ? radiusMiles : 15) * 1.609344;
  const placed = (h: ForecastHotel) => h.latitude != null && h.longitude != null &&
    Number.isFinite(h.latitude) && Number.isFinite(h.longitude);
  return [...new Set(configuredIds)].filter((id) => {
    const comp = byId.get(id);
    if (!comp || id === baselineId || id.split("-")[0] !== baselineId.split("-")[0]) return false;
    if (!placed(comp) || !placed(baseline)) return true;
    const rad = (degrees: number) => degrees * Math.PI / 180;
    const h = Math.sin(rad(comp.latitude! - baseline.latitude!) / 2) ** 2 +
      Math.cos(rad(baseline.latitude!)) * Math.cos(rad(comp.latitude!)) *
      Math.sin(rad(comp.longitude! - baseline.longitude!) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h))) <= radiusKm;
  }).sort();
}

export function forecastContextKey(hotelId: string, compIds: string[], currency: string): string {
  return JSON.stringify([1, hotelId, [...new Set(compIds)].sort(), currency]);
}
