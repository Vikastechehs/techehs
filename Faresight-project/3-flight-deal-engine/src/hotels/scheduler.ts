// Hotel sweep calendar: per active city, one check-in every hotel_sweep_step_days up to
// hotel_sweep_horizon_days ahead at the city's first stay length, re-priced every hotel_sweep_refresh_days.
// Shares the monthly credit budget with flights (creditsThisMonth counts both job tables).
import type { Db, Settings } from '../db.ts';
import { creditsThisMonth } from '../scheduler.ts';

/** Hotel jobs "running" for over 10 minutes (a crashed worker) go back to the queue. */
export async function requeueStuckHotelJobs(db: Db) {
  const rows = await db.query(`UPDATE hotel_search_jobs SET status = 'queued', run_at = now()
                               WHERE status = 'running' AND started_at < now() - interval '10 minutes' RETURNING id`);
  return rows.length;
}

export async function scheduleHotelSweeps(db: Db, s: Settings, opts: { limit?: number } = {}) {
  const budget = s.num('monthly_credit_budget');
  const perSearch = s.num('credits_per_search');
  const spent = await creditsThisMonth(db);
  if (perSearch > 0 && spent >= budget) return { enqueued: 0, reason: 'monthly credit budget used up' };

  const [{ days_left, today_sweeps }] = await db.query(`
    SELECT extract(epoch FROM (date_trunc('month', now()) + interval '1 month' - now())) / 86400 AS days_left,
           (SELECT count(*)::int FROM hotel_search_jobs WHERE kind = 'sweep' AND created_at >= date_trunc('day', now())) AS today_sweeps`);
  const cap = s.num('hotel_daily_search_cap');
  const dailyAllowance = perSearch > 0
    ? Math.min(cap, Math.floor((budget - spent) / perSearch / Math.max(1, Number(days_left))))
    : cap;
  const room = Math.max(0, Math.min(opts.limit ?? Infinity, dailyAllowance - today_sweeps));
  if (room === 0) return { enqueued: 0, reason: 'daily allowance reached' };

  const rows = await db.query(`
    WITH grid AS (
      SELECT c.code AS city, c.priority, c.stay_nights[1] AS nights,
             (current_date + 2 + (abs(hashtext(c.code)) % $1::int) + g * $1::int)::date AS checkin
      FROM hotel_cities c CROSS JOIN generate_series(0, ($2::int / $1::int)) AS g
      WHERE c.active
    ),
    recent AS (
      SELECT city, checkin, nights, max(finished_at) AS last_seen FROM hotel_search_jobs
      WHERE kind = 'sweep' AND status = 'done' AND finished_at > now() - make_interval(secs => 86400 * $3::float8)
      GROUP BY 1, 2, 3
    )
    INSERT INTO hotel_search_jobs (kind, city, checkin, nights)
    SELECT 'sweep', g.city, g.checkin, g.nights
    FROM grid g LEFT JOIN recent r ON r.city = g.city AND r.checkin = g.checkin AND r.nights = g.nights
    WHERE g.checkin <= current_date + $2::int AND r.last_seen IS NULL
    ORDER BY g.checkin, g.priority DESC, g.city
    LIMIT $4
    ON CONFLICT DO NOTHING
    RETURNING id`,
    [s.num('hotel_sweep_step_days'), s.num('hotel_sweep_horizon_days'), s.num('hotel_sweep_refresh_days'),
     Number.isFinite(room) ? room : 1_000_000]);
  return { enqueued: rows.length, reason: null };
}

export async function hotelQueueStats(db: Db) {
  return db.query(`SELECT kind, status, count(*)::int AS n FROM hotel_search_jobs GROUP BY kind, status ORDER BY kind, status`);
}
