// Hotel cities: the international flight destinations (so a flight deal and a hotel deal can meet) plus
// India's leisure and big-city destinations. code = airport IATA, query = text sent to the hotel source.
import type { Db } from '../db.ts';
import { AIRPORTS } from '../routes.ts';
import { regionOf } from '../notify/regions.ts';

const COUNTRY: Record<string, string> = {
  IN: 'India', TH: 'Thailand', MY: 'Malaysia', SG: 'Singapore', ID: 'Indonesia', VN: 'Vietnam', PH: 'Philippines',
  LK: 'Sri Lanka', MV: 'Maldives', NP: 'Nepal', AE: 'United Arab Emirates', QA: 'Qatar', OM: 'Oman',
  JP: 'Japan', KR: 'South Korea', HK: 'Hong Kong', KZ: 'Kazakhstan', UZ: 'Uzbekistan', AZ: 'Azerbaijan', GE: 'Georgia',
  GB: 'United Kingdom', FR: 'France', NL: 'Netherlands', DE: 'Germany', IT: 'Italy', ES: 'Spain', TR: 'Turkey',
  CZ: 'Czechia', AT: 'Austria', US: 'United States', CA: 'Canada', AU: 'Australia',
};

/** Indian hotel cities (region 'india'). Udaipur has no flight route but is a top leisure stay. */
const INDIA: [code: string, name: string][] = [
  ['GOX', 'Goa'], ['JAI', 'Jaipur'], ['COK', 'Kochi'], ['DEL', 'Delhi'], ['BOM', 'Mumbai'], ['BLR', 'Bengaluru'], ['UDR', 'Udaipur'],
];
/** Airports that duplicate another hotel city (Don Mueang = Bangkok). */
const SKIP = new Set(['DMK']);

export type HotelCitySeed = { code: string; name: string; country: string; region: string; query: string; stayNights: number[]; priority: number };

export function hotelCities(): HotelCitySeed[] {
  const out: HotelCitySeed[] = [];
  for (const [code, [name, country]] of Object.entries(AIRPORTS)) {
    if (country === 'IN' || SKIP.has(code)) continue;
    const region = regionOf(code) ?? 'other';
    const far = region === 'europe' || region === 'longHaul';
    // City-states read better without a repeated country ("Singapore", "Hong Kong")
    const query = COUNTRY[country] && COUNTRY[country] !== name ? `${name}, ${COUNTRY[country]}` : name;
    out.push({ code, name, country, region, query, stayNights: far ? [5, 4, 7] : [3, 2, 5], priority: far ? 1 : 2 });
  }
  for (const [code, name] of INDIA)
    out.push({ code, name, country: 'IN', region: 'india', query: `${name}, India`, stayNights: [3, 2, 5], priority: 2 });
  return out;
}

/** Adds missing hotel cities; existing rows (and admin edits to them) are left alone. Returns how many were added. */
export async function seedHotelCities(db: Db) {
  let added = 0;
  for (const c of hotelCities()) {
    const r = await db.query(`INSERT INTO hotel_cities (code, name, country, region, query, stay_nights, priority)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING RETURNING code`,
      [c.code, c.name, c.country, c.region, c.query, c.stayNights, c.priority]);
    added += r.length;
  }
  return added;
}
