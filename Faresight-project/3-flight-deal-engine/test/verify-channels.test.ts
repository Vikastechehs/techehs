// Confirmed channels only: email and WhatsApp channels get alerts only after the person confirms them (code or email link).
// Run: node --test test/verify-channels.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb, migrate, type Db } from '../src/db.ts';
import { seed } from '../src/routes.ts';
import { config } from '../src/config.ts';
import { startServer } from '../src/web/server.ts';
import { onDealLive, onDealEnded } from '../src/notify/fanout.ts';
import { onHotelDealLive } from '../src/notify/hotels.ts';
import { sendDailyDigests } from '../src/notify/digest.ts';
import {
  addChannel, confirmChannel, confirmChannelByLink, registerWithPassword, startChannelVerification, updateProfile, UserError,
  CHANNEL_CODES_PER_HOUR, CHANNEL_CODE_MAX_ATTEMPTS,
} from '../src/users/service.ts';

let db: Db, server: Server, base = '';
before(async () => {
  db = await openDb({ memory: true }); await migrate(db); await seed(db);
  await db.query(`INSERT INTO hotel_cities (code, name, country, region, query, active) VALUES ('ZVC', 'Verifycity', 'TH', 'seAsia', 'Verifycity, TH', true)
    ON CONFLICT (code) DO NOTHING`);
  server = await startServer(db, async () => {}, 0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { server.close(); await db.close(); });

const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
let n = 0;
async function makeUser(email_verified = true) {
  const [u] = await db.query(`INSERT INTO users (email, email_verified_at) VALUES ($1, ${email_verified ? 'now()' : 'NULL'}) RETURNING id, email`, [`v${++n}@example.com`]);
  return { id: u.id as number, email: u.email as string };
}
async function channel(userId: number, kind: string, address: string, verified: boolean, frequency = 'instant') {
  const [c] = await db.query(`INSERT INTO notification_channels (user_id, kind, address, frequency, verified_at) VALUES ($1,$2,$3,$4, ${verified ? 'now()' : 'NULL'}) RETURNING id`,
    [userId, kind, address, frequency]);
  return c.id as number;
}
let month = 0;
async function makeDeal(origin = 'DEL', dest = 'BKK') {
  const [r] = await db.query(`SELECT id FROM routes WHERE origin = $1 AND destination = $2`, [origin, dest]);
  const [d] = await db.query(`INSERT INTO deals (route_id, month, price, normal_price, saving_pct, currency, status, published_at, last_verified)
    VALUES ($1, (date_trunc('month', current_date) + make_interval(months => $2))::date, 18000, 30000, 40, 'INR', 'live', now(), now()) RETURNING id`, [r.id, 2 + month++]);
  for (const k of [40, 42, 44]) await db.query(`INSERT INTO deal_dates (deal_id, depart, return_date, price, normal_price) VALUES ($1,$2,$3,18000,30000)`, [d.id, future(k), future(k + 7)]);
  return d.id as number;
}
async function makeHotelDeal() {
  const [h] = await db.query(`INSERT INTO hotels (city, source, source_id, name, stars) VALUES ('ZVC', 'mock', $1, 'Verify Inn', 4) RETURNING id`, [`vh${++n}`]);
  const [d] = await db.query(`INSERT INTO hotel_deals (hotel_id, month, per_night, normal_per_night, saving_pct, currency, status, published_at)
    VALUES ($1, date_trunc('month', current_date + 40)::date, 3000, 5000, 40, 'INR', 'live', now()) RETURNING id`, [h.id]);
  for (const k of [40, 41, 43]) await db.query(`INSERT INTO hotel_deal_dates (hotel_deal_id, checkin, nights, per_night, total, normal_per_night) VALUES ($1,$2,3,3000,9000,5000)`, [d.id, future(k)]);
  return d.id as number;
}
const told = async (col: 'deal_id' | 'hotel_deal_id', id: number, kind: string) =>
  (await db.query(`SELECT channel_id FROM notifications WHERE ${col} = $1 AND kind = $2 ORDER BY channel_id`, [id, kind])).map(r => r.channel_id);
/** The latest code sent to a channel (WhatsApp: template param; email: in the body). */
async function codeFor(channelId: number) {
  const [m] = await db.query(`SELECT body, meta FROM outbox WHERE (meta ->> 'channel_id')::int = $1 AND meta ->> 'purpose' = 'verify' ORDER BY id DESC LIMIT 1`, [channelId]);
  return (m.meta?.params?.[0] ?? m.body.match(/\b(\d{6})\b/)[1]) as string;
}
const sends = async (channelId: number) =>
  (await db.query(`SELECT * FROM outbox WHERE (meta ->> 'channel_id')::int = $1 AND meta ->> 'purpose' = 'verify' ORDER BY id`, [channelId]));
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

test('unverified email and WhatsApp channels get no alerts (flights, route watches, hotels, deal ended)', async () => {
  const u = await makeUser();
  const okMail = await channel(u.id, 'email', u.email, true);
  const badMail = await channel(u.id, 'email', 'other@example.com', false);
  const badWa = await channel(u.id, 'whatsapp', '+919800000001', false);
  const okTg = await channel(u.id, 'telegram', '42424242', true);
  await db.query(`INSERT INTO alert_subscriptions (user_id, origin) VALUES ($1, 'DEL')`, [u.id]);
  const dealId = await makeDeal();
  assert.deepEqual((await onDealLive(db, dealId)).instant, 2);
  assert.deepEqual(await told('deal_id', dealId, 'deal_live'), [okMail, okTg]);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM outbox WHERE meta ->> 'kind' = 'deal_live' AND to_address IN ('other@example.com', '+919800000001')`))[0].n, 0);

  // Route watch
  const w = await makeUser();
  const wMail = await channel(w.id, 'email', w.email, false);
  const [r] = await db.query(`SELECT id FROM routes WHERE origin = 'BOM' AND destination = 'DXB'`);
  await db.query(`INSERT INTO route_watches (user_id, route_id) VALUES ($1,$2)`, [w.id, r.id]);
  const watched = await makeDeal('BOM', 'DXB');
  await onDealLive(db, watched);
  assert.deepEqual(await told('deal_id', watched, 'route_watch'), []);
  await db.query(`UPDATE notification_channels SET verified_at = now() WHERE id = $1`, [wMail]);
  await db.query(`UPDATE deals SET status = 'live' WHERE id = $1`, [watched]);
  await onDealLive(db, watched);
  assert.deepEqual(await told('deal_id', watched, 'route_watch'), [wMail]);

  // Deal ended: saved by the user, still only the confirmed channels
  await db.query(`INSERT INTO saved_deals (user_id, deal_id) VALUES ($1,$2)`, [u.id, dealId]);
  await db.query(`UPDATE deals SET status = 'expired', expired_at = now() WHERE id = $1`, [dealId]);
  await onDealEnded(db, dealId);
  const ended = await told('deal_id', dealId, 'deal_ended');
  assert.ok(!ended.includes(badMail) && !ended.includes(badWa));
  assert.deepEqual(ended, [okMail, okTg]);

  // Hotels
  await db.query(`INSERT INTO hotel_alert_subscriptions (user_id, city) VALUES ($1, 'ZVC')`, [u.id]);
  const hd = await makeHotelDeal();
  await onHotelDealLive(db, hd);
  assert.deepEqual(await told('hotel_deal_id', hd, 'hotel_live'), [okMail, okTg]);
});

test('WhatsApp: adding the channel sends a code through the code template; wrong tries, expiry and the hourly limit', async () => {
  const u = await makeUser();
  const c = await addChannel(db, u.id, { kind: 'whatsapp', address: '+91 98000 00002' });
  assert.equal(c.verified_at, null);
  const [m] = await sends(c.id);
  assert.equal(m.channel, 'whatsapp'); assert.equal(m.to_address, '+919800000002');
  assert.equal(m.meta.template, 'code'); assert.equal(m.meta.purpose, 'verify'); assert.equal(m.meta.channel_id, c.id);
  assert.match(m.meta.params[0], /^\d{6}$/);
  assert.equal(m.body, `Your ${config.siteName} code: ${m.meta.params[0]}`);

  // Re-adding right away does not send a second code
  await addChannel(db, u.id, { kind: 'whatsapp', address: '+919800000002' });
  assert.equal((await sends(c.id)).length, 1);

  // Wrong code, then the right one; another user can't confirm it
  const code = await codeFor(c.id);
  assert.equal(await confirmChannel(db, u.id, c.id, wrong(code)), null);
  const other = await makeUser();
  await assert.rejects(confirmChannel(db, other.id, c.id, code), (e: any) => e instanceof UserError && e.status === 404);
  const ok = await confirmChannel(db, u.id, c.id, code);
  assert.ok(ok?.verified_at); assert.equal(ok?.id, c.id); assert.equal((ok as any).user_id, undefined);
  // Already confirmed: nothing more is sent
  assert.deepEqual(await startChannelVerification(db, u.id, c.id), { sent: false, verified: true });

  // Too many wrong tries
  const c2 = await addChannel(db, u.id, { kind: 'whatsapp', address: '+919800000003' });
  const code2 = await codeFor(c2.id);
  for (let i = 0; i < CHANNEL_CODE_MAX_ATTEMPTS; i++) assert.equal(await confirmChannel(db, u.id, c2.id, wrong(code2)), null);
  await assert.rejects(confirmChannel(db, u.id, c2.id, code2), (e: any) => e instanceof UserError && e.status === 429);

  // Expired code
  await startChannelVerification(db, u.id, c2.id);
  const code3 = await codeFor(c2.id);
  await db.query(`UPDATE channel_verifications SET expires_at = now() - interval '1 second' WHERE channel_id = $1`, [c2.id]);
  assert.equal(await confirmChannel(db, u.id, c2.id, code3), null);
  const [row] = await db.query(`SELECT verified_at FROM notification_channels WHERE id = $1`, [c2.id]);
  assert.equal(row.verified_at, null);

  // A new code replaces the old one
  await startChannelVerification(db, u.id, c2.id);
  const old = await codeFor(c2.id);
  await startChannelVerification(db, u.id, c2.id);
  const fresh = await codeFor(c2.id);
  if (old !== fresh) assert.equal(await confirmChannel(db, u.id, c2.id, old), null);

  // At most 5 sends per channel per hour
  assert.equal((await sends(c2.id)).length, CHANNEL_CODES_PER_HOUR);
  await assert.rejects(startChannelVerification(db, u.id, c2.id), (e: any) => e instanceof UserError && e.status === 429);
  assert.ok(await confirmChannel(db, u.id, c2.id, fresh));

  // Telegram and push are confirmed by connecting, not by code
  const tg = await channel(u.id, 'telegram', '777000', false);
  await assert.rejects(startChannelVerification(db, u.id, tg), UserError);
});

test('password registration emails a confirmation code and one-tap link; the link confirms without signing in', async () => {
  const { user } = await registerWithPassword(db, { email: 'Reg@Example.com', password: 'password123' });
  const [ch] = await db.query(`SELECT id, verified_at FROM notification_channels WHERE user_id = $1 AND kind = 'email'`, [user.id]);
  assert.equal(ch.verified_at, null);
  const [m] = await sends(ch.id);
  assert.equal(m.channel, 'email'); assert.equal(m.to_address, 'reg@example.com');
  assert.equal(m.subject, 'Confirm your email for alerts');
  assert.match(m.body, /\b\d{6}\b/);
  const link = m.body.match(/(\S+\/confirm\?c=(\d+)&t=([\w-]+))/);
  assert.ok(link, m.body);
  assert.ok(link[1].startsWith(`${config.publicUrl}/confirm?c=${ch.id}&t=`));
  // The token is stored hashed, never in plain
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM channel_verifications WHERE code_hash LIKE '%' || $1 || '%'`, [link[3]]))[0].n, 0);

  assert.equal(await confirmChannelByLink(db, ch.id, link[3] + 'x'), false);
  assert.equal(await confirmChannelByLink(db, ch.id + 1000, link[3]), false);
  const bad = await fetch(`${base}/confirm?c=${ch.id}&t=nope`);
  assert.equal(bad.status, 400); assert.match(await bad.text(), /expired/);

  const page = await fetch(`${base}/confirm?c=${ch.id}&t=${link[3]}`);   // no cookie: no sign-in needed
  assert.equal(page.status, 200); assert.match(await page.text(), /Email confirmed/);
  const [after] = await db.query(`SELECT verified_at FROM notification_channels WHERE id = $1`, [ch.id]);
  assert.ok(after.verified_at);
  const [u] = await db.query(`SELECT email_verified_at FROM users WHERE id = $1`, [user.id]);
  assert.ok(u.email_verified_at, 'confirming the sign-in email verifies the account email');
  assert.equal(await confirmChannelByLink(db, ch.id, link[3]), true, 'tapping twice is fine');
});

