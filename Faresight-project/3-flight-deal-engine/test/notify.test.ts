// Per-user notifications: matching, fan-out, deal endings, unsubscribe tokens, delivery and digests. Run: node --test test/notify.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, type Db } from '../src/db.ts';
import { seed } from '../src/routes.ts';
import { config } from '../src/config.ts';
import { onDealLive, onDealEnded } from '../src/notify/fanout.ts';
import { deliverOutbox, MAX_ATTEMPTS } from '../src/notify/deliver.ts';
import { sendDailyDigests } from '../src/notify/digest.ts';
import { unsubscribeToken, verifyUnsubscribeToken } from '../src/notify/unsubscribe.ts';
import { telegramConnectLink, handleTelegramUpdate } from '../src/notify/telegram.ts';
import { regionOf } from '../src/notify/regions.ts';
import { renderNotice } from '../src/notify/render.ts';
import { dealSummary } from '../src/engine/notify.ts';
import { enqueue, forgetAddress } from '../src/notify/outbox.ts';

async function freshDb(): Promise<Db> {
  const db = await openDb({ memory: true });
  await migrate(db);
  await seed(db);
  return db;
}

const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

async function makeDeal(db: Db, origin: string, dest: string, price: number, normal: number, status = 'live') {
  const [r] = await db.query(`SELECT id FROM routes WHERE origin = $1 AND destination = $2`, [origin, dest]);
  const saving = Math.round((1 - price / normal) * 1000) / 10;
  const [d] = await db.query(`INSERT INTO deals (route_id, month, price, normal_price, saving_pct, currency, status, published_at, last_verified)
    VALUES ($1, date_trunc('month', current_date + 40)::date, $2, $3, $4, 'INR', $5, now(), now()) RETURNING id`, [r.id, price, normal, saving, status]);
  for (const k of [40, 42, 44]) {
    await db.query(`INSERT INTO deal_dates (deal_id, depart, return_date, price, normal_price) VALUES ($1,$2,$3,$4,$5)`,
      [d.id, future(k), future(k + 7), price, normal]);
  }
  return d.id as number;
}

