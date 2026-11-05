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
