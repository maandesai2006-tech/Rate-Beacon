import assert from 'node:assert/strict';
import { loadForecastSnapshots, readStoredForecasts, advanceForecastTasks, normalizeForecastSnapshot } from '../src/lib/forecast-storage.ts';
import { forecastCompIds, forecastContextKey } from '../src/lib/forecast-market.ts';
import { adviceFor } from '../src/lib/insights.ts';

function mockClient(pages, error = null) {
  const calls = [];
  const client = { from(table) {
    calls.push(['from', table]);
    const query = {};
    for (const method of ['select', 'in', 'eq', 'gte', 'lte', 'order', 'range', 'limit', 'abortSignal']) {
      query[method] = (...args) => { calls.push([method, ...args]); return query; };
    }
    query.returns = async () => ({ data: pages.shift() ?? [], error });
    return query;
  } };
  return { client, calls };
}

const fullPage = Array.from({ length: 1000 }, (_, i) => ({ hotel_id: `h${i}` }));
assert.equal(normalizeForecastSnapshot({ price: '125.50' }).price, 125.5);
assert.equal(normalizeForecastSnapshot({ price: null }).price, null);
assert(Number.isNaN(normalizeForecastSnapshot({ price: ' ' }).price), 'An empty string must never become a zero quote');
const paged = mockClient([fullPage, fullPage, [{ hotel_id: 'last' }]]);
assert.equal((await loadForecastSnapshots(paged.client, ['baseline', 'comp'], 'USD', '2026-09-06', '2026-10-20')).length, 2001);
assert.deepEqual(paged.calls.filter(([op]) => op === 'range'), [['range', 0, 999], ['range', 1000, 1999], ['range', 2000, 2999]]);
assert(paged.calls.some((c) => c[0] === 'eq' && c[1] === 'currency' && c[2] === 'USD'));
assert(paged.calls.some((c) => c[0] === 'lte' && c[1] === 'captured_on' && c[2] === '2026-09-06'));
assert(paged.calls.some((c) => c[0] === 'in' && c[1] === 'hotel_id' && c[2].includes('baseline')));
const tooLarge = mockClient([fullPage, [{ hotel_id: 'excess' }]]);
await assert.rejects(loadForecastSnapshots(tooLarge.client, ['h'], 'USD', '2026-09-06', '2026-10-20', { maxRows: 1000 }), /No partial forecast/);
const exactLimit = mockClient([fullPage, []]);
assert.equal((await loadForecastSnapshots(exactLimit.client, ['h'], 'USD', '2026-09-06', '2026-10-20', { maxRows: 1000 })).length, 1000);
await assert.rejects(loadForecastSnapshots(mockClient([]).client, ['h'], 'USD', '2026-09-06', '2026-10-20', { deadline: 0 }), /time budget/);
await assert.rejects(loadForecastSnapshots(mockClient([], { message: 'connection failed' }).client, ['h'], 'USD', '2026-09-06', '2026-10-20'), /connection failed/);

const stored = { check_in: '2026-09-07', context_key: 'ctx', computed_at: '2026-09-06T10:00:00Z',
  forecast: { version: 1, asOf: '2026-09-06', hotelId: 'mine', checkIn: '2026-09-07' } };
const storage = mockClient([[stored, { ...stored, forecast: { ...stored.forecast, asOf: '2026-09-05' } }]]);
const read = await readStoredForecasts(storage.client, 42, 'mine', '2026-09-06', '2026-10-20', 'ctx');
assert.equal(read.forecasts.length, 1);
for (const [key, value] of [['profile_id', 42], ['hotel_id', 'mine'], ['context_key', 'ctx']]) {
  assert(storage.calls.some((c) => c[0] === 'eq' && c[1] === key && c[2] === value));
}
const missing = await readStoredForecasts(mockClient([], { message: 'missing table' }).client, 42, 'mine', '2026-09-06', '2026-10-20', 'ctx');
assert.equal(missing.forecasts.length, 0);
assert.match(missing.status, /unavailable/);

let checkpoint = 0;
const ran = [];
await assert.rejects(advanceForecastTasks(['a', 'b', 'c'], 0, Infinity,
  async (task) => { ran.push(task); if (task === 'b') throw new Error('persistence failed'); },
  async (next) => { checkpoint = next; }), /persistence failed/);
assert.equal(checkpoint, 1, 'Failed task must not advance the saved cursor');
const resumed = await advanceForecastTasks(['a', 'b', 'c'], checkpoint, Infinity,
  async (task) => { ran.push(task); }, async (next) => { checkpoint = next; });
assert.deepEqual(ran, ['a', 'b', 'b', 'c']);
assert.deepEqual(resumed, { cursor: 3, complete: true });
assert.deepEqual(await advanceForecastTasks(['a'], 0, 0, async () => assert.fail('ran past deadline'), async () => {}), { cursor: 0, complete: false });

const hotels = [
  { hotel_id: 'g1-d1', name: 'Mine', latitude: 30, longitude: -87 },
  { hotel_id: 'g1-d2', name: 'Near', latitude: 30.01, longitude: -87 },
  { hotel_id: 'g1-d3', name: 'Far', latitude: 35, longitude: -87 },
  { hotel_id: 'g2-d4', name: 'Other market', latitude: 30, longitude: -87 },
  { hotel_id: 'g1-d5', name: 'Unplaced', latitude: null, longitude: null },
];
assert.deepEqual(forecastCompIds('g1-d1', [], hotels, 15), []);
assert.deepEqual(forecastCompIds('g1-d1', ['g1-d1', 'g1-d2', 'g1-d2', 'g1-d3', 'g2-d4', 'g1-d5', 'g1-d99'], hotels, 15), ['g1-d2', 'g1-d5']);
assert.equal(forecastContextKey('h', ['c', 'a'], 'USD'), forecastContextKey('h', ['a', 'c'], 'USD'));
assert.notEqual(forecastContextKey('h', ['a'], 'USD'), forecastContextKey('h', ['a'], 'EUR'));
assert.equal(adviceFor('in_line', 50, 'forecast'), 'in_line', 'Neutral new score must not become a raise instruction');
assert.equal(adviceFor('in_line', 65, 'forecast'), 'raise');
assert.equal(adviceFor('in_line', 40, 'legacy'), 'raise', 'Legacy demo behavior remains explicit');
console.log('Forecast storage: complete pagination, bounds, scope, retries, compsets and neutral advice passed.');
