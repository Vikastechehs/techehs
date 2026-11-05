// Lookups shared by the user pages: origin airports, regions of destinations.
import type { Db } from '../../db.ts';

export { REGION_DESTS, regionOf } from '../../notify/regions.ts';
export const REGION_NAMES: Record<string, string> = {
  seAsia: 'Southeast Asia', saGulf: 'South Asia and the Gulf', eastAsia: 'East and Central Asia', europe: 'Europe', longHaul: 'USA, Canada and Australia',
};

export type Origin = { origin: string; city: string };
/** Airports that have at least one active route, biggest first (most routes). */
export async function origins(db: Db): Promise<Origin[]> {
  return db.query<Origin>(`SELECT r.origin, a.city FROM routes r JOIN airports a ON a.iata = r.origin WHERE r.active
                           GROUP BY r.origin, a.city ORDER BY count(*) DESC, a.city`);
}

export const HOTEL_REGION_NAMES: Record<string, string> = { india: 'India', ...REGION_NAMES, other: 'More cities' };

export type HotelCity = { code: string; name: string; country: string; region: string | null };
/** Active hotel cities, grouped by region (India first), busiest first within a region. */
export async function hotelCities(db: Db): Promise<HotelCity[]> {
  return db.query<HotelCity>(`SELECT code, name, country, region FROM hotel_cities WHERE active
    ORDER BY CASE WHEN region = 'india' THEN 0 WHEN region IS NULL THEN 2 ELSE 1 END, region, priority DESC, name`);
}
/** Hotel cities as [region name, cities] groups, in display order. */
export function groupByRegion(cities: HotelCity[]): [string, HotelCity[]][] {
  const groups = new Map<string, HotelCity[]>();
  for (const c of cities) {
    const k = c.region && HOTEL_REGION_NAMES[c.region] ? HOTEL_REGION_NAMES[c.region] : HOTEL_REGION_NAMES.other;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  return [...groups];
}
