// A hotel's normal per-night price: the median of its recent sweep prices for check-ins near the date in question.
import type { Db, Settings } from '../db.ts';

/**
 * Samples needed in the ±norm_window_days window before it is trusted. Hotels are swept once a week per
 * city, so a ±21-day window holds about 6-7 prices; 4 keeps the window usable near the horizon's ends.
 */
export const HOTEL_NORM_MIN_SAMPLES = 4;

export type HotelNorm = { perNight: number; samples: number; basis: string };
export type HotelNormInfo = { history: number; norm: HotelNorm | null };

/**
 * Normal per-night price for several hotels around one check-in date, plus each hotel's sweep history
 * (all-time count of sweep prices), in one query. Only sweep prices count: deep checks and re-checks
 * cluster around cheap dates and would drag the median down.
 * Tries: check-ins within ±norm_window_days seen in the last norm_lookback_days; then the hotel's
 * median over all check-ins seen in that lookback.
 */
export async function hotelNormals(db: Db, s: Settings, hotelIds: number[], checkin: string): Promise<Map<number, HotelNormInfo>> {
  const out = new Map<number, HotelNormInfo>();
  if (!hotelIds.length) return out;
  const rows = await db.query(`
    WITH o AS (
      SELECT hotel_id, per_night, checkin, observed_at > now() - make_interval(days => $3) AS recent
      FROM hotel_prices WHERE hotel_id = ANY($1::int[]) AND kind = 'sweep'
    )
    SELECT hotel_id, count(*)::int AS history,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY per_night) FILTER (WHERE recent AND checkin BETWEEN $2::date - $4::int AND $2::date + $4::int) AS near_p,
      (count(*) FILTER (WHERE recent AND checkin BETWEEN $2::date - $4::int AND $2::date + $4::int))::int AS near_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY per_night) FILTER (WHERE recent) AS all_p,
      (count(*) FILTER (WHERE recent))::int AS all_n
    FROM o GROUP BY hotel_id`,
    [hotelIds, checkin, s.num('norm_lookback_days'), s.num('norm_window_days')]);
  for (const r of rows) {
    let norm: HotelNorm | null = null;
    if (r.near_n >= HOTEL_NORM_MIN_SAMPLES && r.near_p != null) norm = { perNight: Math.round(Number(r.near_p)), samples: r.near_n, basis: 'nearby check-ins' };
    else if (r.all_n >= HOTEL_NORM_MIN_SAMPLES && r.all_p != null) norm = { perNight: Math.round(Number(r.all_p)), samples: r.all_n, basis: 'all check-ins' };
    out.set(r.hotel_id, { history: r.history, norm });
  }
  return out;
}

/** Normal per-night price for one hotel around one check-in date (null = not enough data). */
export async function hotelNormal(db: Db, s: Settings, hotelId: number, checkin: string): Promise<HotelNorm | null> {
  return (await hotelNormals(db, s, [hotelId], checkin)).get(hotelId)?.norm ?? null;
}

/** Summary per hotel and check-in month (for pages and the admin), from recent sweep prices. */
export async function rebuildHotelNorms(db: Db, s: Settings) {
  await db.query(`DELETE FROM hotel_norms`);
  const rows = await db.query(`
    INSERT INTO hotel_norms (hotel_id, month, median_per_night, sample_size)
    SELECT hotel_id, date_trunc('month', checkin)::date, percentile_cont(0.5) WITHIN GROUP (ORDER BY per_night), count(*)
    FROM hotel_prices
    WHERE kind = 'sweep' AND observed_at > now() - make_interval(days => $1)
    GROUP BY 1, 2 RETURNING hotel_id`, [s.num('norm_lookback_days')]);
  return rows.length;
}
