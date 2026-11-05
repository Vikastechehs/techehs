// WhatsApp: free text inside the 24-hour window, approved templates outside it, codes, Meta errors and the webhook.
// Run: node --test test/whatsapp.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { openDb, migrate, type Db } from '../src/db.ts';
import { seed } from '../src/routes.ts';
import { config } from '../src/config.ts';
import { deliverOutbox } from '../src/notify/deliver.ts';
import { enqueue } from '../src/notify/outbox.ts';
import { buildTemplatePayload, sanitizeParam, TEMPLATES } from '../src/notify/whatsapp.ts';
import { handleWebhooks, handleWhatsAppEvent } from '../src/web/webhooks.ts';

async function freshDb(): Promise<Db> {
  const db = await openDb({ memory: true });
  await migrate(db);
  await seed(db);
  await db.query(`INSERT INTO hotel_cities (code, name, country, region, query) VALUES ('ZWA', 'Testgoa', 'IN', 'india', 'Testgoa, IN') ON CONFLICT DO NOTHING`);
  return db;
}
const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

async function makeDeal(db: Db, status = 'live', reason: string | null = null, dest = 'BKK') {
  const [r] = await db.query(`SELECT id FROM routes WHERE origin = 'DEL' AND destination = $1`, [dest]);
  const [d] = await db.query(`INSERT INTO deals (route_id, month, price, normal_price, saving_pct, currency, status, reason, published_at, last_verified)
    VALUES ($1, date_trunc('month', current_date + 40)::date, 13000, 20000, 35, 'INR', $2, $3, now(), now()) RETURNING id`, [r.id, status, reason]);
  for (const k of [40, 42, 44]) await db.query(`INSERT INTO deal_dates (deal_id, depart, return_date, price, normal_price) VALUES ($1,$2,$3,13000,20000)`, [d.id, future(k), future(k + 7)]);
  return Number(d.id);
}
async function makeHotelDeal(db: Db) {
  const [h] = await db.query(`INSERT INTO hotels (city, source, source_id, name, stars) VALUES ('ZWA', 'mock', 'wa1', 'Sea   View\nResort', 4) RETURNING id`);
  const [d] = await db.query(`INSERT INTO hotel_deals (hotel_id, month, per_night, normal_per_night, saving_pct, currency, status, published_at)
    VALUES ($1, date_trunc('month', current_date + 40)::date, 3200, 4900, 34.7, 'INR', 'live', now()) RETURNING id`, [h.id]);
  await db.query(`INSERT INTO hotel_deal_dates (hotel_deal_id, checkin, nights, per_night, total, normal_per_night) VALUES ($1,$2,3,3200,9600,4900)`, [d.id, future(40)]);
  return Number(d.id);
}
let n = 0;
async function makeChannel(db: Db, phone = '+919812345678', inboundHoursAgo: number | null = null) {
  const [u] = await db.query(`INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`, [`wa${++n}@example.com`]);
  const [c] = await db.query(`INSERT INTO notification_channels (user_id, kind, address, verified_at, last_inbound_at)
    VALUES ($1, 'whatsapp', $2, now(), CASE WHEN $3::float8 IS NULL THEN NULL ELSE now() - make_interval(hours => $3::int) END) RETURNING id`,
    [u.id, phone, inboundHoursAgo]);
  return { userId: Number(u.id), channelId: Number(c.id), phone };
}
const queue = (db: Db, ch: { userId: number; channelId: number; phone: string }, meta: Record<string, unknown>, body = 'Free text body https://x/deal/1', subject = 'Subject') =>
  enqueue(db, { channel: 'whatsapp', to: ch.phone, subject, body, meta: { channel_id: ch.channelId, user_id: ch.userId, ...meta } });

