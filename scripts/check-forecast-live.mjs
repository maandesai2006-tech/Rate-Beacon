// Read-only release validation. No inserts, account creation, migrations or
// report/PMS reads. Run with Node's --env-file pointing to a server env file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { computeForecast, backtestForecast } from '../src/lib/forecast.ts';
import { forecastCompIds } from '../src/lib/forecast-market.ts';
import { loadForecastSnapshots, normalizeForecastSnapshot } from '../src/lib/forecast-storage.ts';

const fixture = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : null;
if (!fixture && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error('Server database configuration is needed for read-only validation.');
}
const supa = fixture ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const asOf = fixture?.asOf ?? new Date().toISOString().slice(0, 10);
const date = (offset) => new Date(Date.parse(`${asOf}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const { data: profiles, error } = fixture ? { data: fixture.profiles, error: null } : await supa.from('profiles')
  .select('id,currency,horizon_days,compset_radius_miles').order('id').limit(20);
if (error) throw new Error('Cannot read validation profiles.');
const results = [];
for (const profile of profiles ?? []) {
  const [links, edges] = fixture ? [
    { data: fixture.links.filter((row) => row.profile_id === profile.id) },
    { data: fixture.edges.filter((row) => row.profile_id === profile.id) },
  ] : await Promise.all([
    supa.from('profile_hotels').select('hotel_id,is_mine,hotels(name,latitude,longitude)').eq('profile_id', profile.id).limit(1000),
    supa.from('baseline_comps').select('baseline_hotel_id,comp_hotel_id').eq('profile_id', profile.id).limit(1000),
  ]);
  if (links.error || edges.error) throw new Error('Cannot read validation competitive sets.');
  const hotels = links.data.map((l) => ({ hotel_id: l.hotel_id, ...l.hotels }));
  const hotelNames = Object.fromEntries(hotels.map((h) => [h.hotel_id, h.name]));
  for (const link of links.data.filter((l) => l.is_mine)) {
    const compHotelIds = forecastCompIds(link.hotel_id,
      edges.data.filter((e) => e.baseline_hotel_id === link.hotel_id).map((e) => e.comp_hotel_id),
      hotels, profile.compset_radius_miles);
    const snapshots = fixture ? fixture.snapshots.filter((row) => [link.hotel_id, ...compHotelIds].includes(row.hotel_id) && row.currency === profile.currency).map(normalizeForecastSnapshot)
      : await loadForecastSnapshots(supa, [link.hotel_id, ...compHotelIds], profile.currency, asOf, date(44));
    const input = { hotelId: link.hotel_id, compHotelIds, hotelNames, currency: profile.currency, snapshots, asOf };
    const started = performance.now();
    const forecasts = Array.from({ length: Math.min(45, profile.horizon_days) }, (_, i) => computeForecast({ ...input, checkIn: date(i) }));
    const forecastMs = Math.round(performance.now() - started);
    for (const forecast of forecasts) {
      assert(forecast.demandScore >= 0 && forecast.demandScore <= 100);
      assert.equal(forecast.pricingEnabled, false);
      if (forecast.suggestedHigh != null) assert(forecast.suggestedHigh <= forecast.forecastMedian * 1.25);
      if (forecast.evidence.historyDays < 30) assert.equal(forecast.confidenceLabel, 'low');
    }
    const backtestStart = performance.now();
    const backtest = backtestForecast({ ...input, maxDates: 30 });
    // Change all rates after one historical cutoff. The rebuilt prediction,
    // including its training evidence, must be identical in both worlds.
    const point = backtest.points[0];
    let cutoffInvariant = null;
    if (point) {
      const initial = computeForecast({ ...input, asOf: point.cutoff, checkIn: point.checkIn });
      const altered = computeForecast({ ...input, asOf: point.cutoff, checkIn: point.checkIn,
        snapshots: snapshots.map((row) => row.captured_on > point.cutoff ? { ...row, price: 9999, available: false } : row) });
      assert.deepEqual(initial, altered);
      cutoffInvariant = true;
    }
    results.push({ profileId: profile.id, hotel: hotelNames[link.hotel_id], competitors: compHotelIds.length,
      captureRows: snapshots.length, usableCaptureDays: forecasts[0]?.evidence.historyDays,
      nightsComputed: forecasts.length, pricedForecastNights: forecasts.filter((f) => f.forecastMedian != null).length,
      confidenceLabels: Object.fromEntries(['low', 'medium', 'high'].map((label) => [label, forecasts.filter((f) => f.confidenceLabel === label).length])),
      forecastMs, backtestMs: Math.round(performance.now() - backtestStart),
      cutoffInvariant, byLeadTime: backtest.byLeadTime, limitations: backtest.limitations,
    });
  }
}
console.log(JSON.stringify({ asOf, readOnly: true, results }, null, 2));
