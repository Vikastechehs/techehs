// Hotel search workers: pull city searches from hotel_search_jobs (SKIP LOCKED), run them in parallel,
// upsert every hotel seen, store one price per hotel, retry failures, and hand results to the hotel engine.
import { config } from '../config.ts';
import type { Db, Settings } from '../db.ts';
import { FatalSourceError, RetryableError } from '../sources/types.ts';
import type { HotelOffer, HotelSource } from './contract.ts';

export type HotelJob = {
  id: number; kind: 'sweep' | 'deep' | 'verify'; city: string; hotel_deal_id: number | null;
  checkin: string; nights: number; attempts: number; query: string; city_name: string;
};
/** One stored price: the hotel it's for, its quality, and the rate. */
export type HotelPrice = {
  priceId: number; hotelId: number; stars: number | null; rating: number | null;
  perNight: number; total: number; provider: string | null; currency: string;
};
export type AfterHotelSearch = (job: HotelJob, prices: HotelPrice[]) => Promise<void>;

async function claim(db: Db, n: number): Promise<HotelJob[]> {
  return db.query<HotelJob>(`
    WITH picked AS (
      SELECT id FROM hotel_search_jobs
      WHERE status = 'queued' AND run_at <= now()
      ORDER BY CASE kind WHEN 'verify' THEN 0 WHEN 'deep' THEN 1 ELSE 2 END, run_at, id
      LIMIT $1 FOR UPDATE SKIP LOCKED
    )
    UPDATE hotel_search_jobs j SET status = 'running', started_at = now(), attempts = j.attempts + 1
    FROM picked, hotel_cities c
    WHERE j.id = picked.id AND c.code = j.city
    RETURNING j.id, j.kind, j.city, j.hotel_deal_id, j.checkin::text AS checkin, j.nights, j.attempts, c.query, c.name AS city_name`, [n]);
}

/** Upsert the hotels from one search (one statement) and store one price row per hotel (one statement). */
export async function storeHotelResults(db: Db, job: HotelJob, offers: HotelOffer[], source: string, currency: string): Promise<HotelPrice[]> {
  const byId = new Map<string, HotelOffer>();
  for (const o of offers) if (o.perNight > 0 && !byId.has(o.sourceId)) byId.set(o.sourceId, o);
  const list = [...byId.values()];
  if (!list.length) return [];
  const hp: unknown[] = [job.city, source]; const hv: string[] = [];
  for (const o of list) {
    const b = hp.length;
    hp.push(o.sourceId, o.name, o.stars, o.rating, o.reviews, o.area, o.lat, o.lng, o.imageUrl);
    const p = (k: number) => '$' + (b + k);
    hv.push(`($1, $2, ${p(1)}, ${p(2)}, ${p(3)}::int, ${p(4)}::float8, ${p(5)}::int, ${p(6)}, ${p(7)}::float8, ${p(8)}::float8, ${p(9)})`);
  }
  const hotels = await db.query<{ id: number; source_id: string; stars: number | null; rating: number | null }>(`
    INSERT INTO hotels (city, source, source_id, name, stars, rating, reviews, area, lat, lng, image_url)
    VALUES ${hv.join(',')}
    ON CONFLICT (source, source_id) DO UPDATE SET name = EXCLUDED.name,
      stars = coalesce(EXCLUDED.stars, hotels.stars), rating = coalesce(EXCLUDED.rating, hotels.rating),
      reviews = coalesce(EXCLUDED.reviews, hotels.reviews), area = coalesce(EXCLUDED.area, hotels.area),
      lat = coalesce(EXCLUDED.lat, hotels.lat), lng = coalesce(EXCLUDED.lng, hotels.lng),
      image_url = coalesce(EXCLUDED.image_url, hotels.image_url)
    RETURNING id, source_id, stars, rating`, hp);
  const hotelOf = new Map(hotels.map(h => [h.source_id, h]));
  const pp: unknown[] = [job.checkin, job.nights, currency, source, job.kind, job.id]; const pv: string[] = [];
  for (const o of list) {
    const b = pp.length;
    pp.push(hotelOf.get(o.sourceId)!.id, o.perNight, o.total, o.provider);
    const p = (k: number) => '$' + (b + k);
    pv.push(`(${p(1)}::int, $1::date, $2::int, ${p(2)}::float8, ${p(3)}::float8, $3, ${p(4)}, $4, $5, $6::bigint)`);
  }
  const rows = await db.query<{ id: number; hotel_id: number; per_night: number; total: number; provider: string | null }>(`
    INSERT INTO hotel_prices (hotel_id, checkin, nights, per_night, total, currency, provider, source, kind, job_id)
    VALUES ${pv.join(',')} RETURNING id, hotel_id, per_night, total, provider`, pp);
  const quality = new Map(hotels.map(h => [h.id, h]));
  return rows.map(r => ({
    priceId: Number(r.id), hotelId: r.hotel_id, stars: quality.get(r.hotel_id)?.stars ?? null, rating: quality.get(r.hotel_id)?.rating ?? null,
    perNight: r.per_night, total: r.total, provider: r.provider, currency,
  }));
}