async function withConfig(patch: Partial<typeof config>, fn: () => Promise<void>) {
  const old: any = {}; for (const k of Object.keys(patch)) old[k] = (config as any)[k];
  Object.assign(config, patch);
  try { await fn(); } finally { Object.assign(config, old); }
}
const wa = { whatsappToken: 'wa_tok', whatsappPhoneId: '999', publicUrl: 'https://fs.test', whatsappTemplateLang: 'en',
  whatsappTemplateDeal: 'flight_deal_alert', whatsappTemplateHotel: 'hotel_deal_alert', whatsappTemplateEnded: 'deal_ended',
  whatsappTemplateDigest: 'daily_deals', whatsappTemplateCode: 'verify_code' };

function fakeFetch(status = 200, body: unknown = { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC' }] }) {
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const bodyParams = (p: any) => p.template.components.find((c: any) => c.type === 'body').parameters.map((x: any) => x.text);
const button = (p: any) => p.template.components.find((c: any) => c.type === 'button');

test('inside the 24-hour window a deal alert goes as free text and the wamid is stored', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db);
  const ch = await makeChannel(db, '+919812345678', 2);
  const id = await queue(db, ch, { kind: 'deal_live', deal_id: dealId });
  const { f, calls } = fakeFetch();
  await withConfig(wa, async () => assert.deepEqual(await deliverOutbox(db, { fetchImpl: f }), { sent: 1, logged: 0, retried: 0, failed: 0 }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.type, 'text');
  assert.equal(calls[0].body.text.body, 'Free text body https://x/deal/1');
  const [o] = await db.query(`SELECT status, meta FROM outbox WHERE id = $1`, [id]);
  assert.equal(o.status, 'sent');
  assert.equal(o.meta.wamid, 'wamid.ABC');
  assert.equal(o.meta.wa_mode, 'text');
  await db.close();
});

test('outside the window (or never wrote) alerts use the approved templates', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db);
  const endedId = await makeDeal(db, 'expired', 'price rose to 15500 (shown 13000)');
  const hotelId = await makeHotelDeal(db);
  const old = await makeChannel(db, '+919800000001', 30);
  const never = await makeChannel(db, '+919800000002', null);
  await queue(db, old, { kind: 'deal_live', deal_id: dealId });
  await queue(db, never, { kind: 'hotel_live', hotel_deal_id: hotelId });
  await queue(db, old, { kind: 'deal_ended', deal_id: endedId });
  const { f, calls } = fakeFetch();
  await withConfig(wa, async () => assert.equal((await deliverOutbox(db, { fetchImpl: f })).sent, 3));
  assert.ok(calls.every(c => c.body.type === 'template' && c.body.messaging_product === 'whatsapp'));

  const deal = calls[0].body;
  assert.equal(deal.to, '919800000001');
  assert.equal(deal.template.name, 'flight_deal_alert');
  assert.deepEqual(deal.template.language, { code: 'en' });
  const dp = bodyParams(deal);
  assert.equal(dp.length, TEMPLATES.deal.params.length);
  assert.deepEqual(dp.slice(0, 5), ['Delhi', 'Bangkok', '₹13,000', '₹20,000', '35%']);
  assert.match(dp[5], /\d{4}/);
  assert.deepEqual(button(deal), { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(dealId) }] });

  const hotel = calls[1].body;
  assert.equal(hotel.template.name, 'hotel_deal_alert');
  assert.deepEqual(bodyParams(hotel).slice(0, 6), ['Sea View Resort', '4-star', 'Testgoa', '₹3,200', '₹4,900', '35%']);
  assert.equal(button(hotel).parameters[0].text, String(hotelId));

  const ended = calls[2].body;
  assert.equal(ended.template.name, 'deal_ended');
  assert.deepEqual(bodyParams(ended), ['Delhi → Bangkok flight deal', 'Price rose to ₹15,500.']);
  assert.equal(button(ended).parameters[0].text, `deal/${endedId}`);
  const modes = await db.query(`SELECT meta ->> 'wa_mode' AS m FROM outbox ORDER BY id`);
  assert.ok(modes.every(r => r.m === 'template'));
  await db.close();
});

