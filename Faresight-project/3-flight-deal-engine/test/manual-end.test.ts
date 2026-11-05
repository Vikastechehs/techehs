// Ending deals by hand from the admin pages: status, reason, ended_by, the ended hook and the users' "Ended" message. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_PASSWORD ||= 'test-admin-pass';
const { config } = await import('../src/config.ts');
const { openDb, migrate } = await import('../src/db.ts');
const { seed } = await import('../src/routes.ts');
const { startServer } = await import('../src/web/server.ts');
const { setDealEndedHook } = await import('../src/engine/deals.ts');
const { setHotelDealEndedHook } = await import('../src/hotels/deals.ts');
const { onDealEnded } = await import('../src/notify/fanout.ts');
const { onHotelDealEnded } = await import('../src/notify/hotels.ts');
const { manualEndReason } = await import('../src/web/admin-end.ts');

type Db = Awaited<ReturnType<typeof openDb>>;
const auth = { authorization: 'Basic ' + Buffer.from(`admin:${config.adminPassword}`).toString('base64') };
const month = `date_trunc('month', current_date + 30)::date`;

async function setup() {
  const db = await openDb({ memory: true });
  await migrate(db); await seed(db);
  await db.query(`INSERT INTO hotel_cities (code, name, country, region, query) VALUES ('BKK', 'Bangkok', 'TH', 'seAsia', 'Bangkok, Thailand')
    ON CONFLICT (code) DO NOTHING`);
  const server = await startServer(db, async () => {}, 0);
  return { db, server, base: `http://127.0.0.1:${(server.address() as any).port}` };
}
async function flightDeal(db: Db, dest: string, status = 'live') {
  const [r] = await db.query(`SELECT id FROM routes WHERE destination = $1 ORDER BY id LIMIT 1`, [dest]);
  const [d] = await db.query(`INSERT INTO deals (route_id, month, price, normal_price, saving_pct, currency, status, published_at, last_verified)
    VALUES ($1, ${month}, 15000, 24000, 37.5, 'INR', $2, CASE WHEN $2 = 'live' THEN now() END, now()) RETURNING id`, [r.id, status]);
  for (const k of [30, 33, 36])
    await db.query(`INSERT INTO deal_dates (deal_id, depart, return_date, price, normal_price) VALUES ($1, current_date + $2::int, current_date + $2::int + 7, 15000, 24000)`, [d.id, k]);
  return d.id as number;
}
let hotels = 0;
async function hotelDeal(db: Db, status = 'live') {
  const [h] = await db.query(`INSERT INTO hotels (city, source, source_id, name, stars, rating) VALUES ('BKK', 'test', $1, $2, 4, 8.6) RETURNING id`,
    [`h${++hotels}`, `Test Hotel ${hotels}`]);
  const [d] = await db.query(`INSERT INTO hotel_deals (hotel_id, month, per_night, normal_per_night, saving_pct, currency, status, published_at, last_verified)
    VALUES ($1, ${month}, 4200, 7000, 40, 'INR', $2, CASE WHEN $2 = 'live' THEN now() END, now()) RETURNING id`, [h.id, status]);
  await db.query(`INSERT INTO hotel_deal_dates (hotel_deal_id, checkin, nights, per_night, total, normal_per_night) VALUES ($1, current_date + 30, 3, 4200, 12600, 7000)`, [d.id]);
  return d.id as number;
}
const post = (base: string, path: string, form: Record<string, string>, headers: Record<string, string> = auth) =>
  fetch(base + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), redirect: 'manual' });

test('manualEndReason gives plain text users can read', () => {
  assert.equal(manualEndReason('flight', 'sold_out'), 'sold out: the airline withdrew this fare');
  assert.equal(manualEndReason('flight', 'price_up', '₹18,500'), 'price rose to 18500');
  assert.equal(manualEndReason('hotel', 'price_up'), 'the price went up');
  assert.equal(manualEndReason('flight', 'site_error', 'MakeMyTrip  shows ₹21,000'), 'the booking site showed this price in error. MakeMyTrip shows ₹21,000');
  assert.equal(manualEndReason('flight', 'other', 'Visa rules changed'), 'Visa rules changed');
  assert.equal(manualEndReason('flight', 'nonsense'), 'withdrawn after a manual check');
});