let emails = 0;
async function makeUser(db: Db, opts: { status?: string; channels?: { kind: string; address?: string; frequency?: string; meta?: unknown }[] } = {}) {
  const [u] = await db.query(`INSERT INTO users (email, status) VALUES ($1, $2) RETURNING id`, [`u${++emails}@example.com`, opts.status ?? 'active']);
  const channels: number[] = [];
  for (const c of opts.channels ?? [{ kind: 'email' }]) {
    const address = c.address ?? (c.kind === 'email' ? `u${emails}@example.com` : c.kind === 'telegram' ? `${1000 + emails}` : c.kind === 'whatsapp' ? '+919812345678' : `https://push.example/${emails}`);
    const [ch] = await db.query(`INSERT INTO notification_channels (user_id, kind, address, frequency, meta, verified_at) VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
      [u.id, c.kind, address, c.frequency ?? 'instant', c.meta == null ? null : JSON.stringify(c.meta)]);
    channels.push(ch.id);
  }
  return { id: u.id as number, channels };
}
const alert = (db: Db, userId: number, origin: string, a: { min?: number; max?: number | null; regions?: string[] | null } = {}) =>
  db.query(`INSERT INTO alert_subscriptions (user_id, origin, min_saving_pct, max_price, regions) VALUES ($1,$2,$3,$4,$5)`,
    [userId, origin, a.min ?? 25, a.max ?? null, a.regions ?? null]);
const notified = async (db: Db, dealId: number, kind = 'deal_live') =>
  (await db.query(`SELECT user_id FROM notifications WHERE deal_id = $1 AND kind = $2 ORDER BY user_id`, [dealId, kind])).map(r => r.user_id);

/** Temporarily set config keys (providers) for one test. */
async function withConfig(patch: Partial<typeof config>, fn: () => Promise<void>) {
  const old: any = {}; for (const k of Object.keys(patch)) old[k] = (config as any)[k];
  Object.assign(config, patch);
  try { await fn(); } finally { Object.assign(config, old); }
}
const noProviders = { resendApiKey: '', telegramToken: '', whatsappToken: '', whatsappPhoneId: '', vapidPublicKey: '', vapidPrivateKey: '' };

function fakeFetch(status = 200, body: unknown = { ok: true }) {
  const calls: { url: string; init: any; body: any }[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test('regionOf maps destinations to alert regions', () => {
  assert.equal(regionOf('BKK'), 'seAsia');
  assert.equal(regionOf('PRG'), 'europe');
  assert.equal(regionOf('DXB'), 'saGulf');
  assert.equal(regionOf('SYD'), 'longHaul');
  assert.equal(regionOf('XXX'), null);
});

test('deal live: alerts match origin, minimum saving, budget and region; route watches; no duplicates', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db, 'DEL', 'BKK', 13000, 20000); // 35% below, seAsia
  const match = await makeUser(db); await alert(db, match.id, 'DEL');
  const otherOrigin = await makeUser(db); await alert(db, otherOrigin.id, 'BOM');
  const tooGreedy = await makeUser(db); await alert(db, tooGreedy.id, 'DEL', { min: 40 });
  const budgetOk = await makeUser(db); await alert(db, budgetOk.id, 'DEL', { max: 13000 });
  const budgetLow = await makeUser(db); await alert(db, budgetLow.id, 'DEL', { max: 12000 });
  const regionOk = await makeUser(db); await alert(db, regionOk.id, 'DEL', { regions: ['seAsia', 'europe'] });
  const regionNo = await makeUser(db); await alert(db, regionNo.id, 'DEL', { regions: ['europe'] });
  const disabled = await makeUser(db, { status: 'disabled' }); await alert(db, disabled.id, 'DEL');
  const inactive = await makeUser(db); await alert(db, inactive.id, 'DEL'); await db.query(`UPDATE alert_subscriptions SET active = false WHERE user_id = $1`, [inactive.id]);
  const [route] = await db.query(`SELECT id FROM routes WHERE origin = 'DEL' AND destination = 'BKK'`);
  const watcher = await makeUser(db, { channels: [{ kind: 'telegram' }, { kind: 'email' }] });
  await db.query(`INSERT INTO route_watches (user_id, route_id) VALUES ($1,$2)`, [watcher.id, route.id]);
  const watcherCheap = await makeUser(db); await db.query(`INSERT INTO route_watches (user_id, route_id, max_price) VALUES ($1,$2,10000)`, [watcherCheap.id, route.id]);
  const both = await makeUser(db); await alert(db, both.id, 'DEL'); await db.query(`INSERT INTO route_watches (user_id, route_id) VALUES ($1,$2)`, [both.id, route.id]);

  const r = await onDealLive(db, dealId);
  assert.deepEqual(await notified(db, dealId), [match.id, budgetOk.id, regionOk.id].sort((a, b) => a - b));
  assert.deepEqual(await notified(db, dealId, 'route_watch'), [watcher.id, watcher.id, both.id]);
  assert.equal(r.instant, 6);
  const out = await db.query(`SELECT * FROM outbox ORDER BY id`);
  assert.equal(out.length, 6);
  for (const o of out) {
    assert.ok(o.body.includes(`${config.publicUrl}/deal/${dealId}`), 'deal link');
    assert.ok(o.body.includes(`${config.publicUrl}/unsubscribe?t=`), 'stop link');
    const [n] = await db.query(`SELECT * FROM notifications WHERE id = $1`, [o.meta.notification_id]);
    assert.equal(n.channel_id, o.meta.channel_id);
    assert.equal(n.status, 'queued');
  }
  const tg = out.find(o => o.channel === 'telegram')!;
  assert.match(tg.body, /Delhi → Bangkok/);
  assert.ok(out.find(o => o.channel === 'email')!.meta.html.includes('See the deal'));

  // Second call (e.g. a re-approval or a retry) sends nothing new
  const again = await onDealLive(db, dealId);
  assert.equal(again.instant, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM outbox`))[0].n, 6);
  // A deal that isn't live is never announced
  const review = await makeDeal(db, 'DEL', 'PRG', 40000, 70000, 'review');
  assert.equal((await onDealLive(db, review)).instant, 0);
  await db.close();
});

