// Decides what to search next: the weekly sweep calendar per route, within the credit budget.
import type { Db, Settings } from './db.ts';

/** Credits spent this calendar month (from finished jobs). */
export async function creditsThisMonth(db: Db): Promise<number> {
  const [r] = await db.query(`SELECT coalesce(sum(credits), 0)::int AS c FROM search_jobs
                              WHERE finished_at >= date_trunc('month', now())`);
  return r.c;
}

/** Jobs that were "running" for over 10 minutes (a crashed worker) go back to the queue. */
export async function requeueStuck(db: Db) {
  const rows = await db.query(`UPDATE search_jobs SET status = 'queued', run_at = now()
                               WHERE status = 'running' AND started_at < now() - interval '10 minutes' RETURNING id`);
  return rows.length;
}

/**
 * Light sweep. Every route has a grid of departure dates (one every `sweep_step_days`, up to
 * `sweep_horizon_days` ahead, phase-shifted per route so weekdays vary). A date is due when it hasn't
 * been priced at the route's main trip length within the refresh interval (shorter for the next 4 weeks).
 * Enqueues at most a day's share of the monthly budget, highest priority and nearest dates first.
 */
export async function scheduleSweeps(db: Db, s: Settings, opts: { limit?: number; market?: string } = {}) {
  const budget = s.num('monthly_credit_budget');
  const perSearch = s.num('credits_per_search');
  const spent = await creditsThisMonth(db);
  if (perSearch > 0 && spent >= budget) return { enqueued: 0, reason: 'monthly credit budget used up' };

  // Daily allowance: what's left of the budget spread over the rest of the month
  const [{ days_left, today_sweeps }] = await db.query(`
    SELECT extract(epoch FROM (date_trunc('month', now()) + interval '1 month' - now())) / 86400 AS days_left,
           (SELECT count(*)::int FROM search_jobs WHERE kind = 'sweep' AND created_at >= date_trunc('day', now())) AS today_sweeps`);
  const dailyAllowance = perSearch > 0
    ? Math.min(s.num('daily_search_cap'), Math.floor((budget - spent) / perSearch / Math.max(1, Number(days_left))))
    : Number.MAX_SAFE_INTEGER;
  const room = Math.max(0, Math.min(opts.limit ?? Infinity, dailyAllowance - today_sweeps));
  if (room === 0) return { enqueued: 0, reason: 'daily allowance reached' };

  const rows = await db.query(`
    WITH grid AS (
      SELECT r.id AS route_id, r.priority, r.trip_lengths[1] AS nights,
             (current_date + 2 + (r.id % $1) + g * $1)::date AS depart
      FROM routes r JOIN markets m ON m.code = r.market AND m.active
      CROSS JOIN generate_series(0, ($2::int / $1::int)) AS g
      WHERE r.active AND ($3::text IS NULL OR r.market = $3)
    ),
    due AS (
      SELECT g.*, (g.depart + g.nights)::date AS return_date,
             (SELECT max(o.observed_at) FROM price_observations o
               WHERE o.route_id = g.route_id AND o.depart = g.depart AND o.nights = g.nights) AS last_seen
      FROM grid g
      WHERE g.depart <= current_date + $2::int
    )
    INSERT INTO search_jobs (kind, route_id, depart, return_date)
    SELECT 'sweep', route_id, depart, return_date FROM due
    WHERE last_seen IS NULL
       OR last_seen < now() - make_interval(secs => 86400 *
            CASE WHEN depart <= current_date + $4::int THEN $5::float8 ELSE $6::float8 END)
    ORDER BY priority DESC, (last_seen IS NOT NULL), depart
    LIMIT $7
    ON CONFLICT DO NOTHING
    RETURNING id`,
    [s.num('sweep_step_days'), s.num('sweep_horizon_days'), opts.market ?? null,
     s.num('near_term_days'), s.num('sweep_refresh_days_near'), s.num('sweep_refresh_days'),
     Number.isFinite(room) ? room : 1_000_000]);
  return { enqueued: rows.length, reason: null };
}

export async function queueStats(db: Db) {
  return db.query(`SELECT kind, status, count(*)::int AS n FROM search_jobs GROUP BY kind, status ORDER BY kind, status`);
}
