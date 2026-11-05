// Hotel deal lifecycle: candidate -> deep check -> review/live -> re-checked every few hours -> expired.
// Mirrors src/engine/deals.ts, per hotel instead of per route.
import type { Db, Settings } from '../db.ts';
import type { HotelNotify } from './contract.ts';
import type { HotelJob, HotelPrice } from './worker.ts';
import { hotelNormal, hotelNormals } from './norms.ts';

// Called after a live hotel deal ends. Set once at startup; errors are logged, not thrown.
let endedHook: HotelNotify | null = null;
export function setHotelDealEndedHook(fn: HotelNotify | null) { endedHook = fn; }
async function dealEnded(id: number) {
  if (!endedHook) return;
  try { await endedHook(id); } catch (e) { console.error(`hotel deal ended hook (deal ${id}): ${(e as Error).message}`); }
}

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const savingPct = (perNight: number, normal: number) => Math.round((1 - perNight / normal) * 1000) / 10;
/** Earliest check-in the engine searches or keeps (same lead time as the sweep calendar). */
const FIRST_CHECKIN_SQL = `current_date + 2`;

/**
 * Does a per-night price pass the deal test against the hotel's normal price? With `hotel`, also
 * checks the quality bar (guest rating and star class; unknown values fail).
 */
export function hotelPasses(s: Settings, perNight: number, normal: number, hotel?: { stars: number | null; rating: number | null }) {
  if (hotel) {
    if (hotel.rating == null || hotel.rating < s.num('hotel_min_rating')) return false;
    if (hotel.stars == null || hotel.stars < s.num('hotel_min_stars')) return false;
  }
  return perNight <= normal * s.num('hotel_deal_max_ratio') && normal - perNight >= s.num('hotel_min_saving_night');
}

/** Called after every finished hotel search. */
export function makeAfterHotelSearch(db: Db, getSettings: () => Promise<Settings>, onLive: HotelNotify) {
  return async (job: HotelJob, prices: HotelPrice[]) => {
    const s = await getSettings();
    if (job.kind === 'sweep') await onHotelSweep(db, s, job, prices, onLive);
    else if (job.kind === 'deep' && job.hotel_deal_id) await maybeFinishHotelDeep(db, s, job.hotel_deal_id, onLive);
    else if (job.kind === 'verify' && job.hotel_deal_id) await maybeFinishHotelVerify(db, s, job.hotel_deal_id);
  };
}

const OPEN_NEARBY_SQL = `SELECT id, status, per_night FROM hotel_deals WHERE hotel_id = $1 AND status IN ('candidate','review','live')
  AND month BETWEEN $2::date - interval '1 month' AND $2::date + interval '1 month' ORDER BY abs(month - $2::date), id LIMIT 1`;

/** A sweep price far below a hotel's normal opens a candidate deal and queues the deep check around it. */
export async function onHotelSweep(db: Db, s: Settings, job: HotelJob, prices: HotelPrice[], onLive: HotelNotify) {
  const good = prices.filter(p => p.rating != null && p.rating >= s.num('hotel_min_rating') && p.stars != null && p.stars >= s.num('hotel_min_stars'));
  if (!good.length) return;
  const info = await hotelNormals(db, s, good.map(p => p.hotelId), job.checkin);
  for (const p of good) {
    const h = info.get(p.hotelId);
    if (!h?.norm || h.history < s.num('hotel_min_history')) continue;
    if (!hotelPasses(s, p.perNight, h.norm.perNight)) continue;
    await openCandidate(db, s, job, p, h.norm.perNight, onLive);
  }
}