test('deal ended reaches only users who were told about it (on those channels) or saved it', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db, 'DEL', 'PRG', 42000, 70000);
  const told = await makeUser(db, { channels: [{ kind: 'telegram' }] }); await alert(db, told.id, 'DEL');
  const notTold = await makeUser(db); await alert(db, notTold.id, 'BOM');
  const saver = await makeUser(db, { channels: [{ kind: 'email' }, { kind: 'whatsapp' }] });
  await db.query(`INSERT INTO saved_deals (user_id, deal_id) VALUES ($1,$2)`, [saver.id, dealId]);
  const pendingDigest = await makeUser(db, { channels: [{ kind: 'email', frequency: 'daily' }] }); await alert(db, pendingDigest.id, 'DEL');

  await onDealLive(db, dealId);
  await withConfig(noProviders, async () => { await deliverOutbox(db); });
  // Telegram user got it later via a second channel added after the deal went live: that channel is not told about the end
  await db.query(`INSERT INTO notification_channels (user_id, kind, address) VALUES ($1, 'email', 'late@example.com')`, [told.id]);

  await db.query(`UPDATE deals SET status = 'expired', expired_at = now(), reason = 'price rose to 51200 (shown 42000)' WHERE id = $1`, [dealId]);
  await onDealEnded(db, dealId);
  const ended = await db.query(`SELECT n.user_id, c.kind FROM notifications n JOIN notification_channels c ON c.id = n.channel_id
    WHERE n.deal_id = $1 AND n.kind = 'deal_ended' ORDER BY n.user_id, c.kind`, [dealId]);
  assert.deepEqual(ended.map(e => `${e.user_id}:${e.kind}`), [`${told.id}:telegram`, `${saver.id}:email`, `${saver.id}:whatsapp`]);
  const [msg] = await db.query(`SELECT body FROM outbox WHERE meta ->> 'kind' = 'deal_ended' AND channel = 'telegram'`);
  assert.match(msg.body, /^Ended: Delhi → Prague\. Price rose to ₹51,200\./);
  assert.ok(msg.body.includes('/unsubscribe?t='));
  // The daily user's queued "live" notice was dropped, not sent in the next digest
  const [p] = await db.query(`SELECT status FROM notifications WHERE user_id = $1 AND kind = 'deal_live'`, [pendingDigest.id]);
  assert.equal(p.status, 'skipped');
  // Idempotent
  assert.equal((await onDealEnded(db, dealId)).instant, 0);
  await db.close();
});

test('deal ended cancels alerts that were not delivered yet', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db, 'BOM', 'DXB', 9000, 16000);
  const u = await makeUser(db); await alert(db, u.id, 'BOM');
  await onDealLive(db, dealId);
  await db.query(`UPDATE deals SET status = 'expired', reason = 'no flights found at re-check' WHERE id = $1`, [dealId]);
  const r = await onDealEnded(db, dealId);
  assert.equal(r.instant, 0, 'user was never told, so no "ended" message');
  const [o] = await db.query(`SELECT status FROM outbox`);
  assert.equal(o.status, 'failed');
  const [n] = await db.query(`SELECT status FROM notifications`);
  assert.equal(n.status, 'skipped');
  await db.close();
});

test('unsubscribe token roundtrip and tamper rejection', () => {
  const t = unsubscribeToken(42, 7);
  assert.deepEqual(verifyUnsubscribeToken(t), { userId: 42, channelId: 7 });
  const [payload, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 43, c: 7 })).toString('base64url');
  assert.equal(verifyUnsubscribeToken(`${forged}.${sig}`), null);
  assert.equal(verifyUnsubscribeToken(`${payload}.${sig.slice(0, -2)}xx`), null);
  assert.equal(verifyUnsubscribeToken(payload), null);
  assert.equal(verifyUnsubscribeToken(''), null);
  assert.equal(verifyUnsubscribeToken(`${t}.extra`), null);
});

