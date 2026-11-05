// User accounts and the /api/v1 JSON API, on an in-memory database. Run: node --test test/users.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb, migrate, type Db } from '../src/db.ts';
import { seed } from '../src/routes.ts';
import { startServer } from '../src/web/server.ts';
import { hashPassword, verifyPassword } from '../src/users/crypto.ts';
import { UserError, updateProfile, upsertAlert, addChannel, registerWithPassword } from '../src/users/service.ts';

let db: Db, server: Server, base = '';
before(async () => {
  db = await openDb({ memory: true }); await migrate(db); await seed(db);
  server = await startServer(db, async () => {}, 0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { server.close(); await db.close(); });

type Opts = { token?: string; cookie?: string; body?: unknown; origin?: string };
async function call(method: string, path: string, o: Opts = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin) headers.origin = o.origin;
  const r = await fetch(base + '/api/v1/' + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, headers: r.headers, data: await r.json() as any };
}
async function lastCode(email: string) {
  const [m] = await db.query(`SELECT subject, body FROM outbox WHERE to_address = $1 ORDER BY id DESC LIMIT 1`, [email]);
  return m.body.match(/\b(\d{6})\b/)[1] as string;
}
async function signIn(email: string) {
  assert.equal((await call('POST', 'auth/code', { body: { email } })).status, 200);
  const r = await call('POST', 'auth/verify', { body: { email, code: await lastCode(email.trim().toLowerCase()), client: 'app' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token as string;
}
let dealN = 0;
async function makeDeal(status = 'live', price = 20000) {
  const [r] = await db.query(`SELECT id FROM routes WHERE origin = 'DEL' AND destination = 'BKK'`);
  const [d] = await db.query(`INSERT INTO deals (route_id, month, price, normal_price, saving_pct, currency, status)
    VALUES ($1, (date '2027-01-01' + make_interval(months => $4))::date, $2, 30000, 33, 'INR', $3) RETURNING id`, [r.id, price, status, dealN++]);
  return d.id as number;
}

test('password hashing uses scrypt and checks in constant time', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^scrypt\$16384\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong horse', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('code sign-in creates a verified user with an email channel; web gets a cookie', async () => {
  assert.equal((await call('POST', 'auth/code', { body: { email: 'not-an-email' } })).status, 400);
  assert.equal((await call('POST', 'auth/code', { body: { email: '  Asha@Example.COM ' } })).status, 200);
  const [m] = await db.query(`SELECT channel, subject FROM outbox WHERE to_address = 'asha@example.com'`);
  assert.equal(m.channel, 'email');
  assert.match(m.subject, /^Your Faresight sign-in code: \d{6}$/);
  const [lc] = await db.query(`SELECT code_hash FROM login_codes WHERE email = 'asha@example.com'`);
  assert.match(lc.code_hash, /^[0-9a-f]{64}$/);
  const code = await lastCode('asha@example.com');
  const r = await call('POST', 'auth/verify', { body: { email: 'asha@example.com', code } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.email, 'asha@example.com');
  assert.ok(r.data.user.email_verified_at);
  assert.equal(r.data.user.has_password, false);
  const cookie = r.headers.get('set-cookie') ?? '';
  assert.match(cookie, /^fs_session=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);
  // The code works once only, and only its hash is stored for the session
  assert.equal((await call('POST', 'auth/verify', { body: { email: 'asha@example.com', code } })).status, 400);
  const [s] = await db.query(`SELECT id FROM sessions WHERE user_id = $1`, [r.data.user.id]);
  assert.notEqual(s.id, r.data.token);
  // The cookie signs requests in; channels has the verified email
  const me = await call('GET', 'me', { cookie: cookie.split(';')[0] });
  assert.equal(me.data.user.id, r.data.user.id);
  const ch = await call('GET', 'me/channels', { cookie: cookie.split(';')[0] });
  assert.equal(ch.data.channels.length, 1);
  assert.equal(ch.data.channels[0].kind, 'email');
  assert.ok(ch.data.channels[0].verified_at);
  // Signing in again reuses the account
  const token2 = await signIn('asha@example.com');
  assert.equal((await call('GET', 'me', { token: token2 })).data.user.id, r.data.user.id);
  const [ev] = await db.query(`SELECT count(*) FILTER (WHERE kind = 'signup')::int AS signup, count(*) FILTER (WHERE kind = 'login')::int AS login
    FROM user_events WHERE user_id = $1`, [r.data.user.id]);
  assert.deepEqual(ev, { signup: 1, login: 2 });
});

test('wrong codes: 5 tries per code, 5 codes per hour', async () => {
  const email = 'tries@example.com';
  await call('POST', 'auth/code', { body: { email } });
  const code = await lastCode(email);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', 'auth/verify', { body: { email, code: wrong } })).status, 400);
  assert.equal((await call('POST', 'auth/verify', { body: { email, code } })).status, 429, 'locked after 5 wrong tries even with the right code');
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', 'auth/code', { body: { email } })).status, 200);
  const r = await call('POST', 'auth/code', { body: { email } });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /Too many/);
  // An expired code is refused
  await db.query(`UPDATE login_codes SET expires_at = now() - interval '1 second' WHERE email = $1`, [email]);
  assert.equal((await call('POST', 'auth/verify', { body: { email, code: await lastCode(email) } })).status, 400);
});

test('password register, login, change password, logout', async () => {
  assert.equal((await call('POST', 'auth/register', { body: { email: 'pw@example.com', password: 'short' } })).status, 400);
  const reg = await call('POST', 'auth/register', { body: { email: 'PW@example.com', password: 'longenough1', name: 'Pia', client: 'app' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.headers.get('set-cookie'), null, 'app sign-in does not set a cookie');
  assert.equal(reg.data.user.has_password, true);
  assert.equal(reg.data.user.email_verified_at, null);
  assert.equal((await call('POST', 'auth/register', { body: { email: 'pw@example.com', password: 'longenough1' } })).status, 409);
  const [ch] = await db.query(`SELECT kind, verified_at FROM notification_channels WHERE user_id = $1`, [reg.data.user.id]);
  assert.deepEqual(ch, { kind: 'email', verified_at: null });
  const [u] = await db.query(`SELECT password_hash FROM users WHERE id = $1`, [reg.data.user.id]);
  assert.match(u.password_hash, /^scrypt\$/);

  assert.equal((await call('POST', 'auth/login', { body: { email: 'pw@example.com', password: 'wrongpass1' } })).status, 401);
  assert.equal((await call('POST', 'auth/login', { body: { email: 'nobody@example.com', password: 'wrongpass1' } })).status, 401);
  const login = await call('POST', 'auth/login', { body: { email: 'pw@example.com', password: 'longenough1', client: 'app' } });
  assert.equal(login.status, 200);
  const t = login.data.token;

  assert.equal((await call('POST', 'me/password', { token: t, body: { current_password: 'nope', password: 'newpassword2' } })).status, 403);
  assert.equal((await call('POST', 'me/password', { token: t, body: { current_password: 'longenough1', password: 'newpassword2' } })).status, 200);
  assert.equal((await call('POST', 'auth/login', { body: { email: 'pw@example.com', password: 'newpassword2' } })).status, 200);

  assert.equal((await call('POST', 'auth/logout', { token: t })).status, 200);
  assert.equal((await call('GET', 'me', { token: t })).status, 401);
  assert.equal((await call('GET', 'me', { token: reg.data.token })).status, 200);
  assert.equal((await call('POST', 'auth/logout-all', { token: reg.data.token })).status, 200);
  assert.equal((await call('GET', 'me', { token: reg.data.token })).status, 401);
});

test('auth: 401 without a session, Bearer works, disabled and expired sessions are refused, CSRF check', async () => {
  assert.equal((await call('GET', 'me')).status, 401);
  assert.deepEqual((await call('GET', 'me')).data, { error: 'Sign in required' });
  assert.equal((await call('GET', 'me', { token: 'bogus' })).status, 401);
  assert.equal((await call('GET', 'me/alerts')).status, 401);
  const t = await signIn('bearer@example.com');
  const me = await call('GET', 'me', { token: t });
  assert.equal(me.status, 200);
  // Cookie-authenticated writes from another site are refused; Bearer requests are not checked
  const cookie = `fs_session=${t}`;
  assert.equal((await call('PATCH', 'me', { cookie, origin: 'https://evil.example', body: { name: 'X' } })).status, 403);
  assert.equal((await call('PATCH', 'me', { cookie, origin: base, body: { name: 'X' } })).status, 200);
  assert.equal((await call('PATCH', 'me', { token: t, origin: 'https://evil.example', body: { name: 'Y' } })).status, 200);
  // Expired session, then disabled user
  await db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
  assert.equal((await call('GET', 'me', { token: t })).status, 401);
  const t2 = await signIn('bearer@example.com');
  await db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [me.data.user.id]);
  assert.equal((await call('GET', 'me', { token: t2 })).status, 401);
  await call('POST', 'auth/code', { body: { email: 'bearer@example.com' } });
  assert.equal((await call('POST', 'auth/verify', { body: { email: 'bearer@example.com', code: await lastCode('bearer@example.com') } })).status, 403);
});

test('profile update validation', async () => {
  const t = await signIn('profile@example.com');
  const ok = await call('PATCH', 'me', { token: t, body: { name: ' Ravi ', phone: '+91 98123 45678', home_airport: 'del', locale: 'hi', marketing_consent: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.name, 'Ravi');
  assert.equal(ok.data.user.phone, '+919812345678');
  assert.equal(ok.data.user.home_airport, 'DEL');
  assert.equal(ok.data.user.locale, 'hi');
  assert.equal(ok.data.user.marketing_consent, true);
  for (const body of [{ phone: '98123' }, { phone: '9812345678' }, { home_airport: 'XXX' }, { locale: 'fr' }, { marketing_consent: 'yes' }])
    assert.equal((await call('PATCH', 'me', { token: t, body })).status, 400, JSON.stringify(body));
  const cleared = await call('PATCH', 'me', { token: t, body: { phone: null, home_airport: '' } });
  assert.equal(cleared.data.user.phone, null);
  assert.equal(cleared.data.user.home_airport, null);
  const [c] = await db.query(`SELECT count(*)::int AS n FROM user_events WHERE user_id = $1 AND kind = 'consent'`, [ok.data.user.id]);
  assert.equal(c.n, 1);
  await assert.rejects(updateProfile(db, ok.data.user.id, { locale: 'xx' }), UserError);
});

test('alerts, channels, watches and saved deals', async () => {
  const t = await signIn('data@example.com');
  // Alerts
  assert.equal((await call('POST', 'me/alerts', { token: t, body: { origin: 'BKK' } })).status, 400, 'BKK is not an origin');
  assert.equal((await call('POST', 'me/alerts', { token: t, body: { origin: 'DEL', min_saving_pct: 20 } })).status, 400);
  assert.equal((await call('POST', 'me/alerts', { token: t, body: { origin: 'DEL', regions: ['mars'] } })).status, 400);
  const a = await call('POST', 'me/alerts', { token: t, body: { origin: 'del', min_saving_pct: 35, regions: ['europe', 'seAsia'], max_price: 40000 } });
  assert.equal(a.status, 200);
  assert.deepEqual([a.data.alert.origin, a.data.alert.city, a.data.alert.min_saving_pct, a.data.alert.max_price], ['DEL', 'Delhi', 35, 40000]);
  assert.deepEqual(a.data.alert.regions, ['europe', 'seAsia']);
  const a2 = await call('POST', 'me/alerts', { token: t, body: { origin: 'DEL', active: false } });
  assert.equal(a2.data.alert.id, a.data.alert.id, 'upsert keeps one alert per origin');
  assert.equal(a2.data.alert.min_saving_pct, 35, 'fields not sent are kept');
  assert.equal(a2.data.alert.active, false);
  await call('POST', 'me/alerts', { token: t, body: { origin: 'BOM' } });
  assert.equal((await call('GET', 'me/alerts', { token: t })).data.alerts.length, 2);
  assert.equal((await call('DELETE', 'me/alerts/BOM', { token: t })).status, 200);
  assert.deepEqual((await call('GET', 'me/alerts', { token: t })).data.alerts.map((x: any) => x.origin), ['DEL']);

  // Channels
  const bad = [{ kind: 'email', address: 'nope' }, { kind: 'whatsapp', address: '12345' }, { kind: 'telegram', address: '@me' },
    { kind: 'push', address: 'https://push.example/x' }, { kind: 'push', address: 'http://x', meta: { keys: { p256dh: 'a', auth: 'b' } } }, { kind: 'sms', address: '1' }];
  for (const body of bad) assert.equal((await call('POST', 'me/channels', { token: t, body })).status, 400, JSON.stringify(body));
  const wa = await call('POST', 'me/channels', { token: t, body: { kind: 'whatsapp', address: '+91 98123 45678', frequency: 'daily' } });
  assert.equal(wa.status, 201);
  assert.deepEqual([wa.data.channel.address, wa.data.channel.frequency, wa.data.channel.verified_at], ['+919812345678', 'daily', null]);
  const push = await call('POST', 'me/channels', { token: t, body: { kind: 'push', address: 'https://push.example/abc', meta: { keys: { p256dh: 'pk', auth: 'au' } } } });
  assert.ok(push.data.channel.verified_at);
  assert.equal((await call('POST', 'me/channels', { token: t, body: { kind: 'telegram', address: '123456789' } })).status, 201);
  const patched = await call('PATCH', `me/channels/${wa.data.channel.id}`, { token: t, body: { active: false } });
  assert.deepEqual([patched.data.channel.active, patched.data.channel.frequency], [false, 'daily']);
  assert.equal((await call('PATCH', `me/channels/${wa.data.channel.id}`, { token: t, body: { frequency: 'weekly' } })).status, 400);
  assert.equal((await call('DELETE', `me/channels/${push.data.channel.id}`, { token: t })).status, 200);
  assert.equal((await call('DELETE', `me/channels/${push.data.channel.id}`, { token: t })).status, 404);
  assert.equal((await call('GET', 'me/channels', { token: t })).data.channels.length, 3);

  // Watches pick up the cheapest live deal on the route
  assert.equal((await call('POST', 'me/watches', { token: t, body: { origin: 'DEL', destination: 'XYZ' } })).status, 404);
  const live = await makeDeal('live', 21000); await makeDeal('live', 19000);
  const w = await call('POST', 'me/watches', { token: t, body: { origin: 'DEL', destination: 'BKK', max_price: 25000 } });
  assert.equal(w.status, 201);
  assert.deepEqual([w.data.watch.from_city, w.data.watch.to_city, w.data.watch.max_price, w.data.watch.live_price], ['Delhi', 'Bangkok', 25000, 19000]);
  await call('POST', 'me/watches', { token: t, body: { origin: 'BOM', destination: 'DXB' } });
  const ws = (await call('GET', 'me/watches', { token: t })).data.watches;
  assert.equal(ws.length, 2);
  assert.equal(ws.find((x: any) => x.destination === 'DXB').live_deal_id, null);
  assert.equal((await call('DELETE', `me/watches/${w.data.watch.id}`, { token: t })).status, 200);
  assert.equal((await call('GET', 'me/watches', { token: t })).data.watches.length, 1);

  // Saved deals: live and expired only
  const expired = await makeDeal('expired'); const review = await makeDeal('review');
  assert.equal((await call('PUT', `me/saved/${live}`, { token: t })).status, 200);
  assert.equal((await call('PUT', `me/saved/${live}`, { token: t })).status, 200, 'saving twice is fine');
  assert.equal((await call('PUT', `me/saved/${expired}`, { token: t })).status, 200);
  assert.equal((await call('PUT', `me/saved/${review}`, { token: t })).status, 404);
  assert.equal((await call('PUT', `me/saved/999999`, { token: t })).status, 404);
  const saved = (await call('GET', 'me/saved', { token: t })).data.saved;
  assert.deepEqual(saved.map((s: any) => s.deal_id).sort(), [live, expired].sort());
  assert.equal(saved[0].from_city, 'Delhi');
  assert.equal((await call('DELETE', `me/saved/${live}`, { token: t })).status, 200);
  assert.equal((await call('GET', 'me/saved', { token: t })).data.saved.length, 1);
});

test('export and delete account; the email can sign up again', async () => {
  const email = 'gone@example.com';
  const t = await signIn(email);
  await call('PATCH', 'me', { token: t, body: { name: 'Gita', phone: '+919811111111' } });
  await call('POST', 'me/alerts', { token: t, body: { origin: 'BLR' } });
  await call('POST', 'me/watches', { token: t, body: { origin: 'BLR', destination: 'SIN' } });
  await call('PUT', `me/saved/${await makeDeal()}`, { token: t });

  const r = await fetch(base + '/api/v1/me/export', { headers: { authorization: `Bearer ${t}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="faresight-data-\d+\.json"/);
  const x = await r.json() as any;
  assert.equal(x.profile.email, email);
  assert.equal('password_hash' in x.profile, false);
  for (const k of ['alerts', 'channels', 'watches', 'saved', 'sessions', 'user_events']) assert.equal(x[k].length >= 1, true, k);
  for (const k of ['notifications', 'clicks']) assert.ok(Array.isArray(x[k]), k);
  assert.equal('id' in x.sessions[0], false, 'session ids are not exported');
  const id = x.profile.id;

  assert.equal((await call('DELETE', 'me', { token: t, body: {} })).status, 400, 'needs confirm');
  const del = await call('DELETE', 'me', { token: t, body: { confirm: 'DELETE' } });
  assert.equal(del.status, 200);
  assert.equal((await call('GET', 'me', { token: t })).status, 401);
  const [u] = await db.query(`SELECT email, name, phone, password_hash, status, deleted_at FROM users WHERE id = $1`, [id]);
  assert.equal(u.email, `deleted-${id}@deleted.invalid`);
  assert.deepEqual([u.name, u.phone, u.password_hash, u.status], [null, null, null, 'deleted']);
  assert.ok(u.deleted_at);
  for (const tbl of ['sessions', 'alert_subscriptions', 'notification_channels', 'route_watches', 'saved_deals']) {
    const [c] = await db.query(`SELECT count(*)::int AS n FROM ${tbl} WHERE user_id = $1`, [id]);
    assert.equal(c.n, 0, tbl);
  }
  const [lc] = await db.query(`SELECT count(*)::int AS n FROM login_codes WHERE email = $1`, [email]);
  assert.equal(lc.n, 0);
  const [ev] = await db.query(`SELECT count(*)::int AS n FROM user_events WHERE user_id = $1 AND kind IN ('export','delete')`, [id]);
  assert.equal(ev.n, 2);

  const again = await registerWithPassword(db, { email, password: 'brandnew99' });
  assert.notEqual(again.user.id, id);
  assert.equal(again.user.status, 'active');
});

test('public airports and routes lists', async () => {
  const a = await call('GET', 'airports');
  assert.equal(a.status, 200);
  const del = a.data.airports.find((x: any) => x.iata === 'DEL');
  assert.deepEqual(del, { iata: 'DEL', city: 'Delhi', country: 'IN', is_origin: true });
  assert.equal(a.data.airports.find((x: any) => x.iata === 'BKK').is_origin, false);
  const r = await call('GET', 'routes?from=del');
  assert.equal(r.data.routes.length, 40);
  assert.ok(r.data.routes.every((x: any) => x.origin === 'DEL' && x.from_city === 'Delhi' && x.to_city));
  assert.equal((await call('GET', 'routes')).data.routes.length, 300);
});

test('service validation errors are UserErrors', async () => {
  const { user } = await registerWithPassword(db, { email: 'svc@example.com', password: 'password123' });
  await assert.rejects(upsertAlert(db, user.id, { origin: 'DEL', min_saving_pct: 95 }), UserError);
  await assert.rejects(addChannel(db, user.id, { kind: 'telegram', address: 'abc' }), UserError);
});