async function openCandidate(db: Db, s: Settings, job: HotelJob, p: HotelPrice, normal: number, onLive: HotelNotify) {
  const month = job.checkin.slice(0, 7) + '-01';
  const saving = savingPct(p.perNight, normal);
  // A sale that spans a month boundary is one deal: reuse an open deal on this hotel in this or a neighbouring month
  const [nearby] = await db.query(OPEN_NEARBY_SQL, [p.hotelId, month]);
  const created = nearby ? [] : await db.query<{ id: number }>(`
    INSERT INTO hotel_deals (hotel_id, month, per_night, normal_per_night, saving_pct, currency, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'candidate') ON CONFLICT DO NOTHING RETURNING id`,
    [p.hotelId, month, p.perNight, normal, saving, p.currency]);
  if (!created.length) {
    // Already open. If it's live, add this stay (and lower the shown price).
    const [open] = await db.query(OPEN_NEARBY_SQL, [p.hotelId, month]);
    if (open?.status === 'live') {
      await addDealDate(db, open.id, { checkin: job.checkin, nights: job.nights, per_night: p.perNight, total: p.total, provider: p.provider }, normal);
      if (p.perNight < open.per_night)
        await db.query(`UPDATE hotel_deals SET per_night = $2, normal_per_night = $3, saving_pct = $4 WHERE id = $1`, [open.id, p.perNight, normal, saving]);
    }
    return;
  }
  const dealId = created[0].id;
  // Two searches can open deals in neighbouring months at once; the older one wins
  const [older] = await db.query(`SELECT id FROM hotel_deals WHERE hotel_id = $1 AND id < $2 AND status IN ('candidate','review','live')
    AND month BETWEEN $3::date - interval '1 month' AND $3::date + interval '1 month' LIMIT 1`, [p.hotelId, dealId, month]);
  if (older) { await db.query(`DELETE FROM hotel_deals WHERE id = $1`, [dealId]); return; }

  // Deep check: every check-in within N days either side, at each of the city's stay lengths
  const [city] = await db.query(`SELECT stay_nights, (${FIRST_CHECKIN_SQL})::text AS first FROM hotel_cities WHERE code = $1`, [job.city]);
  const n = s.num('hotel_deep_days_each_side');
  const values: string[] = []; const params: unknown[] = [job.city, dealId];
  for (let k = -n; k <= n; k++) {
    const checkin = addDays(job.checkin, k);
    if (checkin < city.first) continue;
    for (const nights of city.stay_nights as number[]) {
      params.push(checkin, nights);
      values.push(`('deep', $1, $2::int, $${params.length - 1}::date, $${params.length}::int)`);
    }
  }
  if (values.length) await db.query(`INSERT INTO hotel_search_jobs (kind, city, hotel_deal_id, checkin, nights) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
  else await maybeFinishHotelDeep(db, s, dealId, onLive);
}

type DateRow = { checkin: string; nights: number; per_night: number; total: number; provider: string | null };
async function addDealDate(db: Db, dealId: number, d: DateRow, normal: number) {
  await db.query(`
    INSERT INTO hotel_deal_dates (hotel_deal_id, checkin, nights, per_night, total, normal_per_night, provider)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (hotel_deal_id, checkin, nights) DO UPDATE SET per_night = EXCLUDED.per_night, total = EXCLUDED.total,
      normal_per_night = EXCLUDED.normal_per_night, provider = EXCLUDED.provider, last_checked = now()`,
    [dealId, d.checkin, d.nights, d.per_night, d.total, normal, d.provider]);
}

const openJobs = async (db: Db, dealId: number, kind: string) =>
  (await db.query(`SELECT count(*)::int AS n FROM hotel_search_jobs WHERE hotel_deal_id = $1 AND kind = $2 AND status IN ('queued','running')`, [dealId, kind]))[0].n as number;

/** When all deep-check searches for a candidate are done, confirm or reject it. */
export async function maybeFinishHotelDeep(db: Db, s: Settings, dealId: number, onLive: HotelNotify) {
  if ((await openJobs(db, dealId, 'deep')) > 0) return;
  // Claim the evaluation so two workers finishing at once don't both do it
  const claimed = await db.query(`UPDATE hotel_deals SET reason = 'evaluating' WHERE id = $1 AND status = 'candidate' AND reason IS NULL RETURNING hotel_id`, [dealId]);
  if (!claimed.length) return;
  const hotelId = claimed[0].hotel_id;
  const [hotel] = await db.query<{ stars: number | null; rating: number | null }>(`SELECT stars, rating FROM hotels WHERE id = $1`, [hotelId]);
  const rows = await db.query<DateRow>(`
    SELECT DISTINCT ON (p.checkin, p.nights) p.checkin::text AS checkin, p.nights, p.per_night, p.total, p.provider
    FROM hotel_prices p
    WHERE p.hotel_id = $2 AND p.job_id IN (SELECT id FROM hotel_search_jobs WHERE hotel_deal_id = $1 AND kind = 'deep')
    ORDER BY p.checkin, p.nights, p.observed_at DESC`, [dealId, hotelId]);
  const passing: (DateRow & { normal: number })[] = [];
  const normCache = new Map<string, number | null>();
  for (const r of rows) {
    if (!normCache.has(r.checkin)) normCache.set(r.checkin, (await hotelNormal(db, s, hotelId, r.checkin))?.perNight ?? null);
    const normal = normCache.get(r.checkin);
    if (normal != null && hotelPasses(s, r.per_night, normal, hotel)) passing.push({ ...r, normal });
  }
  if (passing.length < s.num('hotel_min_passing_dates')) {
    await db.query(`UPDATE hotel_deals SET status = 'rejected', reason = $2, expired_at = now() WHERE id = $1`,
      [dealId, `only ${passing.length} of ${rows.length} stays passed the deep check`]);
    return;
  }
  for (const p of passing) await addDealDate(db, dealId, p, p.normal);
  const best = passing.reduce((a, b) => (b.per_night < a.per_night ? b : a));
  const live = s.bool('auto_approve');
  await db.query(`
    UPDATE hotel_deals SET per_night = $2, normal_per_night = $3, saving_pct = $4, status = $5, reason = NULL,
           published_at = CASE WHEN $5 = 'live' THEN now() END, last_verified = now()
    WHERE id = $1`, [dealId, best.per_night, best.normal, savingPct(best.per_night, best.normal), live ? 'live' : 'review']);
  if (live) await onLive(dealId);
}

/** Admin decision on a hotel deal in 'review'. Approve -> live (+ notify), reject -> rejected. */
export async function reviewHotelDeal(db: Db, hotelDealId: number, approve: boolean, notify: HotelNotify): Promise<void> {
  const rows = await db.query(`
    UPDATE hotel_deals SET status = $2, published_at = CASE WHEN $2 = 'live' THEN now() END,
           last_verified = CASE WHEN $2 = 'live' THEN now() ELSE last_verified END,
           reason = CASE WHEN $2 = 'rejected' THEN 'rejected by admin' END,
           expired_at = CASE WHEN $2 = 'rejected' THEN now() END
    WHERE id = $1 AND status = 'review' RETURNING id`, [hotelDealId, approve ? 'live' : 'rejected']);
  if (rows.length && approve) await notify(hotelDealId);
}

/** Queue re-checks for live deals not verified in the last N hours: their cheapest future stays. */
export async function scheduleHotelVerifies(db: Db, s: Settings) {
  const rows = await db.query(`
    INSERT INTO hotel_search_jobs (kind, city, hotel_deal_id, checkin, nights)
    SELECT 'verify', h.city, d.id, dd.checkin, dd.nights
    FROM hotel_deals d JOIN hotels h ON h.id = d.hotel_id
    CROSS JOIN LATERAL (
      SELECT checkin, nights FROM hotel_deal_dates
      WHERE hotel_deal_id = d.id AND checkin >= ${FIRST_CHECKIN_SQL}
      ORDER BY per_night, checkin LIMIT $2
    ) dd
    WHERE d.status = 'live'
      AND coalesce(d.last_verified, d.published_at, d.first_seen) < now() - make_interval(hours => $1)
      AND NOT EXISTS (SELECT 1 FROM hotel_search_jobs j WHERE j.hotel_deal_id = d.id AND j.kind = 'verify' AND j.status IN ('queued','running'))
    ON CONFLICT DO NOTHING RETURNING id`, [s.num('hotel_verify_every_hours'), s.num('verify_pairs') || 3]);
  return rows.length;
}

/** When a deal's re-check round is done: keep it (maybe cheaper) or expire it. */
export async function maybeFinishHotelVerify(db: Db, s: Settings, dealId: number) {
  if ((await openJobs(db, dealId, 'verify')) > 0) return;
  const [deal] = await db.query(`SELECT id, hotel_id, per_night, normal_per_night, coalesce(last_verified, published_at, first_seen) AS since, status
    FROM hotel_deals WHERE id = $1`, [dealId]);
  if (!deal || deal.status !== 'live') return;
  // Results of this round: verify searches finished since the last verification (null = hotel not in the results)
  const res = await db.query(`
    SELECT j.checkin::text AS checkin, j.nights, p.per_night, p.total, p.provider
    FROM hotel_search_jobs j LEFT JOIN hotel_prices p ON p.job_id = j.id AND p.hotel_id = $3
    WHERE j.hotel_deal_id = $1 AND j.kind = 'verify' AND j.status = 'done' AND j.finished_at > $2`, [dealId, deal.since, deal.hotel_id]);
  if (!res.length) return;
  for (const r of res) {
    if (r.per_night != null) await db.query(`UPDATE hotel_deal_dates SET per_night = $4, total = $5, provider = coalesce($6, provider), last_checked = now()
      WHERE hotel_deal_id = $1 AND checkin = $2 AND nights = $3`, [dealId, r.checkin, r.nights, r.per_night, r.total, r.provider]);
  }
  const prices = res.map(r => r.per_night).filter((p): p is number => p != null);
  const best = prices.length ? Math.min(...prices) : null;
  if (best != null && best <= deal.per_night * s.num('hotel_verify_tolerance')) {
    const perNight = Math.min(best, deal.per_night);
    await db.query(`UPDATE hotel_deals SET per_night = $2, saving_pct = $3, last_verified = now() WHERE id = $1`,
      [dealId, perNight, savingPct(perNight, deal.normal_per_night)]);
  } else {
    const ended = await db.query(`UPDATE hotel_deals SET status = 'expired', expired_at = now(), reason = $2 WHERE id = $1 AND status = 'live' RETURNING id`,
      [dealId, best == null ? 'no rate found at re-check' : `price rose to ${inr(best)} (shown ${inr(deal.per_night)})`]);
    if (ended.length) await dealEnded(dealId);
  }
}

/** Live or review deals whose stays have all passed are expired. */
export async function expirePastHotelDeals(db: Db) {
  const rows = await db.query(`
    UPDATE hotel_deals d SET status = 'expired', expired_at = now(), reason = 'all dates passed'
    WHERE status IN ('live','review')
      AND NOT EXISTS (SELECT 1 FROM hotel_deal_dates dd WHERE dd.hotel_deal_id = d.id AND dd.checkin >= current_date + 1)
    RETURNING id`);
  for (const r of rows) await dealEnded(r.id);
  return rows.length;
}

/**
 * Housekeeping, run every minute: queue re-checks, expire past deals, and finish any deep check or
 * re-check round whose last search failed (a failed search doesn't trigger the normal follow-up).
 */
export async function hotelEngineTick(db: Db, s: Settings, onLive: HotelNotify) {
  const verifies = await scheduleHotelVerifies(db, s);
  const expired = await expirePastHotelDeals(db);
  // first_seen guard: a brand-new candidate gets a moment to queue its deep-check searches
  const stalledDeep = await db.query(`SELECT d.id FROM hotel_deals d WHERE d.status = 'candidate' AND d.reason IS NULL
    AND d.first_seen < now() - interval '1 minute'
    AND NOT EXISTS (SELECT 1 FROM hotel_search_jobs j WHERE j.hotel_deal_id = d.id AND j.kind = 'deep' AND j.status IN ('queued','running'))`);
  for (const d of stalledDeep) await maybeFinishHotelDeep(db, s, d.id, onLive);
  const stalledVerify = await db.query(`SELECT d.id FROM hotel_deals d WHERE d.status = 'live'
    AND EXISTS (SELECT 1 FROM hotel_search_jobs j WHERE j.hotel_deal_id = d.id AND j.kind = 'verify'
                AND j.finished_at > coalesce(d.last_verified, d.published_at, d.first_seen))
    AND NOT EXISTS (SELECT 1 FROM hotel_search_jobs j WHERE j.hotel_deal_id = d.id AND j.kind = 'verify' AND j.status IN ('queued','running'))`);
  for (const d of stalledVerify) await maybeFinishHotelVerify(db, s, d.id);
  return { verifies, expired, stalledDeep: stalledDeep.length, stalledVerify: stalledVerify.length };
}