test('delivery: email, telegram and whatsapp through the provider APIs', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db, 'DEL', 'BKK', 13000, 20000);
  const u = await makeUser(db, { channels: [{ kind: 'email' }, { kind: 'telegram', address: '555' }, { kind: 'whatsapp', address: '+91 98123 45678' }] });
  await alert(db, u.id, 'DEL');
  // The person wrote to us recently, so WhatsApp allows free text (outside 24 h a template is sent: test/whatsapp.test.ts)
  await db.query(`UPDATE notification_channels SET last_inbound_at = now() WHERE user_id = $1 AND kind = 'whatsapp'`, [u.id]);
  await onDealLive(db, dealId);
  const { f, calls } = fakeFetch();
  await withConfig({ resendApiKey: 're_test', telegramToken: 'tg123', whatsappToken: 'wa_tok', whatsappPhoneId: '999' }, async () => {
    const r = await deliverOutbox(db, { fetchImpl: f });
    assert.deepEqual(r, { sent: 3, logged: 0, retried: 0, failed: 0 });
  });
  const email = calls.find(c => c.url === 'https://api.resend.com/emails')!;
  assert.equal(email.init.headers.authorization, 'Bearer re_test');
  assert.deepEqual(email.body.to, [`u${emails}@example.com`]);
  assert.equal(email.body.from, config.emailFrom);
  assert.ok(email.body.html.includes('/unsubscribe?t='));
  assert.ok(email.body.headers['List-Unsubscribe']);
  const tg = calls.find(c => c.url === 'https://api.telegram.org/bottg123/sendMessage')!;
  assert.equal(tg.body.chat_id, '555');
  assert.ok(tg.body.text.includes(`/deal/${dealId}`));
  const wa = calls.find(c => c.url === 'https://graph.facebook.com/v21.0/999/messages')!;
  assert.equal(wa.init.headers.authorization, 'Bearer wa_tok');
  assert.equal(wa.body.to, '919812345678');
  assert.equal(wa.body.type, 'text');
  assert.ok(wa.body.text.body.includes(`/deal/${dealId}`));
  const ns = await db.query(`SELECT status, sent_at FROM notifications`);
  assert.ok(ns.every(n => n.status === 'sent' && n.sent_at));
  assert.ok((await db.query(`SELECT status FROM outbox`)).every(o => o.status === 'sent'));
  await db.close();
});

test('delivery without providers marks messages logged (dev mode)', async () => {
  const db = await freshDb();
  await enqueue(db, { channel: 'email', to: 'a@example.com', subject: 'Your code', body: '123456' });
  await enqueue(db, { channel: 'push', to: 'https://push.example/x', body: '{}' });
  const { f, calls } = fakeFetch();
  await withConfig(noProviders, async () => {
    const r = await deliverOutbox(db, { fetchImpl: f });
    assert.equal(r.logged, 2);
  });
  assert.equal(calls.length, 0);
  assert.ok((await db.query(`SELECT status FROM outbox`)).every(o => o.status === 'logged'));
  await db.close();
});

test('delivery retries failures, then gives up after 5 attempts', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db, 'DEL', 'BKK', 13000, 20000);
  const u = await makeUser(db); await alert(db, u.id, 'DEL');
  await onDealLive(db, dealId);
  const { f, calls } = fakeFetch(500, { message: 'down' });
  await withConfig({ resendApiKey: 're_test' }, async () => {
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = await deliverOutbox(db, { fetchImpl: f, retryDelaySec: 0 });
      assert.equal(r.retried, 1, `attempt ${i} is retried`);
      const [o] = await db.query(`SELECT status, attempts, error FROM outbox`);
      assert.equal(o.status, 'queued'); assert.equal(o.attempts, i); assert.match(o.error, /HTTP 500/);
    }
    const last = await deliverOutbox(db, { fetchImpl: f, retryDelaySec: 0 });
    assert.equal(last.failed, 1);
    assert.equal((await deliverOutbox(db, { fetchImpl: f, retryDelaySec: 0 })).failed, 0, 'nothing left to try');
  });
  assert.equal(calls.length, MAX_ATTEMPTS);
  const [o] = await db.query(`SELECT status, attempts FROM outbox`);
  assert.equal(o.status, 'failed'); assert.equal(o.attempts, MAX_ATTEMPTS);
  const [n] = await db.query(`SELECT status, attempts, error FROM notifications`);
  assert.equal(n.status, 'failed'); assert.equal(n.attempts, MAX_ATTEMPTS); assert.ok(n.error);

  // Retry back-off: a failed message isn't picked again straight away
  await enqueue(db, { channel: 'email', to: 'b@example.com', body: 'x' });
  await withConfig({ resendApiKey: 're_test' }, async () => {
    assert.equal((await deliverOutbox(db, { fetchImpl: f })).retried, 1);
    assert.equal((await deliverOutbox(db, { fetchImpl: f })).retried, 0);
  });
  await db.close();
});

