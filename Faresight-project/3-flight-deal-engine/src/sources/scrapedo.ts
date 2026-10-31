// Scrape.do Google Flights plugin. Parameters and parsing match what was tested on ~5,000 searches (Oct 2026).
import { FatalSourceError, RetryableError, type FareQuery, type FareResult, type FareSource } from './types.ts';

const ENDPOINT = 'https://api.scrape.do/plugin/google/flights';
const CREDITS_PER_SEARCH = 10;

export function scrapeDoSource(token: string, fetchImpl: typeof fetch = fetch): FareSource {
  if (!token) throw new Error('SCRAPEDO_TOKEN is not set');
  return {
    name: 'scrapedo',
    async search(q: FareQuery): Promise<FareResult> {
      const params = new URLSearchParams({
        token, departure_id: q.origin, arrival_id: q.destination,
        outbound_date: q.depart, return_date: q.returnDate,
        type: '1',                                         // 1 = round trip
        stops: String(Math.min(q.maxStops, 2) + 1),        // 1 nonstop, 2 up to 1 stop, 3 up to 2 stops
        currency: q.currency, gl: q.gl, hl: 'en',
      });
      let res: Response;
      try {
        res = await fetchImpl(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(90_000) });
      } catch (e) {
        throw new RetryableError(`network: ${(e as Error).message}`);
      }
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      if ([401, 402, 403].includes(res.status)) throw new FatalSourceError(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      return parseGoogleFlights(JSON.parse(text), q.maxStops, CREDITS_PER_SEARCH);
    },
  };
}

export function parseGoogleFlights(data: any, maxStops: number, credits = CREDITS_PER_SEARCH): FareResult {
  const options = [...(data?.best_flights ?? []), ...(data?.other_flights ?? [])]
    .filter((f: any) => typeof f?.price === 'number')
    .map((f: any) => ({
      price: f.price as number,
      stops: (f.layovers ?? []).length as number,
      airlines: [...new Set((f.flights ?? []).map((s: any) => s.airline).filter(Boolean))].join(' + '),
    }))
    .sort((a, b) => a.price - b.price);
  const match = options.find(o => o.stops <= maxStops);
  return {
    price: match?.price ?? null,
    cheapestAny: options[0]?.price ?? null,
    stops: match?.stops ?? null,
    airlines: match?.airlines || null,
    options: options.length,
    source: 'scrapedo',
    credits,
  };
}
