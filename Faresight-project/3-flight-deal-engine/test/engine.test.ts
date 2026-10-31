// End-to-end tests on an in-memory database with simulated fares. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, getSettings, type Db } from '../src/db.ts';
import { seed, indiaRoutes } from '../src/routes.ts';
import { scheduleSweeps } from '../src/scheduler.ts';
import { runWorkers } from '../src/worker.ts';
import { mockSource } from '../src/sources/mock.ts';
import { parseGoogleFlights, scrapeDoSource } from '../src/sources/scrapedo.ts';
import { FatalSourceError, RetryableError } from '../src/sources/types.ts';
import { makeAfterSearch, engineTick, passes } from '../src/engine/deals.ts';
import { startServer } from '../src/web/server.ts';

async function freshDb(): Promise<Db> {
  const db = await openDb({ memory: true });
  await migrate(db);
  await seed(db);
  return db;
}

test('route list has 300 routes over 12 origins and 40 destinations', async () => {
  const r = indiaRoutes();
  assert.equal(r.length, 300);
  assert.equal(new Set(r.map(x => x.origin)).size, 12);
  assert.equal(new Set(r.map(x => x.destination)).size, 40);
  assert.equal(new Set(r.map(x => `${x.origin}-${x.destination}`)).size, 300);
});

test('Scrape.do response parsing respects the stop limit', () => {
  const data = { best_flights: [
    { price: 30000, layovers: [], flights: [{ airline: 'IndiGo' }] },
    { price: 25000, layovers: [{}, {}], flights: [{ airline: 'A' }, { airline: 'B' }, { airline: 'C' }] },
  ], other_flights: [{ price: 28000, layovers: [{}], flights: [{ airline: 'Air India' }, { airline: 'Air India' }] }] };
  const r = parseGoogleFlights(data, 1);
  assert.equal(r.cheapestAny, 25000);
  assert.equal(r.price, 28000);
  assert.equal(r.airlines, 'Air India');
  assert.equal(parseGoogleFlights(data, 0).price, 30000);
  assert.equal(parseGoogleFlights({}, 1).price, null);
});

test('Scrape.do errors: 429 is retried later, 402 stops the workers', async () => {
  const fake = (status: number) => (async () => new Response('x', { status })) as unknown as typeof fetch;
  const q = { origin: 'DEL', destination: 'BKK', depart: '2027-01-10', returnDate: '2027-01-17', maxStops: 1, currency: 'INR', gl: 'in' };
  await assert.rejects(scrapeDoSource('t', fake(429)).search(q), RetryableError);
  await assert.rejects(scrapeDoSource('t', fake(402)).search(q), FatalSourceError);
});

test('deal rule: 25% below normal and a minimum saving', async () => {
  const db = await freshDb(); const s = await getSettings(db);
  assert.equal(passes(s, 'short', 7400, 10000), false, 'saving 2,600 is under the 3,000 minimum');
  assert.equal(passes(s, 'short', 15000, 20000), true);
  assert.equal(passes(s, 'short', 16000, 20000), false, 'only 20% below');
  assert.equal(passes(s, 'long', 52000, 60000), false, 'long haul needs 8,000 saving');
  await db.close();
});

test('scheduler does not queue duplicates and respects the daily cap', async () => {
  const db = await freshDb();
  await db.query(`UPDATE settings SET value = '500' WHERE key = 'daily_search_cap'`);
  const s = await getSettings(db);
  assert.equal((await scheduleSweeps(db, s)).enqueued, 500);
  assert.equal((await scheduleSweeps(db, s)).enqueued, 0);
  await db.close();
});

test('engine finds sale fares, confirms them with a deep check, and expires them when prices rise', async () => {
  const db = await freshDb();
  await db.query(`UPDATE settings SET value = 'true' WHERE key = 'auto_approve'`);
  await db.query(`UPDATE settings SET value = '100000' WHERE key = 'daily_search_cap'`);
  const getS = () => getSettings(db); const s = await getS();
  const published: number[] = [];
  const after = makeAfterSearch(db, getS, async id => { published.push(id); });
  await scheduleSweeps(db, s);
  const r = await runWorkers(db, mockSource(), s, after, { concurrency: 50, drain: true });
  assert.equal(r.failed, 0);
  const live = await db.query(`SELECT d.*, (SELECT count(*)::int FROM deal_dates WHERE deal_id = d.id) AS pairs FROM deals d WHERE status = 'live'`);
  assert.ok(live.length >= 10, `expected at least 10 live deals, got ${live.length}`);
  assert.equal(published.length, live.length);
  for (const d of live) {
    assert.ok(d.saving_pct >= 25, `deal ${d.id} saving ${d.saving_pct}`);
    assert.ok(d.pairs >= 3);
  }
  // No route has two open deals in neighbouring months
  const dup = await db.query(`SELECT a.id FROM deals a JOIN deals b ON a.route_id = b.route_id AND a.id < b.id
    WHERE a.status = 'live' AND b.status = 'live' AND abs(a.month - b.month) <= 31`);
  assert.equal(dup.length, 0);

  // 7 hours later, prices on every route are 30% higher: all deals must expire at the re-check
  await db.query(`UPDATE deals SET last_verified = now() - interval '7 hours' WHERE status = 'live'`);
  const t = await engineTick(db, s, async () => {});
  assert.ok(t.verifies > 0);
  await runWorkers(db, mockSource({ priceFactor: () => 1.3 }), s, after, { concurrency: 50, drain: true });
  const [c] = await db.query(`SELECT count(*) FILTER (WHERE status = 'live')::int AS live, count(*) FILTER (WHERE status = 'expired')::int AS expired FROM deals`);
  assert.equal(c.live, 0);
  assert.equal(c.expired, live.length);
  await db.close();
});

test('website: deal list, deal page, booking redirect with click logging, admin login', async () => {
  const db = await freshDb();
  await db.query(`UPDATE settings SET value = 'true' WHERE key = 'auto_approve'`);
  await db.query(`UPDATE settings SET value = '100000' WHERE key = 'daily_search_cap'`);
  const getS = () => getSettings(db); const s = await getS();
  await scheduleSweeps(db, s);
  await runWorkers(db, mockSource(), s, makeAfterSearch(db, getS, async () => {}), { concurrency: 50, drain: true });
  const server = await startServer(db, async () => {}, 0);
  const port = (server.address() as any).port; const base = `http://127.0.0.1:${port}`;
  try {
    const home = await fetch(base + '/'); assert.equal(home.status, 200);
    const deals = await (await fetch(base + '/api/deals')).json() as any[];
    assert.ok(deals.length > 0);
    const page = await (await fetch(`${base}/deal/${deals[0].id}`)).text();
    const go = page.match(/\/go\/(\d+)/); assert.ok(go, 'deal page has booking links');
    const redirect = await fetch(base + go[0], { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get('location') ?? '', /^https:\/\/www\.skyscanner\.co\.in\/transport\/flights\//);
    const [clk] = await db.query(`SELECT count(*)::int AS n FROM clicks`); assert.equal(clk.n, 1);
    assert.equal((await fetch(base + '/admin')).status, 401);
    assert.equal((await fetch(base + '/deal/999999')).status, 404);
  } finally { server.close(); await db.close(); }
});
