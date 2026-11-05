// User-facing pages: sign-in, alerts, account, route pages, explore, unsubscribe, PWA files. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, type Db } from '../src/db.ts';
import { seed } from '../src/routes.ts';
import { startServer } from '../src/web/server.ts';
import { unsubscribeToken } from '../src/notify/unsubscribe.ts';

let db: Db, server: Awaited<ReturnType<typeof startServer>>, base: string;
let routeId: number, dealId: number;

before(async () => {
  db = await openDb({ memory: true });
  await migrate(db);
  await seed(db);
  // Mock prices for DEL-BKK: a departure every 7 days for 10 weeks, around ₹30,000, one very cheap date.
  [{ id: routeId }] = await db.query(`SELECT id FROM routes WHERE origin = 'DEL' AND destination = 'BKK'`);
  for (let i = 0; i < 10; i++) {
    const price = i === 3 ? 18000 : 29000 + (i % 3) * 1000;
    await db.query(`INSERT INTO price_observations (route_id, depart, return_date, nights, price, currency, source, kind)
      VALUES ($1, current_date + $2::int, current_date + $2::int + 7, 7, $3, 'INR', 'mock', 'sweep')`, [routeId, 5 + i * 7, price]);
  }
  // An old observation that must be ignored (older than 14 days)
  await db.query(`INSERT INTO price_observations (route_id, depart, return_date, nights, price, currency, source, kind, observed_at)
    VALUES ($1, current_date + 12, current_date + 19, 7, 1000, 'INR', 'mock', 'sweep', now() - interval '20 days')`, [routeId]);
  [{ id: dealId }] = await db.query(`INSERT INTO deals (route_id, month, price, normal_price, saving_pct, currency, status, published_at, last_verified)
    VALUES ($1, date_trunc('month', current_date + 26)::date, 18000, 30000, 40, 'INR', 'live', now(), now()) RETURNING id`, [routeId]);
  await db.query(`INSERT INTO deal_dates (deal_id, depart, return_date, price, normal_price) VALUES ($1, current_date + 26, current_date + 33, 18000, 30000)`, [dealId]);
  server = await startServer(db, async () => {}, 0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { server.close(); await db.close(); });

/** A tiny browser: keeps cookies, never follows redirects. */
function browser() {
  const jar = new Map<string, string>();
  async function req(path: string, init: { method?: string; form?: Record<string, string | string[]>; headers?: Record<string, string>; body?: string } = {}) {
    let body = init.body;
    const headers: Record<string, string> = { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') };
    if (init.form) {
      const f = new URLSearchParams();
      for (const [k, v] of Object.entries(init.form)) for (const x of [v].flat()) f.append(k, x);
      body = f.toString(); headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(base + path, { method: init.method ?? (body != null ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim(), v = decodeURIComponent(kv.slice(i + 1));
      if (attrs.some(a => /max-age=0/i.test(a.trim())) || v === '') jar.delete(k); else jar.set(k, v);
    }
    return res;
  }
  const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
  return { jar, req, csrfOf };
}
async function lastCode(email: string) {
  const [m] = await db.query(`SELECT subject, body FROM outbox WHERE to_address = $1 ORDER BY id DESC LIMIT 1`, [email]);
  return (m.subject + ' ' + m.body).match(/\b(\d{6})\b/)![1];
}
async function signIn(b: ReturnType<typeof browser>, email: string) {
  const html = await (await b.req('/signin?next=/account')).text();
  const r1 = await b.req('/signin/code-request?next=/account', { form: { csrf: b.csrfOf(html), email } });
  assert.equal(r1.status, 303);
  const codePage = await (await b.req(r1.headers.get('location')!)).text();
  const r2 = await b.req('/signin/code?next=/account', { form: { csrf: b.csrfOf(codePage), email, code: await lastCode(email) } });
  assert.equal(r2.status, 303); assert.equal(r2.headers.get('location'), '/account');
  assert.ok(b.jar.get('fs_session'), 'session cookie set');
}

test('signed-out visitors are sent to sign in', async () => {
  for (const path of ['/account', '/saved', '/watch', '/account/export', `/deal/${dealId}/save`]) {
    const r = await fetch(base + path, { redirect: 'manual' });
    assert.equal(r.status, 303, path);
    assert.equal(r.headers.get('location'), `/signin?next=${encodeURIComponent(path)}`);
  }
  const signin = await (await fetch(base + '/signin')).text();
  assert.match(signin, /Send me a code/);
  assert.match(signin, /href="\/signin"/, 'nav shows Sign in');
});

test('PWA: manifest, service worker, icons, push key', async () => {
  const m = await fetch(base + '/manifest.webmanifest');
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type') ?? '', /manifest\+json/);
  const mj = await m.json() as any;
  assert.equal(mj.display, 'standalone');
  assert.ok(mj.icons.some((i: any) => i.purpose === 'maskable'));
  const sw = await fetch(base + '/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type') ?? '', /javascript/);
  const swText = await sw.text();
  assert.match(swText, /addEventListener\('push'/);
  assert.match(swText, /notificationclick/);
  const icon = await fetch(base + '/static/icon-192.png');
  assert.equal(icon.status, 200); assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/static/nope.png')).status, 404);
  assert.equal((await fetch(base + '/static/..%2fserver.ts')).status, 404);
  assert.ok('key' in (await (await fetch(base + '/push/key')).json() as any));
  const home = await (await fetch(base + '/')).text();
  assert.match(home, /rel="manifest"/);
  assert.match(home, /serviceWorker/);
});

test('route page shows a price calendar, the live deal and a watch button', async () => {
  const r = await fetch(base + '/route/DEL-BKK');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Delhi to Bangkok flights/);
  assert.match(html, /class="cal"/);
  assert.match(html, /lv-deal/, 'the ₹18,000 date is coloured as a deal');
  assert.doesNotMatch(html, /₹1,000|₹1\.0k/, 'old prices are ignored');
  assert.match(html, new RegExp(`/deal/${dealId}`));
  assert.match(html, /\/watch\?origin=DEL&amp;destination=BKK/);
  assert.equal((await fetch(base + '/route/del-bkk', { redirect: 'manual' })).status, 301);
  assert.equal((await fetch(base + '/route/DEL-XXX')).status, 404);
});

test('explore lists destinations with prices and filters by budget and region', async () => {
  const all = await (await fetch(base + '/explore?from=DEL')).text();
  assert.match(all, /Explore from Delhi/);
  assert.match(all, /href="\/route\/DEL-BKK"/);
  assert.match(all, /Live deal · 40% below normal/);
  const cheap = await (await fetch(base + '/explore?from=DEL&max=20000&region=seAsia')).text();
  assert.match(cheap, /\/route\/DEL-BKK/);
  const europe = await (await fetch(base + '/explore?from=DEL&max=20000&region=europe')).text();
  assert.doesNotMatch(europe, /\/route\/DEL-BKK/);
  assert.match(europe, /Nothing under/);
});

test('unsubscribe: invalid token is rejected', async () => {
  assert.equal((await fetch(base + '/unsubscribe?t=bogus')).status, 400);
  assert.equal((await fetch(base + '/unsubscribe')).status, 400);
});

test('forms without a CSRF token are refused', async () => {
  const b = browser();
  await b.req('/signin');
  const r = await b.req('/signin/code-request', { form: { email: 'x@example.com' } });
  assert.equal(r.status, 403);
});

test('sign in with a code, manage the account, save a deal, watch a route, export, unsubscribe, delete', async () => {
  const b = browser();
  await signIn(b, 'asha@example.com');
  let html = await (await b.req('/account')).text();
  assert.match(html, /asha@example\.com/);
  const csrf = b.csrfOf(html);

  let r = await b.req('/account/profile', { form: { csrf, name: 'Asha <b>K</b>', phone: '98123 45678', home_airport: 'BOM', locale: 'en', marketing_consent: '1' } });
  assert.equal(r.status, 303);
  const [u] = await db.query(`SELECT * FROM users WHERE email = 'asha@example.com'`);
  assert.equal(u.phone, '+919812345678'); assert.equal(u.home_airport, 'BOM'); assert.equal(u.marketing_consent, true);
  html = await (await b.req('/account')).text();
  assert.match(html, /Asha &lt;b&gt;K&lt;\/b&gt;/, 'user content is escaped');
  assert.match(html, /Profile saved/);

  r = await b.req(`/deal/${dealId}/save`, { form: { csrf } });
  assert.equal(r.status, 303);
  assert.match(await (await b.req('/saved')).text(), /Delhi → Bangkok/);

  assert.match(await (await b.req('/watch?origin=DEL&destination=BKK')).text(), /<option value="BKK" selected>/);
  r = await b.req('/watch', { form: { csrf, origin: 'DEL', destination: 'BKK', max_price: '20000' } });
  assert.equal(r.status, 303);
  const [w] = await db.query(`SELECT * FROM route_watches WHERE user_id = $1`, [u.id]);
  assert.equal(w.route_id, routeId);

  r = await b.req('/account/alert', { form: { csrf, origin: 'DEL', pct: '35', active: '1' } });
  assert.equal(r.status, 303);
  const [al] = await db.query(`SELECT * FROM alert_subscriptions WHERE user_id = $1`, [u.id]);
  assert.equal(al.min_saving_pct, 35);

  const ex = await b.req('/account/export');
  assert.equal(ex.status, 200);
  assert.match(ex.headers.get('content-disposition') ?? '', /attachment/);
  assert.match(await ex.text(), /asha@example\.com/);

  // Unsubscribe the email channel with a signed link
  const [ch] = await db.query(`SELECT id FROM notification_channels WHERE user_id = $1 AND kind = 'email'`, [u.id]);
  const t = unsubscribeToken(u.id, ch.id);
  assert.match(await (await fetch(`${base}/unsubscribe?t=${encodeURIComponent(t)}`)).text(), /Stop these messages/);
  r = await fetch(`${base}/unsubscribe`, { method: 'POST', body: new URLSearchParams({ t }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 200);
  const [ch2] = await db.query(`SELECT active FROM notification_channels WHERE id = $1`, [ch.id]);
  assert.equal(ch2.active, false);

  r = await b.req('/account/delete', { form: { csrf, confirm: 'nope' } });
  assert.equal(r.status, 303);
  assert.equal((await db.query(`SELECT status FROM users WHERE id = $1`, [u.id]))[0].status, 'active');
  r = await b.req('/account/delete', { form: { csrf, confirm: 'DELETE' } });
  assert.equal(r.status, 200);
  assert.equal((await db.query(`SELECT status FROM users WHERE id = $1`, [u.id]))[0].status, 'deleted');
  assert.equal((await b.req('/account')).status, 303, 'signed out after deletion');
});

test('a signed-out visitor sets up alerts, confirms by code, and the choices are saved', async () => {
  const b = browser();
  const html = await (await b.req('/alerts')).text();
  assert.match(html, /Never miss a real deal/);
  const r1 = await b.req('/alerts', { form: { csrf: b.csrfOf(html), origin: ['DEL', 'BLR'], ch_email: '1', email_freq: 'daily', ch_telegram: '1', ch_push: '1', ch_whatsapp: '1', phone: '+91 99999 00000', pct: '50', email: 'ravi@example.com' } });
  assert.equal(r1.status, 303);
  assert.match(r1.headers.get('location')!, /^\/signin\/code\?email=ravi%40example\.com/);
  const codePage = await (await b.req(r1.headers.get('location')!)).text();
  const r2 = await b.req('/signin/code?next=%2Falerts%2Fdone', { form: { csrf: b.csrfOf(codePage), email: 'ravi@example.com', code: await lastCode('ravi@example.com') } });
  assert.equal(r2.status, 303); assert.equal(r2.headers.get('location'), '/alerts/done');
  const done = await (await b.req('/alerts/done')).text();
  assert.match(done, /Your alerts are on/);
  assert.match(done, /Connect Telegram/);
  assert.match(done, /data-push/);
  const alerts = await db.query(`SELECT a.origin, a.min_saving_pct FROM alert_subscriptions a JOIN users u ON u.id = a.user_id WHERE u.email = 'ravi@example.com' ORDER BY origin`);
  assert.deepEqual(alerts.map(a => [a.origin, a.min_saving_pct]), [['BLR', 50], ['DEL', 50]]);
  const chans = await db.query(`SELECT c.kind, c.address, c.frequency FROM notification_channels c JOIN users u ON u.id = c.user_id WHERE u.email = 'ravi@example.com' ORDER BY kind`);
  assert.deepEqual(chans.map(c => [c.kind, c.frequency]), [['email', 'daily'], ['whatsapp', 'instant']]);
  assert.equal(chans[1].address, '+919999900000');
  assert.equal(b.jar.has('fs_pending'), false, 'pending choices cleared');
});

test('password sign-up, sign-out and sign-in', async () => {
  const b = browser();
  let html = await (await b.req('/signup')).text();
  let r = await b.req('/signup?next=/saved', { form: { csrf: b.csrfOf(html), email: 'pw@example.com', password: 'correct horse 1', name: 'Pat' } });
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/saved');
  html = await (await b.req('/account')).text();
  assert.match(html, /Change password/);
  r = await b.req('/signout', { form: { csrf: b.csrfOf(html) } });
  assert.equal(r.status, 303);
  assert.equal((await b.req('/account')).status, 303);
  html = await (await b.req('/signin?tab=password')).text();
  r = await b.req('/signin/password', { form: { csrf: b.csrfOf(html), email: 'pw@example.com', password: 'wrong password' } });
  assert.match(r.headers.get('location')!, /^\/signin\?tab=password/);
  r = await b.req('/signin/password', { form: { csrf: b.csrfOf(html), email: 'pw@example.com', password: 'correct horse 1' } });
  assert.equal(r.headers.get('location'), '/account');
});
