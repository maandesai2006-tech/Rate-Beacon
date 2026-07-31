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
}

export interface Hotel {
  hotel_id: string;
  name: string;
  is_mine: boolean;
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
}

export interface GridResponse {
  profile: Profile;
  hotels: Hotel[];
  rows: GridRow[];
  weekdayAvg: { weekday: number; avgMedian: number | null }[];
  lastCapturedAt: string | null;
}

export interface HistoryPoint {
  capturedOn: string;
  price: number | null;
  available: boolean;
}