test('push: gone subscriptions (410) are switched off', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db, 'DEL', 'BKK', 13000, 20000);
  const u = await makeUser(db, { channels: [{ kind: 'push', meta: { keys: { p256dh: 'k', auth: 'a' } } }] });
  await alert(db, u.id, 'DEL');
  await onDealLive(db, dealId);
  const sent: any[] = [];
  const pushImpl = async (sub: any, payload: string) => { sent.push({ sub, payload: JSON.parse(payload) }); throw Object.assign(new Error('gone'), { statusCode: 410 }); };
  const r = await deliverOutbox(db, { pushImpl });
  assert.equal(r.failed, 1);
  assert.equal(sent[0].sub.keys.p256dh, 'k');
  assert.equal(sent[0].payload.url, `${config.publicUrl}/deal/${dealId}`);
  assert.ok(sent[0].payload.title);
  const [c] = await db.query(`SELECT active FROM notification_channels WHERE id = $1`, [u.channels[0]]);
  assert.equal(c.active, false);
  await db.close();
});

test('unsubscribed channel: queued message is not sent', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db, 'DEL', 'BKK', 13000, 20000);
  const u = await makeUser(db); await alert(db, u.id, 'DEL');
  await onDealLive(db, dealId);
  await db.query(`UPDATE notification_channels SET active = false`);
  const { f, calls } = fakeFetch();
  await withConfig({ resendApiKey: 're_test' }, async () => { await deliverOutbox(db, { fetchImpl: f }); });
  assert.equal(calls.length, 0);
  assert.equal((await db.query(`SELECT status FROM notifications`))[0].status, 'skipped');
  await db.close();
});

test('daily digest groups a user\'s queued notifications into one message, once a day', async () => {
  const db = await freshDb();
  const d1 = await makeDeal(db, 'DEL', 'BKK', 13000, 20000);
  const d2 = await makeDeal(db, 'DEL', 'DXB', 9000, 16000);
  const d3 = await makeDeal(db, 'DEL', 'SIN', 14000, 22000);
  const daily = await makeUser(db, { channels: [{ kind: 'email', frequency: 'daily' }, { kind: 'telegram' }] });
  await alert(db, daily.id, 'DEL');
  for (const d of [d1, d2, d3]) await onDealLive(db, d);
  // d3 ends before the digest: left out
  await db.query(`UPDATE deals SET status = 'expired', reason = 'all dates passed' WHERE id = $1`, [d3]);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM outbox WHERE channel = 'email'`))[0].n, 0, 'daily channel waits');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM outbox WHERE channel = 'telegram'`))[0].n, 3, 'instant channel goes now');

  const morning = new Date('2026-11-05T03:00:00Z'); // 08:30 IST
  assert.equal(await sendDailyDigests(db, { now: new Date('2026-11-05T01:00:00Z') }), 0, 'too early (06:30 IST)');
  assert.equal(await sendDailyDigests(db, { now: morning }), 1);
  assert.equal(await sendDailyDigests(db, { now: morning }), 0, 'once per day');
  const [o] = await db.query(`SELECT * FROM outbox WHERE channel = 'email'`);
  assert.match(o.subject, /2 flight deals/);
  assert.ok(o.body.includes(`/deal/${d1}`) && o.body.includes(`/deal/${d2}`) && !o.body.includes(`/deal/${d3}`));
  assert.ok(o.body.includes('/unsubscribe?t='));
  const [s] = await db.query(`SELECT value FROM settings WHERE key = 'last_digest_date'`);
  assert.equal(s.value, '2026-11-05');

  await withConfig(noProviders, async () => { await deliverOutbox(db); });
  const ns = await db.query(`SELECT n.kind, n.status, n.deal_id FROM notifications n JOIN notification_channels c ON c.id = n.channel_id WHERE c.kind = 'email' ORDER BY n.id`);
  assert.deepEqual(ns.map(n => `${n.kind}:${n.deal_id ?? '-'}:${n.status}`),
    [`deal_live:${d1}:sent`, `deal_live:${d2}:sent`, `deal_live:${d3}:skipped`, `digest:-:sent`]);
  // Next day: nothing new queued -> no digest
  assert.equal(await sendDailyDigests(db, { now: new Date('2026-11-06T03:00:00Z') }), 0);
  await db.close();
});