export interface HotelRunOptions {
  concurrency: number;
  /** Stop when the queue is empty instead of waiting for more work. */
  drain?: boolean;
  /** Stop after this many jobs. */
  maxJobs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export async function runHotelWorkers(db: Db, source: HotelSource, s: Settings, after: AfterHotelSearch, o: HotelRunOptions) {
  const log = o.log ?? (() => {});
  const maxAttempts = s.num('max_attempts');
  const [market] = await db.query(`SELECT currency, gl FROM markets WHERE code = $1`, [config.market]);
  const currency: string = market?.currency ?? 'INR', gl: string = market?.gl ?? 'in';
  let running = 0, done = 0, failed = 0, fatal: Error | null = null, started = 0;
  const inflight = new Set<Promise<void>>();

  async function handle(job: HotelJob) {
    try {
      const r = await source.search({ city: job.city, query: job.query, checkin: job.checkin, nights: job.nights, currency, gl });
      const prices = await storeHotelResults(db, job, r.offers, r.source, currency);
      await db.query(`UPDATE hotel_search_jobs SET status = 'done', credits = credits + $2, finished_at = now(), error = NULL WHERE id = $1`, [job.id, r.credits]);
      done++;
      // The search itself succeeded; an engine error must not send it back to the queue
      try { await after(job, prices); } catch (e) { log(`hotel engine error after job ${job.id}: ${(e as Error).stack ?? e}`); }
    } catch (e) {
      const err = e as Error;
      if (e instanceof FatalSourceError) {
        fatal = err;
        await db.query(`UPDATE hotel_search_jobs SET status = 'queued', attempts = attempts - 1, error = $2 WHERE id = $1`, [job.id, err.message]);
        return;
      }
      const giveUp = job.attempts >= maxAttempts;
      const delay = e instanceof RetryableError ? e.retryAfterMs * job.attempts : 30_000 * job.attempts;
      await db.query(`UPDATE hotel_search_jobs SET status = $2, error = $3, run_at = now() + make_interval(secs => $4),
                      finished_at = CASE WHEN $2 = 'failed' THEN now() END WHERE id = $1`,
        [job.id, giveUp ? 'failed' : 'queued', err.message.slice(0, 300), delay / 1000]);
      if (giveUp) { failed++; log(`hotel job ${job.id} failed: ${err.message.slice(0, 120)}`); }
    }
  }

  while (!o.signal?.aborted && !fatal) {
    const free = o.concurrency - running;
    const budgetLeft = o.maxJobs != null ? o.maxJobs - started : Infinity;
    const jobs = free > 0 && budgetLeft > 0 ? await claim(db, Math.min(free, budgetLeft)) : [];
    for (const job of jobs) {
      running++; started++;
      const p = handle(job).finally(() => { running--; inflight.delete(p); });
      inflight.add(p);
    }
    if (jobs.length === 0) {
      if (running === 0 && (o.drain || budgetLeft <= 0)) {
        // Nothing running; in drain mode stop once no queued job is due soon
        const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM hotel_search_jobs WHERE status = 'queued' AND run_at <= now() + interval '2 seconds'`);
        if (n === 0 || budgetLeft <= 0) break;
      }
      if (inflight.size) await Promise.race(inflight); else await new Promise(r => setTimeout(r, 500));
    }
  }
  await Promise.all(inflight);
  if (fatal) log(`hotel workers stopped: ${(fatal as Error).message}`);
  return { done, failed, fatal: fatal ? (fatal as Error).message : null };
}
