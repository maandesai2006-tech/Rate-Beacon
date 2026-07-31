// External demand signals, all free APIs. Fetched with module-level caches so
// a warm serverless instance doesn't refetch on every grid load; failures
// degrade to "no signal", never to an error.

export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

export interface DayWeather {
  tMax: number; // °F
  precipProb: number; // 0..100
  label: string; // "clear", "rain", ...
}

const holidayCache = new Map<string, { at: number; data: Holiday[] }>();

export async function getHolidays(countryCode: string, years: number[]): Promise<Holiday[]> {
  const key = `${countryCode}:${years.join(",")}`;
  const hit = holidayCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.data;
  try {
    const all: Holiday[] = [];
    for (const year of years) {
      const res = await fetch(
        `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`,
        { cache: "no-store" }
      );
      if (!res.ok) continue;
      const json = (await res.json()) as { date: string; localName?: string; name?: string }[];
      for (const h of json) {
        all.push({ date: h.date, name: h.localName ?? h.name ?? "Holiday" });
      }
    }
    holidayCache.set(key, { at: Date.now(), data: all });
    return all;
  } catch {
    return hit?.data ?? [];
  }
}

const WMO_LABELS: [number[], string][] = [
  [[0], "clear"],
  [[1, 2], "mostly clear"],
  [[3], "overcast"],
  [[45, 48], "fog"],
  [[51, 53, 55, 56, 57], "drizzle"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "rain"],
  [[71, 73, 75, 77, 85, 86], "snow"],
  [[95, 96, 99], "storms"],
];

function weatherLabel(code: number): string {
  for (const [codes, label] of WMO_LABELS) if (codes.includes(code)) return label;
  return "mixed";
}

const weatherCache = new Map<string, { at: number; data: Map<string, DayWeather> }>();

// Open-Meteo: free, keyless, 16-day daily forecast.
export async function getWeather(
  lat: number,
  lon: number
): Promise<Map<string, DayWeather>> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < 3 * 3600_000) return hit.data;
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=weather_code,temperature_2m_max,precipitation_probability_mean` +
      `&temperature_unit=fahrenheit&forecast_days=16&timezone=auto`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as {
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        precipitation_probability_mean?: number[];
      };
    };
    const map = new Map<string, DayWeather>();
    const d = json.daily;
    (d?.time ?? []).forEach((date, i) => {
      map.set(date, {
        tMax: Math.round(d?.temperature_2m_max?.[i] ?? 0),
        precipProb: Math.round(d?.precipitation_probability_mean?.[i] ?? 0),
        label: weatherLabel(d?.weather_code?.[i] ?? -1),
      });
    });
    weatherCache.set(key, { at: Date.now(), data: map });
    return map;
  } catch {
    return hit?.data ?? new Map();
  }
}

export interface TmEvent {
  date: string;
  name: string;
  venue: string | null;
  category: string | null;
  url: string | null;
}

// Ticketmaster Discovery API (free key: developer.ticketmaster.com). Optional —
// returns [] when TICKETMASTER_API_KEY isn't configured.
export async function getTicketmasterEvents(
  lat: number,
  lon: number,
  startISO: string,
  endISO: string
): Promise<TmEvent[]> {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) return [];
  try {
    const url =
      `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${key}` +
      `&latlong=${lat},${lon}&radius=30&unit=miles&size=200&sort=date,asc` +
      `&startDateTime=${startISO}T00:00:00Z&endDateTime=${endISO}T23:59:59Z`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      _embedded?: {
        events?: {
          name?: string;
          url?: string;
          dates?: { start?: { localDate?: string } };
          classifications?: { segment?: { name?: string } }[];
          _embedded?: { venues?: { name?: string }[] };
        }[];
      };
    };
    return (json._embedded?.events ?? [])
      .filter((e) => e.name && e.dates?.start?.localDate)
      .map((e) => ({
        date: e.dates!.start!.localDate!,
        name: e.name!.slice(0, 120),
        venue: e._embedded?.venues?.[0]?.name ?? null,
        category: e.classifications?.[0]?.segment?.name ?? null,
        url: e.url ?? null,
      }));
  } catch {
    return [];
  }
}
