// Lookups shared by the user pages: origin airports, regions of destinations.
import type { Db } from '../../db.ts';

/** Destination regions (same groups as src/routes.ts, which doesn't export them). */
export const REGION_DESTS: Record<string, string[]> = {
  seAsia: ['BKK', 'HKT', 'KUL', 'SIN', 'DPS', 'SGN', 'HAN', 'CGK', 'MNL', 'DMK'],
  saGulf: ['CMB', 'MLE', 'KTM', 'DXB', 'AUH', 'SHJ', 'DOH', 'MCT'],
  eastAsia: ['NRT', 'ICN', 'HKG', 'ALA', 'TAS', 'GYD', 'TBS'],
  europe: ['LHR', 'CDG', 'AMS', 'FRA', 'MUC', 'FCO', 'MXP', 'BCN', 'IST', 'PRG', 'VIE'],
  longHaul: ['JFK', 'SFO', 'YYZ', 'SYD'],
};
export const REGION_NAMES: Record<string, string> = {
  seAsia: 'Southeast Asia', saGulf: 'South Asia and the Gulf', eastAsia: 'East and Central Asia', europe: 'Europe', longHaul: 'USA, Canada and Australia',
};
export const regionOf = (iata: string) => Object.keys(REGION_DESTS).find(k => REGION_DESTS[k].includes(iata)) ?? null;

export type Origin = { origin: string; city: string };
/** Airports that have at least one active route, biggest first (most routes). */
export async function origins(db: Db): Promise<Origin[]> {
  return db.query<Origin>(`SELECT r.origin, a.city FROM routes r JOIN airports a ON a.iata = r.origin WHERE r.active
                           GROUP BY r.origin, a.city ORDER BY count(*) DESC, a.city`);
}
