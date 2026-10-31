// Simulated fares, so the whole engine can be tried and tested without spending credits.
// Prices follow a route base price, a season curve and noise. Some routes get a "sale": a window of
// departures about 35% cheaper, which the engine should find.
import type { FareQuery, FareResult, FareSource } from './types.ts';

function hash(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 2 ** 32; }

const BASE: Record<string, number> = { short: 18000, medium: 30000, long: 62000 };
const LONG = new Set(['LHR', 'CDG', 'AMS', 'FRA', 'MUC', 'FCO', 'MXP', 'BCN', 'IST', 'PRG', 'VIE', 'JFK', 'SFO', 'YYZ', 'SYD']);
const SHORT = new Set(['CMB', 'MLE', 'KTM', 'DXB', 'AUH', 'SHJ', 'DOH', 'MCT']);

export interface MockOptions {
  /** Share of routes that have a sale window (0..1). */
  saleShare?: number;
  /** Extra multiplier applied to every price, e.g. to simulate a deal disappearing. */
  priceFactor?: (q: FareQuery) => number;
}

export function mockSource(opts: MockOptions = {}): FareSource {
  const saleShare = opts.saleShare ?? 0.15;
  return {
    name: 'mock',
    async search(q: FareQuery): Promise<FareResult> {
      const route = `${q.origin}-${q.destination}`;
      const haul = LONG.has(q.destination) ? 'long' : SHORT.has(q.destination) ? 'short' : 'medium';
      const base = BASE[haul] * (0.8 + 0.4 * hash(route));
      const d = new Date(q.depart + 'T00:00:00Z');
      const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5);
      const season = 1 + 0.15 * Math.cos(((doy - 355) / 365) * 2 * Math.PI);      // peak around Christmas
      const noise = 0.94 + 0.12 * hash(`${route}|${q.depart}|${q.returnDate}`);
      let price = base * season * noise;
      // Sale window: on some routes, departures within a 12-day window are ~35% cheaper
      if (hash(route + '|sale') < saleShare) {
        const start = Date.parse('2027-01-10') + Math.floor(hash(route + '|start') * 150) * 864e5;
        if (d.getTime() >= start && d.getTime() < start + 12 * 864e5) price *= 0.65;
      }
      price *= opts.priceFactor?.(q) ?? 1;
      const p = Math.round(price);
      return { price: p, cheapestAny: Math.round(p * 0.93), stops: q.maxStops === 0 ? 0 : 1, airlines: 'Simulated Air', options: 12, source: 'mock', credits: 0 };
    },
  };
}