test('admin ends a live flight deal and a live hotel deal by hand', async () => {
  const { db, server, base } = await setup();
  const flightCalls: number[] = [], hotelCalls: number[] = [];
  setDealEndedHook(async id => { flightCalls.push(id); });
  setHotelDealEndedHook(async id => { hotelCalls.push(id); });
  try {
    const live = await flightDeal(db, 'BKK');
    const review = await flightDeal(db, 'DXB', 'review');
    await db.query(`INSERT INTO search_jobs (kind, route_id, deal_id, depart, return_date)
      SELECT 'verify', route_id, id, current_date + 30, current_date + 37 FROM deals WHERE id = $1`, [live]);

    const page = await (await fetch(base + '/admin', { headers: auth })).text();
    assert.match(page, /Live deals \(1\)/);
    assert.match(page, new RegExp(`action="/admin/deal/${live}/end"`));
    assert.match(page, /Sold out \/ airline withdrew the fare/);

    assert.equal((await post(base, `/admin/deal/${live}/end`, { reason: 'sold_out' }, {})).status, 401, 'needs admin login');
    assert.equal((await db.query(`SELECT status FROM deals WHERE id = $1`, [live]))[0].status, 'live');

    const r = await post(base, `/admin/deal/${live}/end`, { reason: 'price_up', note: '18,500' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/admin#live');
    const [d] = await db.query(`SELECT status, reason, ended_by, expired_at FROM deals WHERE id = $1`, [live]);
    assert.equal(d.status, 'expired'); assert.equal(d.ended_by, 'admin'); assert.equal(d.reason, 'price rose to 18500'); assert.ok(d.expired_at);
    assert.deepEqual(flightCalls, [live], 'ended hook called once');
    const [j] = await db.query(`SELECT status FROM search_jobs WHERE deal_id = $1`, [live]);
    assert.equal(j.status, 'failed', 'queued re-check cancelled');

    await post(base, `/admin/deal/${live}/end`, { reason: 'sold_out' });
    assert.deepEqual(flightCalls, [live], 'second end is a no-op');
    assert.equal((await db.query(`SELECT reason FROM deals WHERE id = $1`, [live]))[0].reason, 'price rose to 18500');

    await post(base, `/admin/deal/${review}/end`, { reason: 'site_error' });
    const [rv] = await db.query(`SELECT status, ended_by FROM deals WHERE id = $1`, [review]);
    assert.equal(rv.status, 'rejected'); assert.equal(rv.ended_by, 'admin');
    assert.deepEqual(flightCalls, [live], 'ending a deal in review tells nobody');

    // The old Reject button on a live deal also ends it through endDeal
    const live2 = await flightDeal(db, 'SIN');
    await post(base, `/admin/deal/${live2}/reject`, {});
    const [l2] = await db.query(`SELECT status, ended_by FROM deals WHERE id = $1`, [live2]);
    assert.equal(l2.status, 'expired'); assert.equal(l2.ended_by, 'admin');
    assert.deepEqual(flightCalls, [live, live2]);

    // Hotels
    const hLive = await hotelDeal(db);
    const hReview = await hotelDeal(db, 'review');
    const hp = await (await fetch(base + '/admin/hotels', { headers: auth })).text();
    assert.match(hp, /Live deals \(1\)/);
    assert.match(hp, new RegExp(`action="/admin/hotels/deal/${hLive}/end"`));
    assert.equal((await post(base, `/admin/hotels/deal/${hLive}/end`, { reason: 'sold_out' }, {})).status, 401);
    const hr = await post(base, `/admin/hotels/deal/${hLive}/end`, { reason: 'sold_out' });
    assert.equal(hr.status, 303);
    const [hd] = await db.query(`SELECT status, reason, ended_by FROM hotel_deals WHERE id = $1`, [hLive]);
    assert.equal(hd.status, 'expired'); assert.equal(hd.ended_by, 'admin'); assert.equal(hd.reason, 'the hotel withdrew this rate');
    assert.deepEqual(hotelCalls, [hLive]);
    await post(base, `/admin/hotels/deal/${hLive}/end`, { reason: 'other' });
    assert.deepEqual(hotelCalls, [hLive], 'second end is a no-op');
    await post(base, `/admin/hotels/deal/${hReview}/end`, { reason: 'other' });
    assert.equal((await db.query(`SELECT status FROM hotel_deals WHERE id = $1`, [hReview]))[0].status, 'rejected');
    assert.deepEqual(hotelCalls, [hLive], 'ending a hotel deal in review tells nobody');
    assert.equal((await fetch(`${base}/admin/hotels/deal/${hLive}/end`, { headers: auth })).status, 405);
  } finally { setDealEndedHook(null); setHotelDealEndedHook(null); server.close(); await db.close(); }
});

test('users who were told get the "Ended" message when an admin ends the deal', async () => {
  const { db, server, base } = await setup();
  setDealEndedHook(async id => { await onDealEnded(db, id); });
  setHotelDealEndedHook(async id => { await onHotelDealEnded(db, id); });
  try {
    const dealId = await flightDeal(db, 'BKK');
    const hotelId = await hotelDeal(db);
    const [u] = await db.query(`INSERT INTO users (email, email_verified_at) VALUES ('asha@example.com', now()) RETURNING id`);
    const [ch] = await db.query(`INSERT INTO notification_channels (user_id, kind, address, verified_at) VALUES ($1, 'email', 'asha@example.com', now()) RETURNING id`, [u.id]);
    await db.query(`INSERT INTO notifications (user_id, deal_id, channel_id, kind, status, sent_at) VALUES ($1, $2, $3, 'deal_live', 'sent', now())`, [u.id, dealId, ch.id]);
    await db.query(`INSERT INTO notifications (user_id, hotel_deal_id, channel_id, kind, status, sent_at) VALUES ($1, $2, $3, 'hotel_live', 'sent', now())`, [u.id, hotelId, ch.id]);

    assert.equal((await post(base, `/admin/deal/${dealId}/end`, { reason: 'sold_out' })).status, 303);
    const msgs = await db.query(`SELECT to_address, subject, body FROM outbox WHERE meta ->> 'kind' = 'deal_ended'`);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].to_address, 'asha@example.com');
    assert.match(msgs[0].body, /^Ended: .+\. Sold out: the airline withdrew this fare\./);
    const [n] = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE deal_id = $1 AND kind = 'deal_ended' AND user_id = $2`, [dealId, u.id]);
    assert.equal(n.n, 1);
    await post(base, `/admin/deal/${dealId}/end`, { reason: 'sold_out' });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM outbox WHERE meta ->> 'kind' = 'deal_ended'`))[0].n, 1, 'no second message');

    assert.equal((await post(base, `/admin/hotels/deal/${hotelId}/end`, { reason: 'price_up', note: '6100' })).status, 303);
    const [hm] = await db.query(`SELECT body FROM outbox WHERE meta ->> 'kind' = 'hotel_ended'`);
    assert.ok(hm, 'hotel ended message queued');
    assert.match(hm.body, /Ended: .+The rate rose to ₹6,100 a night\./);
  } finally { setDealEndedHook(null); setHotelDealEndedHook(null); server.close(); await db.close(); }
});