test('email channels: the verified sign-in email is confirmed at once, another address gets a code', async () => {
  const u = await makeUser(true);
  const same = await addChannel(db, u.id, { kind: 'email', address: u.email.toUpperCase() });
  assert.ok(same.verified_at);
  assert.equal((await sends(same.id)).length, 0);
  const other = await addChannel(db, u.id, { kind: 'email', address: 'work@example.com' });
  assert.equal(other.verified_at, null);
  const [m] = await sends(other.id);
  assert.equal(m.to_address, 'work@example.com');
  assert.ok(await confirmChannel(db, u.id, other.id, await codeFor(other.id)));
  // An unverified account email is not confirmed automatically
  const v = await makeUser(false);
  const c = await addChannel(db, v.id, { kind: 'email', address: v.email });
  assert.equal(c.verified_at, null);
  assert.equal((await sends(c.id)).length, 1);
});

test('changing the phone number starts WhatsApp confirmation', async () => {
  const u = await makeUser();
  const oldWa = await channel(u.id, 'whatsapp', '+919800000010', true, 'daily');
  await updateProfile(db, u.id, { phone: '+91 98000 00011' });
  const [nw] = await db.query(`SELECT id, frequency, verified_at FROM notification_channels WHERE user_id = $1 AND kind = 'whatsapp' AND address = '+919800000011'`, [u.id]);
  assert.ok(nw, 'a WhatsApp channel for the new number');
  assert.equal(nw.verified_at, null); assert.equal(nw.frequency, 'daily');
  const [m] = await sends(nw.id);
  assert.equal(m.meta.template, 'code'); assert.equal(m.to_address, '+919800000011');
  assert.ok((await db.query(`SELECT verified_at FROM notification_channels WHERE id = $1`, [oldWa]))[0].verified_at, 'the old number stays until removed');

  // Number of an existing unconfirmed WhatsApp channel: a code is sent to it
  const v = await makeUser();
  const wa = await channel(v.id, 'whatsapp', '+919800000012', false);
  await updateProfile(db, v.id, { phone: '+919800000012' });
  assert.equal((await sends(wa.id)).length, 1);
  // Saving the profile again with the same number sends nothing
  await updateProfile(db, v.id, { phone: '+919800000012', name: 'V' });
  assert.equal((await sends(wa.id)).length, 1);
});

