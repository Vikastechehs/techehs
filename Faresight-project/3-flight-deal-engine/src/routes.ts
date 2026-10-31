// Starting route list for India (spec: Route list). 6 big airports x 40 destinations + 6 smaller airports x 10.
import type { Db } from './db.ts';

export const AIRPORTS: Record<string, [city: string, country: string]> = {
  // India
  DEL: ['Delhi', 'IN'], BOM: ['Mumbai', 'IN'], BLR: ['Bengaluru', 'IN'], MAA: ['Chennai', 'IN'], HYD: ['Hyderabad', 'IN'],
  CCU: ['Kolkata', 'IN'], COK: ['Kochi', 'IN'], AMD: ['Ahmedabad', 'IN'], PNQ: ['Pune', 'IN'], GOX: ['Goa (Mopa)', 'IN'],
  JAI: ['Jaipur', 'IN'], LKO: ['Lucknow', 'IN'],
  // Southeast Asia
  BKK: ['Bangkok', 'TH'], HKT: ['Phuket', 'TH'], KUL: ['Kuala Lumpur', 'MY'], SIN: ['Singapore', 'SG'], DPS: ['Bali', 'ID'],
  SGN: ['Ho Chi Minh City', 'VN'], HAN: ['Hanoi', 'VN'], CGK: ['Jakarta', 'ID'], MNL: ['Manila', 'PH'], DMK: ['Bangkok Don Mueang', 'TH'],
  // South Asia and Gulf
  CMB: ['Colombo', 'LK'], MLE: ['Male', 'MV'], KTM: ['Kathmandu', 'NP'], DXB: ['Dubai', 'AE'], AUH: ['Abu Dhabi', 'AE'],
  SHJ: ['Sharjah', 'AE'], DOH: ['Doha', 'QA'], MCT: ['Muscat', 'OM'],
  // East and Central Asia
  NRT: ['Tokyo', 'JP'], ICN: ['Seoul', 'KR'], HKG: ['Hong Kong', 'HK'], ALA: ['Almaty', 'KZ'], TAS: ['Tashkent', 'UZ'],
  GYD: ['Baku', 'AZ'], TBS: ['Tbilisi', 'GE'],
  // Europe
  LHR: ['London', 'GB'], CDG: ['Paris', 'FR'], AMS: ['Amsterdam', 'NL'], FRA: ['Frankfurt', 'DE'], MUC: ['Munich', 'DE'],
  FCO: ['Rome', 'IT'], MXP: ['Milan', 'IT'], BCN: ['Barcelona', 'ES'], IST: ['Istanbul', 'TR'], PRG: ['Prague', 'CZ'], VIE: ['Vienna', 'AT'],
  // Long haul
  JFK: ['New York', 'US'], SFO: ['San Francisco', 'US'], YYZ: ['Toronto', 'CA'], SYD: ['Sydney', 'AU'],
};

type Group = { dests: string[]; haul: 'short' | 'medium' | 'long'; trips: number[] };
const GROUPS: Record<string, Group> = {
  seAsia:   { dests: ['BKK', 'HKT', 'KUL', 'SIN', 'DPS', 'SGN', 'HAN', 'CGK', 'MNL', 'DMK'], haul: 'medium', trips: [7, 5, 9] },
  saGulf:   { dests: ['CMB', 'MLE', 'KTM', 'DXB', 'AUH', 'SHJ', 'DOH', 'MCT'], haul: 'short', trips: [4, 3, 6] },
  eastAsia: { dests: ['NRT', 'ICN', 'HKG', 'ALA', 'TAS', 'GYD', 'TBS'], haul: 'medium', trips: [7, 5, 10] },
  europe:   { dests: ['LHR', 'CDG', 'AMS', 'FRA', 'MUC', 'FCO', 'MXP', 'BCN', 'IST', 'PRG', 'VIE'], haul: 'long', trips: [10, 7, 14] },
  longHaul: { dests: ['JFK', 'SFO', 'YYZ', 'SYD'], haul: 'long', trips: [12, 10, 14] },
};
const TIER_A = ['DEL', 'BOM', 'BLR', 'MAA', 'HYD', 'CCU'];
const TIER_B = ['COK', 'AMD', 'PNQ', 'GOX', 'JAI', 'LKO'];
const TIER_B_DESTS = ['BKK', 'HKT', 'KUL', 'SIN', 'DPS', 'CMB', 'DXB', 'SHJ', 'DOH', 'MCT'];

export type RouteSeed = { origin: string; destination: string; haul: string; trips: number[]; priority: number };
export function indiaRoutes(): RouteSeed[] {
  const out: RouteSeed[] = [];
  const groupOf = (d: string) => Object.values(GROUPS).find(g => g.dests.includes(d))!;
  for (const o of TIER_A) for (const g of Object.values(GROUPS)) for (const d of g.dests)
    out.push({ origin: o, destination: d, haul: g.haul, trips: g.trips, priority: 2 });
  for (const o of TIER_B) for (const d of TIER_B_DESTS) { const g = groupOf(d); out.push({ origin: o, destination: d, haul: g.haul, trips: g.trips, priority: 1 }); }
  return out;
}

export async function seed(db: Db) {
  await db.query(`INSERT INTO markets (code, currency, gl) VALUES ('IN', 'INR', 'in') ON CONFLICT (code) DO NOTHING`);
  for (const [iata, [city, country]] of Object.entries(AIRPORTS))
    await db.query('INSERT INTO airports (iata, city, country) VALUES ($1,$2,$3) ON CONFLICT (iata) DO UPDATE SET city = EXCLUDED.city', [iata, city, country]);
  let added = 0;
  for (const r of indiaRoutes()) {
    const res = await db.query(
      `INSERT INTO routes (market, origin, destination, haul, max_stops, trip_lengths, priority)
       VALUES ('IN', $1, $2, $3, 1, $4, $5) ON CONFLICT (market, origin, destination) DO NOTHING RETURNING id`,
      [r.origin, r.destination, r.haul, r.trips, r.priority]);
    added += res.length;
  }
  return added;
}