test('digest outside the window uses the digest template with a count line and the top 3 deals', async () => {
  const db = await freshDb();
  const ch = await makeChannel(db, '+919800000003', null);
  const ids: number[] = [];
  for (const dest of ['BKK', 'DXB', 'SIN', 'PRG']) {
    const d = await makeDeal(db, 'live', null, dest);
    const [nr] = await db.query(`INSERT INTO notifications (user_id, deal_id, channel_id, kind) VALUES ($1,$2,$3,'deal_live') RETURNING id`, [ch.userId, d, ch.channelId]);
    ids.push(Number(nr.id));
  }
  await queue(db, ch, { kind: 'digest', notification_ids: ids }, 'x', '4 flight deals for you today');
  const { f, calls } = fakeFetch();
  await withConfig(wa, async () => { await deliverOutbox(db, { fetchImpl: f }); });
  const p = calls[0].body;
  assert.equal(p.template.name, 'daily_deals');
  const [count, top] = bodyParams(p);
  assert.equal(count, '4 flight deals for you today');
  assert.equal(top.split(' | ').length, 4);
  assert.ok(top.endsWith('+1 more'));
  assert.ok(!/\n/.test(top));
  assert.equal(button(p), undefined);   // static URL button: no parameters sent
  await db.close();
});

test('codes always use the authentication template, even inside the window', async () => {
  const db = await freshDb();
  const ch = await makeChannel(db, '+919800000004', 1);
  await queue(db, ch, { template: 'code', params: ['123456'], purpose: 'verify' }, 'Your code is 123456');
  const { f, calls } = fakeFetch();
  await withConfig(wa, async () => assert.equal((await deliverOutbox(db, { fetchImpl: f })).sent, 1));
  const p = calls[0].body;
  assert.equal(p.type, 'template');
  assert.equal(p.template.name, 'verify_code');
  assert.deepEqual(p.template.components, [
    { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] },
  ]);
  await db.close();
});

test('Meta template errors fail the message at once (no endless retries)', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db);
  const ch = await makeChannel(db, '+919800000005', null);
  const [nr] = await db.query(`INSERT INTO notifications (user_id, deal_id, channel_id, kind) VALUES ($1,$2,$3,'deal_live') RETURNING id`, [ch.userId, dealId, ch.channelId]);
  const id = await queue(db, ch, { kind: 'deal_live', deal_id: dealId, notification_ids: [Number(nr.id)] });
  const { f, calls } = fakeFetch(404, { error: { message: '(#132001) Template name does not exist in the translation', type: 'OAuthException', code: 132001,
    error_data: { messaging_product: 'whatsapp', details: 'template name (flight_deal_alert) does not exist in en' } } });
  await withConfig(wa, async () => assert.deepEqual(await deliverOutbox(db, { fetchImpl: f, retryDelaySec: 0 }), { sent: 0, logged: 0, retried: 0, failed: 1 }));
  const [o] = await db.query(`SELECT status, attempts, error FROM outbox WHERE id = $1`, [id]);
  assert.equal(o.status, 'failed');
  assert.equal(o.attempts, 1);
  assert.match(o.error, /132001/);
  assert.match(o.error, /template not found/);
  const [nn] = await db.query(`SELECT status FROM notifications WHERE id = $1`, [nr.id]);
  assert.equal(nn.status, 'failed');
  // Nothing left to retry
  await withConfig(wa, async () => { await deliverOutbox(db, { fetchImpl: f }); });
  assert.equal(calls.length, 1);
  // A rate limit (130429) is retried
  const id2 = await queue(db, ch, { kind: 'deal_live', deal_id: dealId });
  const rl = fakeFetch(429, { error: { message: 'Rate limit hit', code: 130429 } });
  await withConfig(wa, async () => assert.equal((await deliverOutbox(db, { fetchImpl: rl.f, retryDelaySec: 0 })).retried, 1));
  assert.equal((await db.query(`SELECT status FROM outbox WHERE id = $1`, [id2]))[0].status, 'queued');
  await db.close();
});

