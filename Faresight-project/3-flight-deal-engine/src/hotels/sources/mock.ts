// Simulated hotels, so the hotel engine can be tried and tested without credits. Every city has the same
// 12 hotels on every search (stable ids). Per-night prices follow a hotel base price, a season curve and
// noise; some hotels have a 12-day "sale" window of check-ins about 40% cheaper, which the engine should find.
import type { HotelOffer, HotelQuery, HotelResult, HotelSource } from '../contract.ts';
import { regionOf } from '../../notify/regions.ts';

function hash(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 2 ** 32; }

const BASE: Record<string, number> = { india: 3500, seAsia: 4500, saGulf: 7000, eastAsia: 7500, europe: 11000, longHaul: 13000 };
const STAR_FACTOR: Record<number, number> = { 2: 0.55, 3: 0.85, 4: 1.3, 5: 2.1 };
const NAMES = ['Grand', 'Royal', 'Palm', 'Harbour', 'Central', 'Lotus', 'Heritage', 'Skyline', 'Garden', 'Riverside', 'Park', 'Plaza'];
const KINDS = ['Hotel', 'Residency', 'Suites', 'Inn', 'Resort', 'Boutique Hotel'];
const AREAS = ['City Centre', 'Old Town', 'Business District', 'Waterfront', 'Near Airport', 'Shopping District'];
export const MOCK_HOTELS_PER_CITY = 12;

export interface MockHotelOptions {
  /** Share of hotels that have a sale window (0..1). */
  saleShare?: number;
  /** Extra multiplier on every price, e.g. to simulate a deal disappearing. */
  priceFactor?: (q: HotelQuery, sourceId: string) => number;
  /** Day the sale windows are placed relative to (default: today, UTC). */
  today?: string;
}

export function mockHotelSource(opts: MockHotelOptions = {}): HotelSource {
  const saleShare = opts.saleShare ?? 0.12;
  const today = Date.parse((opts.today ?? new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  return {
    name: 'mock',
    async search(q: HotelQuery): Promise<HotelResult> {
      const base = BASE[regionOf(q.city) ?? 'india'] ?? 6000;
      const d = Date.parse(q.checkin + 'T00:00:00Z');
      const doy = Math.floor((d - Date.UTC(new Date(d).getUTCFullYear(), 0, 1)) / 864e5);
      const season = 1 + 0.15 * Math.cos(((doy - 355) / 365) * 2 * Math.PI);       // peak around Christmas
      const offers: HotelOffer[] = [];
      for (let i = 0; i < MOCK_HOTELS_PER_CITY; i++) {
        const id = `mock-${q.city}-${i}`;
        const stars = 2 + Math.floor(hash(id + '|stars') * 4);
        const rating = Math.round((6.5 + 2.9 * hash(id + '|rating')) * 10) / 10;
        const noise = 0.94 + 0.12 * hash(`${id}|${q.checkin}|${q.nights}`);
        let perNight = base * STAR_FACTOR[stars] * (0.8 + 0.4 * hash(id + '|base')) * season * noise;
        // Sale window 9 to 23 weeks out, so the hotel has built up price history before it starts
        if (hash(id + '|sale') < saleShare) {
          const start = today + (63 + Math.floor(hash(id + '|start') * 100)) * 864e5;
          if (d >= start && d < start + 12 * 864e5) perNight *= 0.6;
        }
        perNight = Math.round(perNight * (opts.priceFactor?.(q, id) ?? 1));
        offers.push({
          sourceId: id, name: `${NAMES[i]} ${KINDS[Math.floor(hash(id + '|kind') * KINDS.length)]} ${q.query.split(',')[0]}`,
          stars, rating, reviews: 50 + Math.floor(hash(id + '|reviews') * 4000),
          area: AREAS[Math.floor(hash(id + '|area') * AREAS.length)], lat: null, lng: null, imageUrl: null,
          perNight, total: perNight * q.nights, provider: 'Simulated Travel',
        });
      }
      return { offers, source: 'mock', credits: 0 };
    },
  };
}
