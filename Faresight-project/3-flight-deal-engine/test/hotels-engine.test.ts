// Hotel engine tests on an in-memory database with simulated hotels. Run: node --test test/hotels-engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, getSettings, type Db } from '../src/db.ts';
import { seed } from '../src/routes.ts';
import { hotelCities, seedHotelCities } from '../src/hotels/cities.ts';
import { scheduleHotelSweeps } from '../src/hotels/scheduler.ts';
import { runHotelWorkers } from '../src/hotels/worker.ts';
import { mockHotelSource } from '../src/hotels/sources/mock.ts';
import { parseGoogleHotels, scrapeDoHotelSource } from '../src/hotels/sources/scrapedo.ts';
import { makeAfterHotelSearch, hotelEngineTick, setHotelDealEndedHook, reviewHotelDeal, hotelPasses } from '../src/hotels/deals.ts';
import { rebuildHotelNorms } from '../src/hotels/norms.ts';
import { hotelBookingUrl, hotelPartnerName } from '../src/hotels/links.ts';
import { creditsThisMonth } from '../src/scheduler.ts';
import { FatalSourceError, RetryableError } from '../src/sources/types.ts';

async function freshDb(): Promise<Db> {
  const db = await openDb({ memory: true });
  await migrate(db);
  await seed(db);
  await seedHotelCities(db);
  return db;
}