test('stale window: a 131047 reply to free text falls back to the template', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db);
  const ch = await makeChannel(db, '+919800000006', 1);
  await queue(db, ch, { kind: 'deal_live', deal_id: dealId });
  const calls: any[] = [];
  const f = (async (_url: any, init: any) => {
    const b = JSON.parse(init.body); calls.push(b);
    return b.type === 'text'
      ? new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }), { status: 400 })
      : new Response(JSON.stringify({ messages: [{ id: 'wamid.T' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  await withConfig(wa, async () => assert.equal((await deliverOutbox(db, { fetchImpl: f })).sent, 1));
  assert.deepEqual(calls.map(c => c.type), ['text', 'template']);
  await db.close();
});

test('template parameters are sanitised (no newlines, tabs or long space runs, never empty)', () => {
  assert.equal(sanitizeParam('a\nb\r\nc\td'), 'a b c d');
  assert.equal(sanitizeParam('x     y'), 'x y');
  assert.equal(sanitizeParam('  '), '-');
  assert.equal(sanitizeParam(null), '-');
  assert.equal(sanitizeParam('a'.repeat(2000)).length, 1000);
  const p = buildTemplatePayload('ended', { to: '+91 98123-45678', params: ['Line\none', 'tab\there      spaces'], button: 'deal/ 7' });
  assert.equal(p.to, '919812345678');
  assert.deepEqual(bodyParams(p), ['Line one', 'tab here spaces']);
  assert.equal(button(p).parameters[0].text, 'deal/7');
  for (const t of bodyParams(p)) assert.ok(!/[\n\t]| {5,}/.test(t));
  assert.throws(() => buildTemplatePayload('deal', { to: '1', params: ['only one'] }), /needs 6 parameters/);
});

// --- Webhook ---
function call(db: Db, method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
  const req: any = Readable.from(opts.body != null ? [Buffer.from(opts.body)] : []);
  req.method = method; req.headers = opts.headers ?? {};
  const out = { status: 0, body: '' };
  const res: any = { writeHead(s: number) { out.status = s; return res; }, end(b?: string) { out.body = String(b ?? ''); } };
  return handleWebhooks({ db, req, res, url: new URL(`http://x${path}`), notify: (async () => {}) as any }).then(handled => ({ handled, ...out }));
}
const sign = (body: string, secret: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
const inbound = (from: string, text: string) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages',
  value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '999' }, messages: [{ from, id: 'wamid.in', timestamp: '1', type: 'text', text: { body: text } }] } }] }] });