test('telegram connect: signed /start link adds a verified channel', async () => {
  const db = await freshDb();
  const u = await makeUser(db);
  await withConfig({ telegramBotUsername: 'FaresightBot', telegramToken: 'tg123' }, async () => {
    const link = telegramConnectLink(u.id);
    const m = /^https:\/\/t\.me\/FaresightBot\?start=([A-Za-z0-9_-]{1,64})$/.exec(link);
    assert.ok(m, link);
    const { f, calls } = fakeFetch();
    const r = await handleTelegramUpdate(db, { update_id: 1, message: { chat: { id: 777, type: 'private' }, from: { username: 'asha' }, text: `/start ${m![1]}` } }, { fetchImpl: f });
    assert.equal(r.action, 'connected');
    const [c] = await db.query(`SELECT * FROM notification_channels WHERE user_id = $1 AND kind = 'telegram'`, [u.id]);
    assert.equal(c.address, '777'); assert.ok(c.verified_at); assert.equal(c.active, true);
    assert.equal(calls[0].body.chat_id, 777);
    // Reconnecting is fine; tampered tokens are refused
    assert.equal((await handleTelegramUpdate(db, { message: { chat: { id: 777 }, text: `/start ${m![1]}` } }, { fetchImpl: f })).action, 'connected');
    const bad = m![1].replace(/^\d+/, String(u.id + 1));
    assert.equal((await handleTelegramUpdate(db, { message: { chat: { id: 778 }, text: `/start ${bad}` } }, { fetchImpl: f })).action, 'invalid');
    assert.equal((await handleTelegramUpdate(db, { message: { chat: { id: 777 }, text: '/stop' } }, { fetchImpl: f })).action, 'stopped');
    const [c2] = await db.query(`SELECT active FROM notification_channels WHERE id = $1`, [c.id]);
    assert.equal(c2.active, false);
  });
  await db.close();
});

test('rendered messages per channel', async () => {
  const db = await freshDb();
  const dealId = await makeDeal(db, 'DEL', 'PRG', 42000, 70000);
  const d = await dealSummary(db, dealId);
  const push = renderNotice('deal_live', d, { id: 3, user_id: 9, kind: 'push' });
  const p = JSON.parse(push.body);
  assert.equal(p.url, `${config.publicUrl}/deal/${dealId}`);
  assert.match(p.title, /40% below normal: Delhi → Prague/);
  const wa = renderNotice('route_watch', d, { id: 3, user_id: 9, kind: 'whatsapp' });
  assert.match(wa.body, /A route you watch/);
  const t = new URL(wa.body.match(/\S+\/unsubscribe\?t=\S+/)![0]).searchParams.get('t')!;
  assert.deepEqual(verifyUnsubscribeToken(t), { userId: 9, channelId: 3 });
  await db.close();
});

test('forgetAddress erases outbox messages to a user\'s addresses', async () => {
  const db = await freshDb();
  await enqueue(db, { channel: 'email', to: 'Gone@Example.com', body: 'code 1' });
  await enqueue(db, { channel: 'telegram', to: '555', body: 'hi' });
  await enqueue(db, { channel: 'email', to: 'stay@example.com', body: 'code 2' });
  await db.query(`UPDATE outbox SET status = 'sent' WHERE to_address = '555'`);
  assert.equal(await forgetAddress(db, ['gone@example.com', '555', '']), 2);
  assert.deepEqual((await db.query(`SELECT to_address FROM outbox`)).map(r => r.to_address), ['stay@example.com']);
  assert.equal(await forgetAddress(db, []), 0);
  await db.close();
});
