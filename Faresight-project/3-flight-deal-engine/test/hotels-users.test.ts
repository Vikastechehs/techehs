// Hotel user data (alerts, saved hotel deals, export/delete) and hotel notifications (live, ended, digest, delivery),
// on an in-memory database. Run: node --test test/hotels-users.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb, migrate, type Db } from '../src/db.ts';
import { seed } from '../src/routes.ts';
import { config } from '../src/config.ts';
import { startServer } from '../src/web/server.ts';
import { onHotelDealLive, onHotelDealEnded } from '../src/notify/hotels.ts';
import { onDealLive } from '../src/notify/fanout.ts';
import { deliverOutbox } from '../src/notify/deliver.ts';
import { sendDailyDigests } from '../src/notify/digest.ts';
import { deleteAccount, exportUserData, saveHotelDeal, unsaveHotelDeal, upsertHotelAlert, UserError } from '../src/users/service.ts';

const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

async function freshDb(): Promise<Db> {
  const db = await openDb({ memory: true });
  await migrate(db);
  await seed(db);
  await addCities(db);
  return db;
}
/** Test cities with codes no seed uses, so the tests don't depend on seeded hotel data. */
async function addCities(db: Db) {
  for (const [code, name, country, region, active] of [
    ['ZBK', 'Testbangkok', 'TH', 'seAsia', true], ['ZGO', 'Testgoa', 'IN', 'india', true], ['ZOF', 'Closedcity', 'IN', 'india', false],
  ] as const) {
    await db.query(`INSERT INTO hotel_cities (code, name, country, region, query, active) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
      [code, name, country, region, `${name}, ${country}`, active]);
  }
}
let hotelN = 0;
async function makeHotelDeal(db: Db, o: { city?: string; stars?: number | null; perNight?: number; normal?: number; status?: string; name?: string } = {}) {
  const [h] = await db.query(`INSERT INTO hotels (city, source, source_id, name, stars) VALUES ($1, 'mock', $2, $3, $4) RETURNING id`,
    [o.city ?? 'ZBK', `t${++hotelN}`, o.name ?? `Hotel ${hotelN}`, o.stars === undefined ? 4 : o.stars]);
  const perNight = o.perNight ?? 3200, normal = o.normal ?? 4900;
  const saving = Math.round((1 - perNight / normal) * 1000) / 10;
  const [d] = await db.query(`INSERT INTO hotel_deals (hotel_id, month, per_night, normal_per_night, saving_pct, currency, status, published_at)
    VALUES ($1, date_trunc('month', current_date + 40)::date, $2, $3, $4, 'INR', $5, now()) RETURNING id`, [h.id, perNight, normal, saving, o.status ?? 'live']);
  for (const k of [40, 41, 43]) {
    await db.query(`INSERT INTO hotel_deal_dates (hotel_deal_id, checkin, nights, per_night, total, normal_per_night) VALUES ($1,$2,3,$3,$4,$5)`,
      [d.id, future(k), perNight, perNight * 3, normal]);
  }
  return d.id as number;
}
let emails = 0;
async function makeUser(db: Db, opts: { status?: string; channels?: { kind: string; frequency?: string }[] } = {}) {
  const [u] = await db.query(`INSERT INTO users (email, status) VALUES ($1, $2) RETURNING id`, [`h${++emails}@example.com`, opts.status ?? 'active']);
  const channels: number[] = [];
  for (const c of opts.channels ?? [{ kind: 'email' }]) {
    const address = c.kind === 'email' ? `h${emails}@example.com` : c.kind === 'telegram' ? `${5000 + emails}` : '+919812345678';
    const [ch] = await db.query(`INSERT INTO notification_channels (user_id, kind, address, frequency, verified_at) VALUES ($1,$2,$3,$4, now()) RETURNING id`,
      [u.id, c.kind, address, c.frequency ?? 'instant']);
    channels.push(ch.id);
  }
  return { id: u.id as number, channels };
}
const sub = (db: Db, userId: number, city: string, a: { min?: number; max?: number | null; stars?: number | null } = {}) =>
  db.query(`INSERT INTO hotel_alert_subscriptions (user_id, city, min_saving_pct, max_per_night, min_stars) VALUES ($1,$2,$3,$4,$5)`,
    [userId, city, a.min ?? 25, a.max ?? null, a.stars ?? null]);
const notified = async (db: Db, id: number, kind = 'hotel_live') =>
  (await db.query(`SELECT user_id FROM notifications WHERE hotel_deal_id = $1 AND kind = $2 ORDER BY user_id, channel_id`, [id, kind])).map(r => r.user_id);
async function withConfig(patch: Partial<typeof config>, fn: () => Promise<void>) {
  const old: any = {}; for (const k of Object.keys(patch)) old[k] = (config as any)[k];
  Object.assign(config, patch);
  try { await fn(); } finally { Object.assign(config, old); }
}
const noProviders = { resendApiKey: '', telegramToken: '', whatsappToken: '', whatsappPhoneId: '', vapidPublicKey: '', vapidPrivateKey: '' };

// --- API (one server, one database) ---
let db: Db, server: Server, base = '';
before(async () => {
  db = await freshDb();
  server = await startServer(db, async () => {}, 0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { server.close(); await db.close(); });

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const r = await fetch(base + '/api/v1/' + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, data: await r.json() as any };
}
async function signIn(email: string) {
  assert.equal((await call('POST', 'auth/code', { body: { email } })).status, 200);
  const [m] = await db.query(`SELECT body FROM outbox WHERE to_address = $1 ORDER BY id DESC LIMIT 1`, [email]);
  const r = await call('POST', 'auth/verify', { body: { email, code: m.body.match(/\b(\d{6})\b/)[1], client: 'app' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { token: r.data.token as string, id: r.data.user.id as number };
}

test('public hotel city list', async () => {
  const r = await call('GET', 'hotel-cities');
  assert.equal(r.status, 200);
  const bk = r.data.cities.find((c: any) => c.code === 'ZBK');
  assert.deepEqual(bk, { code: 'ZBK', name: 'Testbangkok', country: 'TH', region: 'seAsia' });
  assert.ok(!r.data.cities.some((c: any) => c.code === 'ZOF'), 'inactive cities are hidden');
});

test('hotel alerts: create, validate, update, list, delete', async () => {
  assert.equal((await call('GET', 'me/hotel-alerts')).status, 401);
  const { token: t } = await signIn('hotelfan@example.com');
  for (const body of [{ city: 'XXX' }, { city: 'ZOF' }, { city: 'ZBK', min_saving_pct: 20 }, { city: 'ZBK', min_saving_pct: 91 },
    { city: 'ZBK', min_stars: 6 }, { city: 'ZBK', min_stars: 0 }, { city: 'ZBK', min_stars: 3.5 }, { city: 'ZBK', max_per_night: -5 }, { city: 'ZBK', active: 'yes' }, {}]) {
    const r = await call('POST', 'me/hotel-alerts', { token: t, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.data.error);
  }
  const a = await call('POST', 'me/hotel-alerts', { token: t, body: { city: 'zbk', min_saving_pct: 35, max_per_night: 5000, min_stars: 4 } });
  assert.equal(a.status, 200);
  assert.deepEqual({ ...a.data.hotel_alert, id: 0, created_at: '' },
    { id: 0, city: 'ZBK', city_name: 'Testbangkok', min_saving_pct: 35, max_per_night: 5000, min_stars: 4, active: true, created_at: '' });
  // A partial update keeps the other settings
  const a2 = await call('POST', 'me/hotel-alerts', { token: t, body: { city: 'ZBK', active: false } });
  assert.equal(a2.data.hotel_alert.id, a.data.hotel_alert.id);
  assert.equal(a2.data.hotel_alert.min_saving_pct, 35); assert.equal(a2.data.hotel_alert.min_stars, 4); assert.equal(a2.data.hotel_alert.active, false);
  const a3 = await call('POST', 'me/hotel-alerts', { token: t, body: { city: 'ZBK', min_stars: null, max_per_night: null } });
  assert.equal(a3.data.hotel_alert.min_stars, null); assert.equal(a3.data.hotel_alert.max_per_night, null);
  await call('POST', 'me/hotel-alerts', { token: t, body: { city: 'ZGO' } });
  assert.deepEqual((await call('GET', 'me/hotel-alerts', { token: t })).data.hotel_alerts.map((x: any) => x.city), ['ZBK', 'ZGO']);
  assert.equal((await call('DELETE', 'me/hotel-alerts/zgo', { token: t })).status, 200);
  assert.deepEqual((await call('GET', 'me/hotel-alerts', { token: t })).data.hotel_alerts.map((x: any) => x.city), ['ZBK']);
  // Service-level validation throws UserError
  await assert.rejects(upsertHotelAlert(db, 1, { city: 'ZBK', min_saving_pct: 10 }), UserError);
});

test('saved hotel deals via the API', async () => {
  const { token: t, id } = await signIn('hotelsaver@example.com');
  const live = await makeHotelDeal(db, { name: 'Riverside Inn' });
  const cand = await makeHotelDeal(db, { status: 'candidate' });
  assert.equal((await call('PUT', `me/saved-hotels/${cand}`, { token: t })).status, 404);
  assert.equal((await call('PUT', 'me/saved-hotels/999999', { token: t })).status, 404);
  assert.equal((await call('PUT', `me/saved-hotels/${live}`, { token: t })).status, 200);
  assert.equal((await call('PUT', `me/saved-hotels/${live}`, { token: t })).status, 200, 'saving twice is fine');
  const s = (await call('GET', 'me/saved-hotels', { token: t })).data.saved_hotels;
  assert.equal(s.length, 1);
  assert.equal(s[0].hotel_deal_id, live); assert.equal(s[0].hotel_name, 'Riverside Inn'); assert.equal(s[0].city_name, 'Testbangkok');
  assert.equal(s[0].stars, 4); assert.equal(s[0].per_night, 3200); assert.equal(s[0].normal_per_night, 4900); assert.equal(s[0].status, 'live');
  assert.ok(s[0].saved_at);
  assert.equal((await call('DELETE', `me/saved-hotels/${live}`, { token: t })).status, 200);
  assert.equal((await call('GET', 'me/saved-hotels', { token: t })).data.saved_hotels.length, 0);
  // The service functions the hotel pages call
  await saveHotelDeal(db, id, live);
  await unsaveHotelDeal(db, id, live);
  await assert.rejects(saveHotelDeal(db, id, cand), UserError);
});

test('export includes hotel data; deleting the account removes it', async () => {
  const { token: t, id } = await signIn('hotelexport@example.com');
  const live = await makeHotelDeal(db);
  await call('POST', 'me/hotel-alerts', { token: t, body: { city: 'ZGO', min_stars: 3 } });
  await call('PUT', `me/saved-hotels/${live}`, { token: t });
  await db.query(`INSERT INTO hotel_clicks (hotel_deal_id, user_id, channel, partner) VALUES ($1,$2,'web','mock')`, [live, id]);
  const x = (await call('GET', 'me/export', { token: t })).data;
  assert.equal(x.hotel_alerts[0].city, 'ZGO');
  assert.equal(x.saved_hotels[0].hotel_deal_id, live);
  assert.equal(x.hotel_clicks[0].hotel_deal_id, live);
  const viaService = await exportUserData(db, id);
  assert.ok(Array.isArray(viaService.hotel_alerts) && Array.isArray(viaService.saved_hotels) && Array.isArray(viaService.hotel_clicks));
  await deleteAccount(db, id);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM hotel_alert_subscriptions WHERE user_id = $1`, [id]))[0].n, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM saved_hotel_deals WHERE user_id = $1`, [id]))[0].n, 0);
  assert.equal((await call('GET', 'me/saved-hotels', { token: t })).status, 401);
});

// --- Notifications (fresh database per test) ---
test('hotel deal live: matches city, saving, price per night and stars; no duplicates', async () => {
  const ndb = await freshDb();
  const id = await makeHotelDeal(ndb, { city: 'ZBK', stars: 4, perNight: 3200, normal: 4900, name: 'Lotus Palace' }); // 34.7% below
  const match = await makeUser(ndb, { channels: [{ kind: 'email' }, { kind: 'telegram' }] }); await sub(ndb, match.id, 'ZBK');
  const otherCity = await makeUser(ndb); await sub(ndb, otherCity.id, 'ZGO');
  const tooGreedy = await makeUser(ndb); await sub(ndb, tooGreedy.id, 'ZBK', { min: 35 });
  const budgetOk = await makeUser(ndb); await sub(ndb, budgetOk.id, 'ZBK', { max: 3200 });
  const budgetLow = await makeUser(ndb); await sub(ndb, budgetLow.id, 'ZBK', { max: 3000 });
  const starsOk = await makeUser(ndb); await sub(ndb, starsOk.id, 'ZBK', { stars: 4 });
  const starsHigh = await makeUser(ndb); await sub(ndb, starsHigh.id, 'ZBK', { stars: 5 });
  const disabled = await makeUser(ndb, { status: 'disabled' }); await sub(ndb, disabled.id, 'ZBK');
  const paused = await makeUser(ndb); await sub(ndb, paused.id, 'ZBK');
  await ndb.query(`UPDATE hotel_alert_subscriptions SET active = false WHERE user_id = $1`, [paused.id]);
  const daily = await makeUser(ndb, { channels: [{ kind: 'email', frequency: 'daily' }] }); await sub(ndb, daily.id, 'ZBK');

  const r = await onHotelDealLive(ndb, id);
  assert.deepEqual(await notified(ndb, id), [match.id, match.id, budgetOk.id, starsOk.id, daily.id]);
  assert.deepEqual(r, { users: 4, instant: 4, daily: 1 });
  const out = await ndb.query(`SELECT * FROM outbox ORDER BY id`);
  assert.equal(out.length, 4, 'daily channels wait for the digest');
  for (const o of out) {
    const [n] = await ndb.query(`SELECT * FROM notifications WHERE id = $1`, [o.meta.notification_id]);
    assert.equal(n.channel_id, o.meta.channel_id); assert.equal(n.hotel_deal_id, id); assert.equal(n.deal_id, null); assert.equal(n.status, 'queued');
    assert.deepEqual(o.meta.notification_ids, [n.id]);
    assert.equal(o.meta.hotel_deal_id, id); assert.equal(o.meta.kind, 'hotel_live');
    assert.ok(o.body.includes(`${config.publicUrl}/unsubscribe?t=`), 'stop link');
  }
  const tg = out.find(o => o.channel === 'telegram')!;
  const lines = tg.body.split('\n');
  assert.equal(lines[0], '🏨 Lotus Palace ★★★★ · Testbangkok');
  assert.equal(lines[1], '₹3,200/night · normally ₹4,900 · 35% below');
  assert.match(lines[2], /^[A-Z][a-z]{2} \d{4}( – [A-Z][a-z]{2} \d{4})? · 3 dates$/);
  assert.equal(lines[3], `${config.publicUrl}/hotel-deal/${id}`);
  const em = out.find(o => o.channel === 'email')!;
  assert.match(em.subject, /35% below normal: Lotus Palace, Testbangkok from ₹3,200\/night/);
  assert.ok(em.meta.html.includes('Lotus Palace') && em.meta.html.includes('/unsubscribe?t='));

  const again = await onHotelDealLive(ndb, id);
  assert.equal(again.instant + again.daily, 0);
  assert.equal((await ndb.query(`SELECT count(*)::int AS n FROM outbox`))[0].n, 4);
  // Not live: nothing
  const cand = await makeHotelDeal(ndb, { status: 'candidate' });
  assert.deepEqual(await onHotelDealLive(ndb, cand), { users: 0, instant: 0, daily: 0 });
  // A hotel without a star rating doesn't match a stars filter
  const noStars = await makeHotelDeal(ndb, { stars: null });
  await onHotelDealLive(ndb, noStars);
  assert.ok(!(await notified(ndb, noStars)).includes(starsOk.id));
  assert.ok((await notified(ndb, noStars)).includes(budgetOk.id));
  await ndb.close();
});

test('delivery without providers marks hotel messages logged; ended reaches notified and saved users only', async () => {
  const ndb = await freshDb();
  const id = await makeHotelDeal(ndb, { name: 'Sea Breeze', stars: 3 });
  const told = await makeUser(ndb, { channels: [{ kind: 'email' }, { kind: 'telegram' }] }); await sub(ndb, told.id, 'ZBK');
  await ndb.query(`UPDATE notification_channels SET active = false WHERE id = $1`, [told.channels[1]]);  // told on email only
  const saver = await makeUser(ndb, { channels: [{ kind: 'email' }, { kind: 'whatsapp' }] });
  await saveHotelDeal(ndb, saver.id, id);
  const bystander = await makeUser(ndb); await sub(ndb, bystander.id, 'ZGO');

  await onHotelDealLive(ndb, id);
  await withConfig(noProviders, async () => {
    const d = await deliverOutbox(ndb);
    assert.deepEqual(d, { sent: 0, logged: 1, retried: 0, failed: 0 });
  });
  const [n] = await ndb.query(`SELECT status, sent_at FROM notifications WHERE hotel_deal_id = $1 AND kind = 'hotel_live'`, [id]);
  assert.equal(n.status, 'sent'); assert.ok(n.sent_at);
  assert.equal((await ndb.query(`SELECT status FROM outbox`))[0].status, 'logged');

  // A late subscriber whose message hasn't gone out yet: cancelled when the deal ends
  const late = await makeUser(ndb); await sub(ndb, late.id, 'ZBK');
  await onHotelDealLive(ndb, id);
  // The told user's telegram comes back on: still only told on email
  await ndb.query(`UPDATE notification_channels SET active = true WHERE id = $1`, [told.channels[1]]);

  await ndb.query(`UPDATE hotel_deals SET status = 'expired', reason = 'no rooms found', expired_at = now() WHERE id = $1`, [id]);
  const r = await onHotelDealEnded(ndb, id);
  assert.equal(r.users, 2);
  const ended = await ndb.query(`SELECT user_id, channel_id FROM notifications WHERE hotel_deal_id = $1 AND kind = 'hotel_ended' ORDER BY user_id, channel_id`, [id]);
  assert.deepEqual(ended.map(e => [e.user_id, e.channel_id]), [[told.id, told.channels[0]], [saver.id, saver.channels[0]], [saver.id, saver.channels[1]]]);
  const [lateN] = await ndb.query(`SELECT status, error FROM notifications WHERE user_id = $1 AND hotel_deal_id = $2`, [late.id, id]);
  assert.equal(lateN.status, 'skipped');
  const [lateO] = await ndb.query(`SELECT status FROM outbox WHERE meta ->> 'user_id' = $1::text`, [String(late.id)]);
  assert.equal(lateO.status, 'failed');
  const msgs = await ndb.query(`SELECT body, subject FROM outbox WHERE meta ->> 'kind' = 'hotel_ended'`);
  assert.equal(msgs.length, 3);
  for (const m of msgs) {
    assert.match(m.body, /Ended: Sea Breeze, Testbangkok\. No rooms were left at this rate when we re-checked\./);
    assert.ok(m.body.includes(`/hotel-deal/${id}`));
  }
  // Second call: nothing new; a live deal is never "ended"
  assert.equal((await onHotelDealEnded(ndb, id)).instant, 0);
  assert.equal((await onHotelDealEnded(ndb, await makeHotelDeal(ndb))).users, 0);
  await ndb.close();
});

test('daily digest includes queued hotel notices next to flight deals', async () => {
  const ndb = await freshDb();
  const hid = await makeHotelDeal(ndb, { name: 'Palm Court' });
  const goneId = await makeHotelDeal(ndb, { name: 'Gone Hotel' });
  const [route] = await ndb.query(`SELECT id FROM routes WHERE origin = 'DEL' AND destination = 'BKK'`);
  const [fd] = await ndb.query(`INSERT INTO deals (route_id, month, price, normal_price, saving_pct, currency, status, published_at)
    VALUES ($1, date_trunc('month', current_date + 40)::date, 13000, 20000, 35, 'INR', 'live', now()) RETURNING id`, [route.id]);
  await ndb.query(`INSERT INTO deal_dates (deal_id, depart, return_date, price, normal_price) VALUES ($1,$2,$3,13000,20000)`, [fd.id, future(40), future(47)]);
  const u = await makeUser(ndb, { channels: [{ kind: 'email', frequency: 'daily' }] });
  await sub(ndb, u.id, 'ZBK');
  await ndb.query(`INSERT INTO alert_subscriptions (user_id, origin) VALUES ($1, 'DEL')`, [u.id]);
  await onHotelDealLive(ndb, hid);
  await onHotelDealLive(ndb, goneId);
  await onDealLive(ndb, fd.id);
  await ndb.query(`UPDATE hotel_deals SET status = 'expired', reason = 'all dates passed' WHERE id = $1`, [goneId]);
  assert.equal((await ndb.query(`SELECT count(*)::int AS n FROM outbox`))[0].n, 0);

  const now = new Date('2030-01-10T06:00:00Z');   // 11:30 in India
  assert.equal(await sendDailyDigests(ndb, { now }), 1);
  const [o] = await ndb.query(`SELECT * FROM outbox`);
  assert.equal(o.subject, '1 flight deal and 1 hotel deal for you today');
  assert.match(o.body, /🏨 Palm Court, Testbangkok: ₹3,200\/night \(normally ₹4,900, 35% below\)/);
  assert.ok(o.body.includes(`${config.publicUrl}/hotel-deal/${hid}`));
  assert.ok(o.body.includes(`${config.publicUrl}/deal/${fd.id}`));
  assert.ok(!o.body.includes('Gone Hotel'), 'a hotel deal that ended before the digest is left out');
  const [gone] = await ndb.query(`SELECT status FROM notifications WHERE hotel_deal_id = $1`, [goneId]);
  assert.equal(gone.status, 'skipped');
  await withConfig(noProviders, async () => { assert.equal((await deliverOutbox(ndb)).logged, 1); });
  const st = await ndb.query(`SELECT kind, status FROM notifications WHERE user_id = $1 AND status <> 'skipped' ORDER BY id`, [u.id]);
  assert.deepEqual(st.map(s => `${s.kind}:${s.status}`), ['hotel_live:sent', 'deal_live:sent', 'digest:sent']);
  // Only hotels: the title says so
  const ndb2 = await freshDb();
  const h2 = await makeHotelDeal(ndb2);
  const u2 = await makeUser(ndb2, { channels: [{ kind: 'telegram', frequency: 'daily' }] }); await sub(ndb2, u2.id, 'ZBK');
  await onHotelDealLive(ndb2, h2);
  assert.equal(await sendDailyDigests(ndb2, { now }), 1);
  assert.equal((await ndb2.query(`SELECT subject FROM outbox`))[0].subject, '1 hotel deal for you today');
  await ndb.close(); await ndb2.close();
});
