// Hotel website and admin: list, deal page, booking redirect, city page, API, 404s, admin review. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_PASSWORD ||= 'test-admin-pass';
const { config } = await import('../src/config.ts');
const { openDb, migrate } = await import('../src/db.ts');
const { seed } = await import('../src/routes.ts');
const { startServer } = await import('../src/web/server.ts');

test('hotel pages, booking redirect and admin review', async () => {
  const db = await openDb({ memory: true });
  await migrate(db); await seed(db);
  await db.query(`INSERT INTO hotel_cities (code, name, country, region, query) VALUES ('BKK', 'Bangkok', 'TH', 'seAsia', 'Bangkok, Thailand')
    ON CONFLICT (code) DO NOTHING`);
  const [h] = await db.query(`INSERT INTO hotels (city, source, source_id, name, stars, rating, reviews, area)
    VALUES ('BKK', 'test', 'h1', 'Riverside <Grand>', 4, 8.7, 1200, 'Silom') RETURNING id`);
  const [h2] = await db.query(`INSERT INTO hotels (city, source, source_id, name, stars, rating, area)
    VALUES ('BKK', 'test', 'h2', 'Sukhumvit Suites', 5, 9.1, 'Sukhumvit') RETURNING id`);
  const month = `date_trunc('month', current_date + 30)::date`;
  const [live] = await db.query(`INSERT INTO hotel_deals (hotel_id, month, per_night, normal_per_night, saving_pct, currency, status, published_at, last_verified)
    VALUES ($1, ${month}, 4200, 7000, 40, 'INR', 'live', now(), now()) RETURNING id`, [h.id]);
  const [rev] = await db.query(`INSERT INTO hotel_deals (hotel_id, month, per_night, normal_per_night, saving_pct, currency, status)
    VALUES ($1, ${month}, 6000, 9000, 33, 'INR', 'review') RETURNING id`, [h2.id]);
  const dates: number[] = [];
  for (const [off, pn] of [[30, 4200], [32, 4300], [37, 4500]]) {
    const [x] = await db.query(`INSERT INTO hotel_deal_dates (hotel_deal_id, checkin, nights, per_night, total, normal_per_night, provider)
      VALUES ($1, current_date + $2::int, 3, $3::float8, $3::float8 * 3, 7000, 'Agoda') RETURNING id`, [live.id, off, pn]);
    dates.push(x.id);
  }
  await db.query(`INSERT INTO hotel_deal_dates (hotel_deal_id, checkin, nights, per_night, total, normal_per_night) VALUES ($1, current_date + 31, 3, 6000, 18000, 9000)`, [rev.id]);
  for (let i = 1; i <= 20; i++)
    await db.query(`INSERT INTO hotel_prices (hotel_id, checkin, nights, per_night, total, currency, source)
      VALUES ($1, current_date + $2::int, 3, $3::float8, $3::float8 * 3, 'INR', 'test')`, [i % 2 ? h.id : h2.id, i * 3, 5000 + i * 100]);
  const [route] = await db.query(`SELECT id FROM routes WHERE destination = 'BKK' ORDER BY id LIMIT 1`);
  const [fd] = await db.query(`INSERT INTO deals (route_id, month, price, normal_price, saving_pct, currency, status, published_at, last_verified)
    VALUES ($1, ${month}, 15000, 24000, 37, 'INR', 'live', now(), now()) RETURNING id`, [route.id]);
  await db.query(`INSERT INTO hotel_norms (hotel_id, month, median_per_night, sample_size) VALUES ($1, ${month}, 7000, 12)`, [h.id]);

  const server = await startServer(db, async () => {}, 0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const auth = { authorization: 'Basic ' + Buffer.from(`admin:${config.adminPassword}`).toString('base64') };
  try {
    const list = await fetch(base + '/hotels');
    assert.equal(list.status, 200);
    const lh = await list.text();
    assert.match(lh, /Riverside &lt;Grand&gt;/, 'names are escaped');
    assert.doesNotMatch(lh, /Sukhumvit Suites/, 'deals in review are not public');
    assert.match(lh, new RegExp(`href="/hotel-deal/${live.id}"`));
    assert.match(lh, /40% below/);
    assert.match(lh, /href="\/hotels"/, 'nav has Hotels');
    assert.doesNotMatch(await (await fetch(base + '/hotels?stars=5')).text(), /Riverside/, 'stars filter');
    assert.doesNotMatch(await (await fetch(base + '/hotels?max=3000')).text(), /Riverside/, 'max per night filter');
    assert.match(await (await fetch(base + '/hotels?city=BKK')).text(), /Riverside/);
    assert.equal((await fetch(base + '/hotels/expired')).status, 200);

    const page = await fetch(`${base}/hotel-deal/${live.id}`);
    assert.equal(page.status, 200);
    const ph = await page.text();
    assert.match(ph, new RegExp(`href="/go/h/${dates[0]}\\?ch=web"`), 'Book link');
    assert.match(ph, /action="\/hotel-deal\/\d+\/save"/);
    assert.match(ph, /name="csrf"/);
    assert.match(ph, /Flights to Bangkok/);
    assert.match(ph, /href="\/route\/[A-Z]{3}-BKK"/);
    assert.match(ph, new RegExp(`href="/deal/${fd.id}"`), 'live flight deal to the city');
    const flight = await (await fetch(`${base}/deal/${fd.id}`)).text();
    assert.match(flight, /Hotel deals in Bangkok/, 'flight deal page shows the hotel strip');
    assert.match(flight, new RegExp(`href="/hotel-deal/${live.id}"`));
    assert.match(await (await fetch(base + '/')).text(), /href="\/hotels"/);
    assert.match(ph, /12,600/, 'total for the cheapest stay');
    assert.equal((await fetch(`${base}/hotel-deal/${rev.id}`)).status, 404, 'review deals are hidden');
    assert.equal((await fetch(`${base}/hotel-deal/999999`)).status, 404);

    const go = await fetch(`${base}/go/h/${dates[0]}?ch=telegram`, { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.match(go.headers.get('location') ?? '', /booking\.com/);
    const [clk] = await db.query(`SELECT hotel_deal_id, hotel_deal_date_id, channel, user_id FROM hotel_clicks`);
    assert.equal(clk.hotel_deal_id, live.id);
    assert.equal(clk.hotel_deal_date_id, dates[0]);
    assert.equal(clk.channel, 'telegram');
    assert.equal(clk.user_id, null);
    assert.equal((await fetch(`${base}/go/h/999999`, { redirect: 'manual' })).status, 404);

    const city = await fetch(base + '/hotels/BKK');
    assert.equal(city.status, 200);
    const ch = await city.text();
    assert.match(ch, /Hotels in Bangkok/);
    assert.match(ch, /class="cal"/, 'price calendar');
    assert.match(ch, /Sukhumvit Suites/, 'tracked hotels listed');
    assert.equal((await fetch(base + '/hotels/bkk', { redirect: 'manual' })).status, 301);
    assert.equal((await fetch(base + '/hotels/XYZ')).status, 404);

    const api = await (await fetch(base + '/api/hotel-deals')).json() as any[];
    assert.equal(api.length, 1);
    assert.equal(api[0].id, live.id);
    assert.equal(api[0].dates, 3);

    const save = await fetch(`${base}/hotel-deal/${live.id}/save`, { method: 'POST', redirect: 'manual' });
    assert.equal(save.status, 303, 'signed-out save goes to sign in');
    assert.match(save.headers.get('location') ?? '', /^\/signin/);

    // Signed in: save with the CSRF token from the deal page, then the page shows it as saved
    const [u] = await db.query(`INSERT INTO users (email, name, home_airport) VALUES ('asha@example.com', 'Asha', 'DEL') RETURNING id`);
    const { createHash } = await import('node:crypto');
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [createHash('sha256').update('tok-asha').digest('hex'), u.id]);
    const cookie = { cookie: 'fs_session=tok-asha' };
    const mine = await (await fetch(`${base}/hotel-deal/${live.id}`, { headers: cookie })).text();
    const csrf = mine.match(/name="csrf" value="([^"]+)"/)![1];
    const bad = await fetch(`${base}/hotel-deal/${live.id}/save`, { method: 'POST', headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=nope', redirect: 'manual' });
    assert.equal(bad.status, 403);
    const ok = await fetch(`${base}/hotel-deal/${live.id}/save`, { method: 'POST', headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=' + encodeURIComponent(csrf), redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.equal((await db.query(`SELECT 1 FROM saved_hotel_deals WHERE user_id = $1 AND hotel_deal_id = $2`, [u.id, live.id])).length, 1);
    assert.match(await (await fetch(`${base}/hotel-deal/${live.id}`, { headers: cookie })).text(), /\/unsave"/);
    const go2 = await fetch(`${base}/go/h/${dates[1]}`, { headers: cookie, redirect: 'manual' });
    assert.equal(go2.status, 302);
    const [c2] = await db.query(`SELECT user_id, channel FROM hotel_clicks WHERE hotel_deal_date_id = $1`, [dates[1]]);
    assert.equal(c2.user_id, u.id);
    assert.equal(c2.channel, 'web');

    assert.equal((await fetch(base + '/admin/hotels')).status, 401);
    const adm = await fetch(base + '/admin/hotels', { headers: auth });
    assert.equal(adm.status, 200);
    const ah = await adm.text();
    assert.match(ah, /Waiting for review \(1\)/);
    assert.match(ah, /Sukhumvit Suites/);
    assert.equal((await fetch(`${base}/admin/hotels/preview/${rev.id}`, { headers: auth })).status, 200);
    assert.match(await (await fetch(base + '/admin', { headers: auth })).text(), /href="\/admin\/hotels"/);
    assert.equal((await fetch(`${base}/admin/hotels/deal/${rev.id}/approve`, { method: 'POST', redirect: 'manual' })).status, 401);
    const ap = await fetch(`${base}/admin/hotels/deal/${rev.id}/approve`, { method: 'POST', headers: auth, redirect: 'manual' });
    assert.equal(ap.status, 303);
    const [after] = await db.query(`SELECT status FROM hotel_deals WHERE id = $1`, [rev.id]);
    assert.equal(after.status, 'live');
    assert.equal((await fetch(`${base}/hotel-deal/${rev.id}`)).status, 200);
  } finally {
    server.close();
    await db.close();
  }
});
