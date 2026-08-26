export interface Profile {
  id: number;
  name: string;
  hotel_name: string | null;
  city_code: string | null;
  city_name: string | null;
  currency: string;
  horizon_days: number;
  adults: number;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
  country_code: string;
}

export interface Hotel {
  hotel_id: string;
  name: string;
  /** The baseline this grid is built around — exactly one per grid. */
  is_mine: boolean;
  /**
   * Another hotel the same operator owns, showing up inside this hotel's
   * competitive set. It competes on rate like any other, but it is not really
   * a rival, so the grid tints it apart from the true competitors.
   */
  is_portfolio?: boolean;
  rating: number | null;
  review_count: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface Baseline {
  hotel_id: string;
  name: string;
  compCount: number;
}

// Ladder standing for one hotel, across the horizon.
export interface RankStat {
  hotel_id: string;
  rankToday: number | null;      // 1 = most expensive tonight
  rankDelta: number | null;      // vs the previous capture; + = moved up
  avgRank30: number | null;      // mean ladder position over the next 30 nights
  pricedCount: number;           // hotels ranked tonight
}

export interface Quote {
  name: string;
  total: number;
}

export interface RateCell {
  price: number | null; // brand-direct when detected, else cheapest quote
  priceLow: number | null; // cheapest quote
  source: string | null;
  direct: boolean;
  offers: Quote[];
  available: boolean;
  capturedOn: string | null;
}

export type Position =
  | "well_below"
  | "below"
  | "in_line"
  | "above"
  | "well_above"
  | null;

export type Advice = "raise" | "review_low" | "review_high" | "in_line" | null;

export interface RowSignals {
  holiday: string | null; // holiday name landing on this date
  nearHoliday: boolean; // date sits inside a long-weekend window
  weather: { tMax: number; tMin: number; precipProb: number; label: string } | null;
  eventCount: number;
  topEvents: string[]; // up to 3 names
  paceDelta: number | null; // change in sold-out comp count vs ~1 week ago
  parity: { undercut: number; by: string } | null; // an OTA undercutting my direct rate
}

export interface GridRow {
  date: string; // check-in date YYYY-MM-DD
  cells: Record<string, RateCell>; // hotelId -> cell
  myPrice: number | null;
  myPriceSource: "manual" | "live" | null;
  median: number | null;
  min: number | null;
  max: number | null;
  compCount: number;
  soldOutCount: number;
  demand: number | null; // 0..100
  momentumPct: number | null; // % change of market median vs ~7 days ago
  position: Position;
  advice: Advice;
  signals: RowSignals;
}

export interface GridResponse {
  profile: Profile;
  baselines: Baseline[];
  activeBaselineId: string | null;
  compsAreDiscovered: boolean;
  rankStats: RankStat[];
  hotels: Hotel[];
  mapHotels: Hotel[];
  mapPlaces: MapPlace[];
  rows: GridRow[];
  weekdayAvg: { weekday: number; avgMedian: number | null }[];
  lastCapturedAt: string | null;
}

export interface MapPlace {
  osm_id: string;
  name: string;
  latitude: number;
  longitude: number;
  distance_km: number | null;
  hotel_id: string | null;
}

export interface HistoryPoint {
  capturedOn: string;
  price: number | null;
  available: boolean;
}