test('daily digest skips unconfirmed channels', async () => {
  const u = await makeUser();
  const ok = await channel(u.id, 'email', u.email, true, 'daily');
  const bad = await channel(u.id, 'whatsapp', '+919800000020', false, 'daily');
  const dealId = await makeDeal('BLR', 'SIN');
  // A notice queued on the unconfirmed channel (e.g. from before confirmation was required)
  for (const c of [ok, bad]) await db.query(`INSERT INTO notifications (user_id, deal_id, channel_id, kind) VALUES ($1,$2,$3,'deal_live')`, [u.id, dealId, c]);
  await db.query(`DELETE FROM settings WHERE key = 'last_digest_date'`);
  assert.equal(await sendDailyDigests(db, { now: new Date(), hour: 0 }), 1);
  const digests = await db.query(`SELECT to_address FROM outbox WHERE meta ->> 'kind' = 'digest' AND (meta ->> 'user_id')::int = $1`, [u.id]);
  assert.deepEqual(digests.map(d => d.to_address), [u.email]);
});

// --- API and pages ---
async function api(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(`${base}/api/v1/${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() as any };
}
async function appSignIn(email: string) {
  await fetch(`${base}/api/v1/auth/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  const [m] = await db.query(`SELECT body FROM outbox WHERE to_address = $1 ORDER BY id DESC LIMIT 1`, [email]);
  const r = await fetch(`${base}/api/v1/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code: m.body.match(/\b(\d{6})\b/)[1], client: 'app' }) });
  return (await r.json() as any).token as string;
}

test('API: POST me/channels/:id/verify sends a code, POST me/channels/:id/confirm checks it', async () => {
  const t = await appSignIn('apiv@example.com');
  const add = await api('POST', 'me/channels', t, { kind: 'whatsapp', address: '+919800000030' });
  assert.equal(add.status, 201); assert.equal(add.data.channel.verified_at, null);
  const id = add.data.channel.id;
  const v = await api('POST', `me/channels/${id}/verify`, t);
  assert.equal(v.status, 200); assert.deepEqual(v.data, { sent: true, verified: false });
  const code = await codeFor(id);
  const bad = await api('POST', `me/channels/${id}/confirm`, t, { code: wrong(code) });
  assert.equal(bad.status, 400);
  const ok = await api('POST', `me/channels/${id}/confirm`, t, { code });
  assert.equal(ok.status, 200); assert.ok(ok.data.channel.verified_at);
  assert.equal((await api('POST', `me/channels/999999/verify`, t)).status, 404);
  const list = await api('GET', 'me/channels', t);
  assert.ok(list.data.channels.every((c: any) => c.verified_at));
});

function browser() {
  const jar = new Map<string, string>();
  async function req(path: string, form?: Record<string, string>) {
    const headers: Record<string, string> = { cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') };
    let body: string | undefined;
    if (form) { body = new URLSearchParams(form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(base + path, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
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

test('pages: /alerts with WhatsApp asks for the code on /alerts/done; /account shows Confirmed / Not confirmed', async () => {
  const b = browser();
  const email = 'webv@example.com';
  let html = await (await b.req('/signin')).text();
  const r1 = await b.req('/signin/code-request?next=/alerts', { csrf: b.csrfOf(html), email });
  assert.equal(r1.status, 303);
  const [m] = await db.query(`SELECT body FROM outbox WHERE to_address = $1 ORDER BY id DESC LIMIT 1`, [email]);
  html = await (await b.req(r1.headers.get('location')!)).text();
  const r2 = await b.req('/signin/code?next=/alerts', { csrf: b.csrfOf(html), email, code: m.body.match(/\b(\d{6})\b/)[1] });
  assert.equal(r2.status, 303);

  html = await (await b.req('/alerts')).text();
  const r3 = await b.req('/alerts', { csrf: b.csrfOf(html), origin: 'DEL', ch_whatsapp: '1', phone: '98000 00040', pct: '25' });
  assert.equal(r3.headers.get('location'), '/alerts/done');
  html = await (await b.req('/alerts/done')).text();
  assert.match(html, /Enter the code we sent to your WhatsApp/);
  assert.match(html, /\+919800000040/);
  const [wa] = await db.query(`SELECT c.id FROM notification_channels c JOIN users u ON u.id = c.user_id WHERE u.email = $1 AND c.kind = 'whatsapp'`, [email]);
  assert.ok(html.includes(`action="/account/channel/${wa.id}/confirm"`) && html.includes(`action="/account/channel/${wa.id}/verify"`));

  // Resend, then a wrong code, then the right one
  const rs = await b.req(`/account/channel/${wa.id}/verify`, { csrf: b.csrfOf(html), back: '/alerts/done' });
  assert.equal(rs.status, 303); assert.equal(rs.headers.get('location'), '/alerts/done');
  assert.equal((await sends(wa.id)).length, 2);
  const code = await codeFor(wa.id);
  const rw = await b.req(`/account/channel/${wa.id}/confirm`, { csrf: b.csrfOf(html), back: '/alerts/done', code: wrong(code) });
  assert.equal(rw.headers.get('location'), '/alerts/done');
  assert.match(await (await b.req('/alerts/done')).text(), /wrong or has expired/);

  html = await (await b.req('/account')).text();
  assert.match(html, /Not confirmed/);
  const rc = await b.req(`/account/channel/${wa.id}/confirm`, { csrf: b.csrfOf(html), back: '//evil.example', code });
  assert.equal(rc.headers.get('location'), '/account#channels');
  html = await (await b.req('/account')).text();
  assert.match(html, /WhatsApp confirmed/);
  assert.doesNotMatch(html, /Not confirmed/);
  assert.match(html, /Confirmed/);
  // CSRF is required
  assert.equal((await b.req(`/account/channel/${wa.id}/verify`, { csrf: 'bad' })).status, 403);
});

test('pages: password sign-up says to check the inbox; /alerts/done shows the email step', async () => {
  const b = browser();
  let html = await (await b.req('/signup?next=/alerts/done')).text();
  const r = await b.req('/signup?next=/alerts/done', { csrf: b.csrfOf(html), email: 'pwv@example.com', password: 'password123' });
  assert.equal(r.status, 303);
  html = await (await b.req('/alerts/done')).text();
  assert.match(html, /Check your inbox/);
  assert.match(html, /pwv@example\.com/);
});