test('hotel cities: 39 international (no Indian origins, no DMK) plus 7 Indian, idempotent', async () => {
  const c = hotelCities();
  assert.equal(c.filter(x => x.region !== 'india').length, 39);
  assert.equal(c.filter(x => x.region === 'india').length, 7);
  assert.ok(!c.some(x => x.code === 'DMK'));
  assert.ok(c.every(x => x.region !== 'other'));
  assert.equal(c.find(x => x.code === 'BKK')!.query, 'Bangkok, Thailand');
  assert.deepEqual(c.find(x => x.code === 'LHR')!.stayNights, [5, 4, 7]);
  const db = await freshDb();
  assert.equal(await seedHotelCities(db), 0, 'second seed adds nothing');
  const [n] = await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE region = 'india')::int AS india FROM hotel_cities`);
  assert.equal(n.n, 46); assert.equal(n.india, 7);
  await db.close();
});

test('Google Hotels parser: SerpApi-style properties to offers', () => {
  const fixture = { properties: [
    { type: 'hotel', name: 'Riverside Grand', property_token: 'tok1', hotel_class: '4-star hotel', extracted_hotel_class: 4,
      overall_rating: 4.4, reviews: 1532, gps_coordinates: { latitude: 13.72, longitude: 100.51 },
      rate_per_night: { lowest: '₹5,100', extracted_lowest: 5100 }, total_rate: { lowest: '₹15,600', extracted_lowest: 15600 },
      images: [{ thumbnail: 'https://img/1.jpg' }], neighborhood: 'Riverside',
      prices: [{ source: 'Agoda', rate_per_night: { extracted_lowest: 5300 } }, { source: 'Booking.com', rate_per_night: { extracted_lowest: 5100 } }] },
    { name: 'No Class Inn', property_token: 'tok2', hotel_class: '3-star hotel', overall_rating: 3.9, rate_per_night: { extracted_lowest: 2000 } },
    { type: 'vacation rental', name: 'Flat', property_token: 'tok3', rate_per_night: { extracted_lowest: 1500 } },
    { type: 'hotel', name: 'Sold Out', property_token: 'tok4' },
    { type: 'hotel', name: 'Riverside Grand dup', property_token: 'tok1', rate_per_night: { extracted_lowest: 1 } },
  ] };
  const r = parseGoogleHotels(fixture, 3);
  assert.equal(r.offers.length, 2);
  const [a, b] = r.offers;
  assert.equal(a.sourceId, 'tok1'); assert.equal(a.stars, 4); assert.equal(a.rating, 8.8); assert.equal(a.reviews, 1532);
  assert.equal(a.perNight, 5200, 'total / nights (taxes included)'); assert.equal(a.total, 15600);
  assert.equal(a.lat, 13.72); assert.equal(a.imageUrl, 'https://img/1.jpg'); assert.equal(a.area, 'Riverside'); assert.equal(a.provider, 'Booking.com');
  assert.equal(b.stars, 3, 'class parsed from text'); assert.equal(b.rating, 7.8); assert.equal(b.perNight, 2000); assert.equal(b.total, 6000);
  assert.equal(parseGoogleHotels({}, 2).offers.length, 0);
});

test('Scrape.do hotels: request parameters, 429 retried, 402 stops', async () => {
  let url = '';
  const ok = (async (u: string) => { url = u; return new Response('{"properties":[]}', { status: 200 }); }) as unknown as typeof fetch;
  const q = { city: 'BKK', query: 'Bangkok, Thailand', checkin: '2027-01-10', nights: 3, currency: 'INR', gl: 'in' };
  await scrapeDoHotelSource('t', ok).search(q);
  const p = new URL(url);
  assert.equal(p.origin + p.pathname, 'https://api.scrape.do/plugin/google/hotels');
  assert.equal(p.searchParams.get('q'), 'Bangkok, Thailand');
  assert.equal(p.searchParams.get('check_out_date'), '2027-01-13');
  assert.equal(p.searchParams.get('adults'), '2');
  const fake = (status: number) => (async () => new Response('x', { status })) as unknown as typeof fetch;
  await assert.rejects(scrapeDoHotelSource('t', fake(429)).search(q), RetryableError);
  await assert.rejects(scrapeDoHotelSource('t', fake(402)).search(q), FatalSourceError);
});

test('hotel deal rule and booking link', async () => {
  const db = await freshDb(); const s = await getSettings(db);
  assert.equal(hotelPasses(s, 7000, 10000), true);
  assert.equal(hotelPasses(s, 8000, 10000), false, 'only 20% below');
  assert.equal(hotelPasses(s, 2500, 3200), false, 'saving 700/night is under 1,000');
  assert.equal(hotelPasses(s, 7000, 10000, { stars: 4, rating: 7.0 }), false, 'rating too low');
  assert.equal(hotelPasses(s, 7000, 10000, { stars: 2, rating: 9.0 }), false, 'too few stars');
  assert.equal(hotelPasses(s, 7000, 10000, { stars: 3, rating: 8.0 }), true);
  const u = new URL(hotelBookingUrl('Riverside Grand', 'Bangkok', '2027-01-30', 3));
  assert.equal(u.origin + u.pathname, 'https://www.booking.com/searchresults.html');
  assert.equal(u.searchParams.get('ss'), 'Riverside Grand, Bangkok');
  assert.equal(u.searchParams.get('checkout'), '2027-02-02');
  assert.equal(u.searchParams.get('selected_currency'), 'INR');
  assert.ok(hotelPartnerName().startsWith('booking'));
  await db.close();
});

test('hotel scheduler does not queue duplicates and respects the daily cap and credit budget', async () => {
  const db = await freshDb();
  await db.query(`UPDATE settings SET value = '300' WHERE key = 'hotel_daily_search_cap'`);
  let s = await getSettings(db);
  assert.equal((await scheduleHotelSweeps(db, s)).enqueued, 300);
  assert.equal((await scheduleHotelSweeps(db, s)).enqueued, 0);
  await db.query(`UPDATE settings SET value = '100000' WHERE key = 'hotel_daily_search_cap'`);
  s = await getSettings(db);
  const more = await scheduleHotelSweeps(db, s, { limit: 100000 });
  const [d] = await db.query(`SELECT count(*)::int AS n, count(DISTINCT (city, checkin, nights))::int AS u FROM hotel_search_jobs`);
  assert.equal(d.n, d.u, 'no duplicate open jobs');
  assert.ok(more.enqueued > 500, `whole calendar queued (${more.enqueued} more)`);
  // Hotel credits count toward the shared monthly budget; when it's spent nothing more is queued
  await db.query(`UPDATE hotel_search_jobs SET status = 'done', credits = 10, finished_at = now() WHERE id IN (SELECT id FROM hotel_search_jobs LIMIT 5)`);
  assert.equal(await creditsThisMonth(db), 50);
  await db.query(`UPDATE settings SET value = '50' WHERE key = 'monthly_credit_budget'`);
  s = await getSettings(db);
  assert.equal((await scheduleHotelSweeps(db, s)).reason, 'monthly credit budget used up');
  await db.close();
});

test('hotel engine finds sales, confirms them with a deep check, and expires them when prices rise', async () => {
  const db = await freshDb();
  await db.query(`UPDATE settings SET value = 'true' WHERE key = 'auto_approve'`);
  await db.query(`UPDATE settings SET value = '100000' WHERE key = 'hotel_daily_search_cap'`);
  await db.query(`UPDATE settings SET value = '0' WHERE key = 'credits_per_search'`);
  const getS = () => getSettings(db); const s = await getS();
  const published: number[] = []; const ended: number[] = [];
  setHotelDealEndedHook(async id => { ended.push(id); });
  const after = makeAfterHotelSearch(db, getS, async id => { published.push(id); });
  await scheduleHotelSweeps(db, s);
  const r = await runHotelWorkers(db, mockHotelSource(), s, after, { concurrency: 40, drain: true });
  assert.equal(r.failed, 0);
  const [hc] = await db.query(`SELECT count(*)::int AS hotels, (SELECT count(*)::int FROM hotel_prices) AS prices FROM hotels`);
  assert.equal(hc.hotels, 46 * 12);
  assert.ok(await rebuildHotelNorms(db, s) > 0);
  const live = await db.query(`SELECT d.*, h.stars, h.rating, (SELECT count(*)::int FROM hotel_deal_dates WHERE hotel_deal_id = d.id) AS dates
    FROM hotel_deals d JOIN hotels h ON h.id = d.hotel_id WHERE status = 'live'`);
  assert.ok(live.length >= 5, `expected at least 5 live hotel deals, got ${live.length}`);
  assert.equal(published.length, live.length);
  for (const d of live) {
    assert.ok(d.saving_pct >= 25, `deal ${d.id} saving ${d.saving_pct}`);
    assert.ok(d.dates >= 3, `deal ${d.id} has ${d.dates} dates`);
    assert.ok(d.rating >= 7.5 && d.stars >= 3);
  }
  const dup = await db.query(`SELECT a.id FROM hotel_deals a JOIN hotel_deals b ON a.hotel_id = b.hotel_id AND a.id < b.id
    WHERE a.status IN ('candidate','review','live') AND b.status IN ('candidate','review','live') AND abs(a.month - b.month) <= 31`);
  assert.equal(dup.length, 0, 'one open deal per hotel across neighbouring months');

  // 7 hours later every hotel is 30% dearer: all deals expire at the re-check and the ended hook fires
  await db.query(`UPDATE hotel_deals SET last_verified = now() - interval '7 hours' WHERE status = 'live'`);
  const t = await hotelEngineTick(db, s, async () => {});
  assert.ok(t.verifies > 0);
  await runHotelWorkers(db, mockHotelSource({ priceFactor: () => 1.3 }), s, after, { concurrency: 40, drain: true });
  const [c] = await db.query(`SELECT count(*) FILTER (WHERE status = 'live')::int AS live, count(*) FILTER (WHERE status = 'expired')::int AS expired,
    count(*) FILTER (WHERE status = 'expired' AND reason LIKE 'price rose to ₹%')::int AS rose FROM hotel_deals`);
  assert.equal(c.live, 0);
  assert.equal(c.expired, live.length);
  assert.equal(c.rose, live.length);
  assert.deepEqual([...ended].sort(), live.map(d => d.id).sort());
  setHotelDealEndedHook(null);
  await db.close();
});

test('reviewHotelDeal: approve publishes and notifies, reject closes', async () => {
  const db = await freshDb();
  const [h] = await db.query(`INSERT INTO hotels (city, source, source_id, name, stars, rating) VALUES ('BKK', 'mock', 'x', 'Test Hotel', 4, 8.5) RETURNING id`);
  const mk = async (month: string) => (await db.query(`INSERT INTO hotel_deals (hotel_id, month, per_night, normal_per_night, saving_pct, currency, status)
    VALUES ($1, $2, 3000, 5000, 40, 'INR', 'review') RETURNING id`, [h.id, month]))[0].id as number;
  const a = await mk('2027-02-01');
  const notified: number[] = [];
  await reviewHotelDeal(db, a, true, async id => { notified.push(id); });
  const b = await mk('2027-06-01');
  await reviewHotelDeal(db, b, false, async id => { notified.push(id); });
  await reviewHotelDeal(db, b, true, async id => { notified.push(id); });   // no longer in review: no-op
  const rows = await db.query(`SELECT id, status, reason, published_at IS NOT NULL AS pub FROM hotel_deals ORDER BY id`);
  assert.equal(rows[0].status, 'live'); assert.equal(rows[0].pub, true);
  assert.equal(rows[1].status, 'rejected'); assert.equal(rows[1].reason, 'rejected by admin');
  assert.deepEqual(notified, [a]);
  await db.close();
});