test('webhook GET verification echoes the challenge only for the right token', async () => {
  const db = await freshDb();
  await withConfig({ whatsappVerifyToken: 'my-verify' }, async () => {
    const ok = await call(db, 'GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=my-verify&hub.challenge=1158201444');
    assert.deepEqual([ok.status, ok.body], [200, '1158201444']);
    assert.equal((await call(db, 'GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
    assert.equal((await call(db, 'GET', '/webhooks/whatsapp?hub.verify_token=my-verify&hub.challenge=1')).status, 403);
  });
  await withConfig({ whatsappVerifyToken: '' }, async () => {
    assert.equal((await call(db, 'GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).status, 403);
  });
  assert.equal((await call(db, 'GET', '/webhooks/other')).handled, false);
  await db.close();
});

test('webhook POST checks the signature; an inbound message opens the 24-hour window', async () => {
  const db = await freshDb();
  const ch = await makeChannel(db, '+919811112222', null);
  const body = inbound('919811112222', 'hi');
  await withConfig({ whatsappAppSecret: 'app-secret' }, async () => {
    assert.equal((await call(db, 'POST', '/webhooks/whatsapp', { body, headers: { 'x-hub-signature-256': sign(body, 'other') } })).status, 401);
    assert.equal((await call(db, 'POST', '/webhooks/whatsapp', { body })).status, 401);
    let [c] = await db.query(`SELECT last_inbound_at FROM notification_channels WHERE id = $1`, [ch.channelId]);
    assert.equal(c.last_inbound_at, null);
    const ok = await call(db, 'POST', '/webhooks/whatsapp', { body, headers: { 'x-hub-signature-256': sign(body, 'app-secret') } });
    assert.equal(ok.status, 200);
    [c] = await db.query(`SELECT last_inbound_at, active FROM notification_channels WHERE id = $1`, [ch.channelId]);
    assert.ok(c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < 60_000);
    assert.equal(c.active, true);
    // Invalid JSON with a good signature
    assert.equal((await call(db, 'POST', '/webhooks/whatsapp', { body: '{', headers: { 'x-hub-signature-256': sign('{', 'app-secret') } })).status, 400);
  });
  await db.close();
});

test('STOP / BAND switch the WhatsApp channel off, START switches it back on', async () => {
  const db = await freshDb();
  const ch = await makeChannel(db, '+919833334444', null);
  const other = await makeChannel(db, '+919899999999', null);
  const active = async (id: number) => (await db.query(`SELECT active FROM notification_channels WHERE id = $1`, [id]))[0].active;
  await withConfig({ whatsappAppSecret: '' }, async () => {
    assert.equal((await call(db, 'POST', '/webhooks/whatsapp', { body: inbound('919833334444', ' Stop ') })).status, 200);
  });
  assert.equal(await active(ch.channelId), false);
  assert.equal(await active(other.channelId), true);
  assert.equal((await handleWhatsAppEvent(db, JSON.parse(inbound('919833334444', 'start')))).started, 1);
  assert.equal(await active(ch.channelId), true);
  assert.equal((await handleWhatsAppEvent(db, JSON.parse(inbound('919833334444', 'BAND')))).stopped, 1);
  assert.equal(await active(ch.channelId), false);
  assert.equal((await handleWhatsAppEvent(db, JSON.parse(inbound('919833334444', 'UNSUBSCRIBE')))).stopped, 0);   // already off
  // A queued message to a stopped channel is not sent
  await queue(db, ch, { kind: 'deal_live', deal_id: await makeDeal(db) });
  const { f, calls } = fakeFetch();
  await withConfig(wa, async () => assert.equal((await deliverOutbox(db, { fetchImpl: f })).failed, 1));
  assert.equal(calls.length, 0);
  await db.close();
});

test('a failed delivery status marks the outbox row (found by wamid) failed', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db);
  const ch = await makeChannel(db, '+919855556666', 1);
  const [nr] = await db.query(`INSERT INTO notifications (user_id, deal_id, channel_id, kind) VALUES ($1,$2,$3,'deal_live') RETURNING id`, [ch.userId, dealId, ch.channelId]);
  const id = await queue(db, ch, { kind: 'deal_live', deal_id: dealId, notification_ids: [Number(nr.id)] });
  const { f } = fakeFetch(200, { messages: [{ id: 'wamid.OUT1' }] });
  await withConfig(wa, async () => { await deliverOutbox(db, { fetchImpl: f }); });
  const r = await handleWhatsAppEvent(db, { entry: [{ changes: [{ value: { statuses: [
    { id: 'wamid.OUT1', status: 'delivered' },
    { id: 'wamid.OUT1', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] },
  ] } }] }] });
  assert.equal(r.failed, 1);
  const [o] = await db.query(`SELECT status, error FROM outbox WHERE id = $1`, [id]);
  assert.equal(o.status, 'failed');
  assert.match(o.error, /131026\) Message undeliverable/);
  assert.equal((await db.query(`SELECT status FROM notifications WHERE id = $1`, [nr.id]))[0].status, 'failed');
  await db.close();
});
