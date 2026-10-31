// The route's normal price: the median of recent prices for departures near the date in question.
import type { Db, Settings } from '../db.ts';

export const tripBand = (nights: number) => (nights <= 5 ? 'short' : nights <= 9 ? 'mid' : 'long');
const BAND_SQL = `CASE WHEN nights <= 5 THEN 'short' WHEN nights <= 9 THEN 'mid' ELSE 'long' END`;

export type Norm = { price: number; samples: number; basis: string };

/**
 * Only sweep prices count: deep checks and re-checks cluster around cheap dates and would drag the median down.
 * Median price for this route around `depart`, from prices seen in the last `norm_lookback_days`.
 * Tries, in order: same trip-length band within ±norm_window_days; any trip length in that window;
 * same band over the whole horizon; any trip length over the whole horizon.
 */
export async function normalPrice(db: Db, s: Settings, routeId: number, depart: string, nights: number): Promise<Norm | null> {
  const win = s.num('norm_window_days'), back = s.num('norm_lookback_days'), min = s.num('norm_min_samples');
  const [r] = await db.query(`
    WITH o AS (
      SELECT price, depart, ${BAND_SQL} AS band FROM price_observations
      WHERE route_id = $1 AND price IS NOT NULL AND kind = 'sweep' AND observed_at > now() - make_interval(days => $4)
    )
    SELECT
      (SELECT json_build_object('p', percentile_cont(0.5) WITHIN GROUP (ORDER BY price), 'n', count(*)) FROM o WHERE band = $3 AND depart BETWEEN $2::date - $5::int AND $2::date + $5::int) AS a,
      (SELECT json_build_object('p', percentile_cont(0.5) WITHIN GROUP (ORDER BY price), 'n', count(*)) FROM o WHERE depart BETWEEN $2::date - $5::int AND $2::date + $5::int) AS b,
      (SELECT json_build_object('p', percentile_cont(0.5) WITHIN GROUP (ORDER BY price), 'n', count(*)) FROM o WHERE band = $3) AS c,
      (SELECT json_build_object('p', percentile_cont(0.5) WITHIN GROUP (ORDER BY price), 'n', count(*)) FROM o) AS d`,
    [routeId, depart, tripBand(nights), back, win]);
  const tiers: [string, any][] = [['same trip length, nearby dates', r.a], ['any trip length, nearby dates', r.b],
                                  ['same trip length, 9 months', r.c], ['any trip length, 9 months', r.d]];
  for (const [basis, v] of tiers) {
    const t = typeof v === 'string' ? JSON.parse(v) : v;
    if (t && t.n >= min && t.p != null) return { price: Math.round(Number(t.p)), samples: Number(t.n), basis };
  }
  return null;
}

/** Nightly summary per route, departure month and trip band (for the dashboard and route pages). */
export async function rebuildRouteNorms(db: Db, s: Settings) {
  await db.query(`DELETE FROM route_norms`);
  const rows = await db.query(`
    INSERT INTO route_norms (route_id, month, trip_band, median_price, sample_size)
    SELECT route_id, date_trunc('month', depart)::date, ${BAND_SQL},
           percentile_cont(0.5) WITHIN GROUP (ORDER BY price), count(*)
    FROM price_observations
    WHERE price IS NOT NULL AND kind = 'sweep' AND observed_at > now() - make_interval(days => $1)
    GROUP BY 1, 2, 3 RETURNING route_id`, [s.num('norm_lookback_days')]);
  return rows.length;
}
