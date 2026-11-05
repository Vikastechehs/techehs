// Deal lifecycle: candidate -> deep check -> review/live -> re-checked every few hours -> expired.
import type { Db, Settings } from '../db.ts';
import type { Job, Observation } from '../worker.ts';
import { normalPrice } from './norms.ts';

export type Notify = (dealId: number) => Promise<void>;

// Called after a live deal expires (e.g. to tell users who were alerted). Set once at startup; errors are logged, not thrown.
let dealEndedHook: Notify | null = null;
export function setDealEndedHook(fn: Notify | null) { dealEndedHook = fn; }
async function dealEnded(dealId: number) {
  if (!dealEndedHook) return;
  try { await dealEndedHook(dealId); } catch (e) { console.error(`deal ended hook (deal ${dealId}): ${(e as Error).message}`); }
}
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/** Does a price pass the deal test against its normal price? */
export function passes(s: Settings, haul: string, price: number, normal: number) {
  const minSaving = haul === 'long' ? s.num('min_saving_long') : s.num('min_saving_short');
  return price <= normal * s.num('deal_max_ratio') && normal - price >= minSaving;
}

async function routeHistory(db: Db, routeId: number) {
  const [r] = await db.query(`SELECT count(*)::int AS n FROM price_observations WHERE route_id = $1 AND price IS NOT NULL AND kind = 'sweep'`, [routeId]);
  return r.n as number;
}

/** Called after every finished search. */
export function makeAfterSearch(db: Db, getSettings: () => Promise<Settings>, notify: Notify) {
  return async (job: Job, obs: Observation) => {
    const s = await getSettings();
    if (job.kind === 'sweep') await onSweep(db, s, job, obs, notify);
    else if (job.kind === 'deep' && job.deal_id) await maybeFinishDeep(db, s, job.deal_id, notify);
    else if (job.kind === 'verify' && job.deal_id) await maybeFinishVerify(db, s, job.deal_id);
  };
}

