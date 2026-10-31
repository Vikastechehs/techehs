// Search workers: pull jobs from the queue (PostgreSQL, SKIP LOCKED), run them in parallel,
// store every price seen, retry failures with back-off, and hand results to the deal engine.
import type { Db, Settings } from './db.ts';
import { FatalSourceError, RetryableError, type FareSource } from './sources/types.ts';

export type Job = {
  id: number; kind: 'sweep' | 'deep' | 'verify'; route_id: number; deal_id: number | null;
  depart: string; return_date: string; attempts: number;
  origin: string; destination: string; max_stops: number; currency: string; gl: string; haul: string;
};
export type Observation = { id: number; price: number | null; nights: number; currency: string };
export type AfterSearch = (job: Job, obs: Observation) => Promise<void>;

async function claim(db: Db, n: number): Promise<Job[]> {
  return db.query<Job>(`
    WITH picked AS (
      SELECT id FROM search_jobs
      WHERE status = 'queued' AND run_at <= now()
      ORDER BY CASE kind WHEN 'verify' THEN 0 WHEN 'deep' THEN 1 ELSE 2 END, run_at, id
      LIMIT $1 FOR UPDATE SKIP LOCKED
    )
    UPDATE search_jobs j SET status = 'running', started_at = now(), attempts = j.attempts + 1
    FROM picked, routes r, markets m
    WHERE j.id = picked.id AND r.id = j.route_id AND m.code = r.market
    RETURNING j.id, j.kind, j.route_id, j.deal_id, j.depart::text AS depart, j.return_date::text AS return_date,
              j.attempts, r.origin, r.destination, r.max_stops, r.haul, m.currency, m.gl`, [n]);
}

export interface RunOptions {
  concurrency: number;
  /** Stop when the queue is empty instead of waiting for more work. */
  drain?: boolean;
  /** Stop after this many jobs (handy for a first real test). */
  maxJobs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export async function runWorkers(db: Db, source: FareSource, s: Settings, after: AfterSearch, o: RunOptions) {
  const log = o.log ?? (() => {});
  const maxAttempts = s.num('max_attempts');
  let running = 0, done = 0, failed = 0, fatal: Error | null = null, started = 0;
  const inflight = new Set<Promise<void>>();

  async function handle(job: Job) {
    try {
      const r = await source.search({
        origin: job.origin, destination: job.destination, depart: job.depart, returnDate: job.return_date,
        maxStops: job.max_stops, currency: job.currency, gl: job.gl,
      });
      const nights = Math.round((Date.parse(job.return_date) - Date.parse(job.depart)) / 864e5);
      const [obs] = await db.query<Observation>(`
        INSERT INTO price_observations (route_id, depart, return_date, nights, price, cheapest_any, currency, stops, airlines, source, kind, job_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, price, nights, currency`,
        [job.route_id, job.depart, job.return_date, nights, r.price, r.cheapestAny, job.currency, r.stops, r.airlines, r.source, job.kind, job.id]);
      await db.query(`UPDATE search_jobs SET status = 'done', credits = credits + $2, finished_at = now(), error = NULL WHERE id = $1`, [job.id, r.credits]);
      done++;
      // The search itself succeeded; an engine error must not send it back to the queue
      try { await after(job, obs); } catch (e) { log(`engine error after job ${job.id}: ${(e as Error).stack ?? e}`); }
    } catch (e) {
      const err = e as Error;
      if (e instanceof FatalSourceError) {
        fatal = err;
        await db.query(`UPDATE search_jobs SET status = 'queued', attempts = attempts - 1, error = $2 WHERE id = $1`, [job.id, err.message]);
        return;
      }
      const giveUp = job.attempts >= maxAttempts;
      const delay = e instanceof RetryableError ? e.retryAfterMs * job.attempts : 30_000 * job.attempts;
      await db.query(`UPDATE search_jobs SET status = $2, error = $3, run_at = now() + make_interval(secs => $4),
                      finished_at = CASE WHEN $2 = 'failed' THEN now() END WHERE id = $1`,
        [job.id, giveUp ? 'failed' : 'queued', err.message.slice(0, 300), delay / 1000]);
      if (giveUp) { failed++; log(`job ${job.id} failed: ${err.message.slice(0, 120)}`); }
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
        const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM search_jobs WHERE status = 'queued' AND run_at <= now() + interval '2 seconds'`);
        if (n === 0 || budgetLeft <= 0) break;
      }
      if (inflight.size) await Promise.race(inflight); else await new Promise(r => setTimeout(r, 500));
    }
  }
  await Promise.all(inflight);
  if (fatal) log(`stopped: ${(fatal as Error).message}`);
  return { done, failed, fatal: fatal ? (fatal as Error).message : null };
}