/** A sweep price far below normal opens a candidate deal and queues the deep check around it. */
export async function onSweep(db: Db, s: Settings, job: Job, obs: Observation, notify: Notify) {
  if (obs.price == null) return;
  if ((await routeHistory(db, job.route_id)) < s.num('route_min_history')) return;
  const norm = await normalPrice(db, s, job.route_id, job.depart, obs.nights);
  if (!norm || !passes(s, job.haul, obs.price, norm.price)) return;

  const month = job.depart.slice(0, 7) + '-01';
  const saving = Math.round((1 - obs.price / norm.price) * 1000) / 10;
  // A sale that spans a month boundary is one deal: reuse an open deal on this route in this or a neighbouring month
  const [nearby] = await db.query(`SELECT id FROM deals WHERE route_id = $1 AND status IN ('candidate','review','live')
    AND month BETWEEN $2::date - interval '1 month' AND $2::date + interval '1 month' ORDER BY abs(month - $2::date) LIMIT 1`, [job.route_id, month]);
  const created = nearby ? [] : await db.query<{ id: number }>(`
    INSERT INTO deals (route_id, month, price, normal_price, saving_pct, currency, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'candidate') ON CONFLICT DO NOTHING RETURNING id`,
    [job.route_id, month, obs.price, norm.price, saving, obs.currency]);

  if (created.length === 0) {
    // A deal is already open for this route. If it's live, add this date pair (and lower the price).
    const [open] = await db.query(`SELECT id, status, price FROM deals WHERE route_id = $1 AND status IN ('candidate','review','live')
      AND month BETWEEN $2::date - interval '1 month' AND $2::date + interval '1 month' ORDER BY abs(month - $2::date) LIMIT 1`, [job.route_id, month]);
    if (open?.status === 'live') {
      await addDealDate(db, open.id, job, obs, norm.price);
      if (obs.price < open.price) await db.query(`UPDATE deals SET price = $2, normal_price = $3, saving_pct = $4 WHERE id = $1`, [open.id, obs.price, norm.price, saving]);
    }
    return;
  }
  const dealId = created[0].id;
  // Two scans on the same route can finish at once and both open a deal in neighbouring months; the older one wins
  const [older] = await db.query(`SELECT id FROM deals WHERE route_id = $1 AND id < $2 AND status IN ('candidate','review','live')
    AND month BETWEEN $3::date - interval '1 month' AND $3::date + interval '1 month' LIMIT 1`, [job.route_id, dealId, month]);
  if (older) { await db.query(`DELETE FROM deals WHERE id = $1`, [dealId]); return; }
  // Deep check: every departure within N days either side, at each of the route's trip lengths
  const [route] = await db.query(`SELECT trip_lengths FROM routes WHERE id = $1`, [job.route_id]);
  const firstDay = addDays(new Date().toISOString().slice(0, 10), 2);
  const n = s.num('deep_days_each_side');
  const values: string[] = []; const params: unknown[] = [job.route_id, dealId];
  for (let k = -n; k <= n; k++) {
    const dep = addDays(job.depart, k);
    if (dep < firstDay) continue;
    for (const nights of route.trip_lengths as number[]) {
      params.push(dep, addDays(dep, nights));
      values.push(`('deep', $1, $2, $${params.length - 1}::date, $${params.length}::date)`);
    }
  }
  if (values.length) {
    await db.query(`INSERT INTO search_jobs (kind, route_id, deal_id, depart, return_date) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
  } else {
    await maybeFinishDeep(db, s, dealId, notify);
  }
}

async function addDealDate(db: Db, dealId: number, job: { depart: string; return_date: string }, obs: { price: number | null }, normal: number, airlines?: string | null, stops?: number | null) {
  await db.query(`
    INSERT INTO deal_dates (deal_id, depart, return_date, price, normal_price, airlines, stops)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (deal_id, depart, return_date) DO UPDATE SET price = EXCLUDED.price, normal_price = EXCLUDED.normal_price, last_checked = now()`,
    [dealId, job.depart, job.return_date, obs.price, normal, airlines ?? null, stops ?? null]);
}

const openJobs = async (db: Db, dealId: number, kind: string) =>
  (await db.query(`SELECT count(*)::int AS n FROM search_jobs WHERE deal_id = $1 AND kind = $2 AND status IN ('queued','running')`, [dealId, kind]))[0].n as number;

/** When all deep-check searches for a candidate are done, confirm or reject it. */
export async function maybeFinishDeep(db: Db, s: Settings, dealId: number, notify: Notify) {
  if ((await openJobs(db, dealId, 'deep')) > 0) return;
  // Claim the evaluation so two workers finishing at once don't both do it
  const claimed = await db.query(`UPDATE deals SET reason = 'evaluating' WHERE id = $1 AND status = 'candidate' AND reason IS NULL RETURNING route_id`, [dealId]);
  if (!claimed.length) return;
  const routeId = claimed[0].route_id;
  const [route] = await db.query(`SELECT haul FROM routes WHERE id = $1`, [routeId]);
  // The deep-check prices plus the sweep price that triggered the candidate
  const obs = await db.query(`
    SELECT DISTINCT ON (o.depart, o.return_date) o.depart::text AS depart, o.return_date::text AS return_date, o.nights, o.price, o.airlines, o.stops
    FROM price_observations o
    JOIN deals d ON d.id = $1
    WHERE o.route_id = d.route_id AND o.price IS NOT NULL
      AND o.job_id IN (SELECT id FROM search_jobs WHERE deal_id = $1 AND kind = 'deep')
    ORDER BY o.depart, o.return_date, o.observed_at DESC`, [dealId]);
  const passing: any[] = [];
  for (const o of obs) {
    const norm = await normalPrice(db, s, routeId, o.depart, o.nights);
    if (norm && passes(s, route.haul, o.price, norm.price)) passing.push({ ...o, normal: norm.price });
  }
  if (passing.length < s.num('min_passing_pairs')) {
    await db.query(`UPDATE deals SET status = 'rejected', reason = $2, expired_at = now() WHERE id = $1`,
      [dealId, `only ${passing.length} of ${obs.length} date pairs passed the deep check`]);
    return;
  }
  for (const p of passing) await addDealDate(db, dealId, p, p, p.normal, p.airlines, p.stops);
  const best = passing.reduce((a, b) => (b.price < a.price ? b : a));
  const saving = Math.round((1 - best.price / best.normal) * 1000) / 10;
  const live = s.bool('auto_approve');
  await db.query(`
    UPDATE deals SET price = $2, normal_price = $3, saving_pct = $4, status = $5, reason = NULL,
           published_at = CASE WHEN $5 = 'live' THEN now() END, last_verified = now()
    WHERE id = $1`, [dealId, best.price, best.normal, saving, live ? 'live' : 'review']);
  if (live) await notify(dealId);
}

/** Admin decision on a deal waiting for review. */
export async function reviewDeal(db: Db, dealId: number, approve: boolean, notify: Notify) {
  const rows = await db.query(`
    UPDATE deals SET status = $2, published_at = CASE WHEN $2 = 'live' THEN now() END,
           reason = CASE WHEN $2 = 'rejected' THEN 'rejected by admin' END,
           expired_at = CASE WHEN $2 = 'rejected' THEN now() END
    WHERE id = $1 AND status = 'review' RETURNING id`, [dealId, approve ? 'live' : 'rejected']);
  if (rows.length && approve) await notify(dealId);
  return rows.length > 0;
}

/** Queue re-checks for live deals not verified in the last N hours: their cheapest future date pairs. */
export async function scheduleVerifies(db: Db, s: Settings) {
  const rows = await db.query(`
    INSERT INTO search_jobs (kind, route_id, deal_id, depart, return_date)
    SELECT 'verify', d.route_id, d.id, dd.depart, dd.return_date
    FROM deals d
    CROSS JOIN LATERAL (
      SELECT depart, return_date FROM deal_dates
      WHERE deal_id = d.id AND depart >= current_date + 2
      ORDER BY price, depart LIMIT $2
    ) dd
    WHERE d.status = 'live'
      AND d.last_verified < now() - make_interval(hours => $1)
      AND NOT EXISTS (SELECT 1 FROM search_jobs j WHERE j.deal_id = d.id AND j.kind = 'verify' AND j.status IN ('queued','running'))
    ON CONFLICT DO NOTHING RETURNING id`, [s.num('verify_every_hours'), s.num('verify_pairs')]);
  return rows.length;
}

/** When a deal's re-check round is done: keep it (maybe cheaper) or expire it. */
export async function maybeFinishVerify(db: Db, s: Settings, dealId: number) {
  if ((await openJobs(db, dealId, 'verify')) > 0) return;
  const [deal] = await db.query(`SELECT id, price, normal_price, last_verified, status FROM deals WHERE id = $1`, [dealId]);
  if (!deal || deal.status !== 'live') return;
  // Results of this round: verify jobs finished since the last verification
  const res = await db.query(`
    SELECT j.depart::text AS depart, j.return_date::text AS return_date, o.price
    FROM search_jobs j LEFT JOIN price_observations o ON o.job_id = j.id
    WHERE j.deal_id = $1 AND j.kind = 'verify' AND j.status = 'done' AND j.finished_at > $2`, [dealId, deal.last_verified]);
  if (!res.length) return;
  for (const r of res) {
    if (r.price != null) await db.query(`UPDATE deal_dates SET price = $4, last_checked = now() WHERE deal_id = $1 AND depart = $2 AND return_date = $3`, [dealId, r.depart, r.return_date, r.price]);
  }
  const prices = res.map(r => r.price).filter((p): p is number => p != null);
  const best = prices.length ? Math.min(...prices) : null;
  if (best != null && best <= deal.price * s.num('verify_tolerance')) {
    const price = Math.min(best, deal.price);
    const saving = Math.round((1 - price / deal.normal_price) * 1000) / 10;
    await db.query(`UPDATE deals SET price = $2, saving_pct = $3, last_verified = now() WHERE id = $1`, [dealId, price, saving]);
  } else {
    const ended = await db.query(`UPDATE deals SET status = 'expired', expired_at = now(), reason = $2 WHERE id = $1 AND status = 'live' RETURNING id`,
      [dealId, best == null ? 'no flights found at re-check' : `price rose to ${best} (shown ${deal.price})`]);
    if (ended.length) await dealEnded(dealId);
  }
}

/** Live deals whose date pairs have all passed are expired. */
export async function expirePastDeals(db: Db) {
  const rows = await db.query(`
    UPDATE deals d SET status = 'expired', expired_at = now(), reason = 'all dates passed'
    WHERE status IN ('live','review') AND NOT EXISTS (SELECT 1 FROM deal_dates dd WHERE dd.deal_id = d.id AND dd.depart >= current_date + 1)
    RETURNING id`);
  for (const r of rows) await dealEnded(r.id);
  return rows.length;
}

/**
 * Housekeeping, run every minute: queue re-checks, expire past deals, and finish any deep check or
 * re-check round whose last search failed (a failed search doesn't trigger the normal follow-up).
 */
export async function engineTick(db: Db, s: Settings, notify: Notify) {
  const verifies = await scheduleVerifies(db, s);
  const expired = await expirePastDeals(db);
  const stalledDeep = await db.query(`SELECT d.id FROM deals d WHERE d.status = 'candidate' AND d.reason IS NULL
    AND NOT EXISTS (SELECT 1 FROM search_jobs j WHERE j.deal_id = d.id AND j.kind = 'deep' AND j.status IN ('queued','running'))`);
  for (const d of stalledDeep) await maybeFinishDeep(db, s, d.id, notify);
  const stalledVerify = await db.query(`SELECT d.id FROM deals d WHERE d.status = 'live'
    AND EXISTS (SELECT 1 FROM search_jobs j WHERE j.deal_id = d.id AND j.kind = 'verify' AND j.finished_at > d.last_verified)
    AND NOT EXISTS (SELECT 1 FROM search_jobs j WHERE j.deal_id = d.id AND j.kind = 'verify' AND j.status IN ('queued','running'))`);
  for (const d of stalledVerify) await maybeFinishVerify(db, s, d.id);
  return { verifies, expired, stalledDeep: stalledDeep.length, stalledVerify: stalledVerify.length };
}
