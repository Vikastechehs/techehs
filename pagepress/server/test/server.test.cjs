const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { hmac } = require('../src/razorpay');
const { loadConfig } = require('../src/config');
const { createClient } = require('../../extension/licensing.js');

const config = {
  publicUrl: 'http://127.0.0.1/', trustProxy: false, keyId: 'rzp_test_public', keySecret: 'test_key_secret', webhookSecret: 'test_webhook_secret',
  plans: { INR: 'plan_inr', USD: 'plan_usd' }, passes: { week: { days: 7, amounts: { INR: 19900, USD: 249 } }, month: { days: 30, amounts: { INR: 39900 } } }, activationLimit: 2, totalCount: 10, sellerName: 'PagePress', supportEmail: 'help@example.com',
  rateLimits: { license: 1000, checkout: 1000, manage: 1000 }, inrIndianPaymentsOnly: true
};
let clock = 1_800_000_000;
const DAY = 86400;
// In-memory stand-in for the Razorpay API: no network, no real payments.
const fake = {
  subscriptions: new Map(), created: [], cancelled: [], next: 1, failGet: false,
  async getPlan(id) {
    if (id === 'plan_inr') return { id, period: 'yearly', interval: 1, item: { name: 'PagePress Pro yearly', amount: 79900, currency: 'INR' } };
    if (id === 'plan_usd') return { id, period: 'yearly', interval: 1, item: { name: 'PagePress Pro yearly', amount: 1900, currency: 'USD' } };
    throw Object.assign(new Error('not found'), { status: 400 });
  },
  async createSubscription(body) {
    const sub = { id: `sub_${this.next++}`, plan_id: body.plan_id, status: 'created', notes: body.notes, current_end: null };
    this.subscriptions.set(sub.id, sub); this.created.push(body); return { ...sub };
  },
  async getSubscription(id) { if (this.failGet) throw new Error('down'); return { ...this.subscriptions.get(id) }; },
  async cancelAtCycleEnd(id) { this.cancelled.push(id); return { ...this.subscriptions.get(id) }; },
  payments: new Map(), refunds: [], cancelledNow: [], orders: new Map(), captured: [],
  async createOrder(body) { const order = { id: `order_${this.next++}`, ...body, status: 'created' }; this.orders.set(order.id, order); return { ...order }; },
  async capturePayment(id, amount, currency) { this.captured.push(id); Object.assign(this.payments.get(id), { status: 'captured' }); return { ...this.payments.get(id), amount, currency }; },
  async getPayment(id) { return { ...this.payments.get(id) }; },
  async refundPayment(id) { this.refunds.push(id); return { id: 'rfnd_' + id }; },
  async cancelNow(id) { this.cancelledNow.push(id); Object.assign(this.subscriptions.get(id), { status: 'cancelled' }); return { ...this.subscriptions.get(id) }; }
};
let server, base, db;
before(async () => {
  db = openDatabase(':memory:');
  server = http.createServer(createApp({ config, db, razorpay: fake, now: () => clock }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(() => { server.close(); db.close(); });

async function post(path, body, { form = false, headers = {}, raw } = {}) {
  const response = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
    body: raw ?? (form ? new URLSearchParams(body).toString() : JSON.stringify(body))
  });
  return { status: response.status, data: await response.json() };
}
const license = (action, body) => post(`v1/licenses/${action}`, body, { form: true });
function pay(subscriptionId, days = 365, international = false) {
  Object.assign(fake.subscriptions.get(subscriptionId), { status: 'active', current_start: clock, current_end: clock + days * DAY });
  const paymentId = `pay_${subscriptionId}`;
  fake.payments.set(paymentId, { id: paymentId, subscription_id: subscriptionId, international, method: international ? 'card' : 'upi' });
  return { razorpay_payment_id: paymentId, razorpay_subscription_id: subscriptionId, razorpay_signature: hmac(config.keySecret, `${paymentId}|${subscriptionId}`) };
}
function webhook(event, entity, id = `evt_${Math.random()}`, secret = config.webhookSecret, payment) {
  const raw = JSON.stringify({ event, payload: { subscription: { entity }, ...(payment ? { payment: { entity: payment } } : {}) } });
  return post('api/razorpay/webhook', null, { raw, headers: { 'X-Razorpay-Signature': hmac(secret, raw), 'X-Razorpay-Event-Id': id } });
}
async function buy(email = 'buyer@example.com', currency = 'INR') {
  const start = await post('api/checkout', { email, currency });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const claimed = await post('api/checkout/claim', { subscription_id: start.data.subscription_id, claim_token: start.data.claim_token, ...pay(start.data.subscription_id) });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
  return { ...start.data, key: claimed.data.license_key };
}

test('configuration requires secrets from the environment and HTTPS public URL', () => {
  const env = { PUBLIC_URL: 'https://licenses.example.com', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', RAZORPAY_PLAN_ID_INR: 'plan_inr' };
  assert.deepEqual(loadConfig(env).plans, { INR: 'plan_inr' });
  assert.throws(() => loadConfig({ ...env, RAZORPAY_KEY_SECRET: '' }), /RAZORPAY_KEY_SECRET/);
  assert.throws(() => loadConfig({ ...env, PUBLIC_URL: 'http://licenses.example.com' }), /HTTPS/);
  assert.deepEqual(loadConfig({ ...env, PASS_WEEK_INR: '19900', PASS_MONTH_USD: '499' }).passes, { week: { days: 7, amounts: { INR: 19900 } }, month: { days: 30, amounts: { USD: 499 } } });
  assert.throws(() => loadConfig({ ...env, PASS_WEEK_INR: '199.00' }), /paise\/cents/);
});

test('offer and checkout use the plan for the requested currency', async () => {
  const offer = await (await fetch(base + 'api/offer?currency=INR')).json();
  assert.deepEqual([offer.currency, offer.amount], ['INR', 79900]);
  const usd = await post('api/checkout', { email: 'Intl@Example.com', currency: 'usd' });
  assert.equal(usd.status, 200);
  assert.equal(fake.created.at(-1).plan_id, 'plan_usd');
  assert.equal(fake.created.at(-1).notes.email, 'intl@example.com');
  assert.equal(usd.data.key_id, 'rzp_test_public');
  assert.ok(!JSON.stringify(usd.data).includes(config.keySecret), 'The key secret never reaches the browser');
  assert.equal((await post('api/checkout', { email: 'bad', currency: 'INR' })).status, 400);
  assert.equal((await post('api/checkout', { email: 'a@b.co', currency: 'EUR' })).status, 400);
});

test('a forged payment signature or wrong claim token never issues a license', async () => {
  const start = (await post('api/checkout', { email: 'forger@example.com', currency: 'INR' })).data;
  const paid = pay(start.subscription_id);
  assert.equal((await post('api/checkout/claim', { subscription_id: start.subscription_id, claim_token: 'wrong', ...paid })).status, 403);
  assert.equal((await post('api/checkout/claim', { subscription_id: start.subscription_id, claim_token: start.claim_token, ...paid, razorpay_signature: 'f'.repeat(64) })).status, 400);
  const unpaid = await post('api/checkout/claim', { subscription_id: start.subscription_id, claim_token: start.claim_token });
  assert.equal(unpaid.status, 202, 'Opening checkout alone does not issue a license');
});

test('verified payment issues one license; claiming again returns the same key', async () => {
  const bought = await buy('owner@example.com');
  assert.match(bought.key, /^PP(-[A-Z2-7]{5}){4}$/);
  const again = await post('api/checkout/claim', { subscription_id: bought.subscription_id, claim_token: bought.claim_token });
  assert.equal(again.data.license_key, bought.key);
  const typed = bought.key.toLowerCase().replace(/o/g, '0').replace(/i/g, '1');
  assert.equal((await license('validate', { license_key: typed })).data.license_key.key, bought.key, 'Lowercase and 0/1 look-alikes are accepted');
  const valid = await license('validate', { license_key: bought.key });
  assert.equal(valid.data.valid, true);
  assert.deepEqual(valid.data.meta, { store: 'pagepress', product: 'pagepress-pro', provider: 'razorpay', plan: 'year', currency: 'INR', customer_email: 'owner@example.com' });
  assert.equal(valid.data.license_key.expires_at, new Date((clock + 365 * DAY) * 1000).toISOString());
});

test('webhooks are signature-checked, deduplicated, and issue licenses when the buyer closed the tab', async () => {
  const start = (await post('api/checkout', { email: 'closed-tab@example.com', currency: 'INR' })).data;
  pay(start.subscription_id);
  const entity = fake.subscriptions.get(start.subscription_id);
  assert.equal((await webhook('subscription.activated', entity, 'evt_forged', 'wrong-secret')).status, 400);
  assert.equal((await post('api/checkout/claim', { subscription_id: start.subscription_id, claim_token: start.claim_token })).status, 202);
  assert.equal((await webhook('subscription.activated', entity, 'evt_a0')).status, 200);
  assert.equal((await post('api/checkout/claim', { subscription_id: start.subscription_id, claim_token: start.claim_token })).status, 202, 'INR waits for the charged event and its payment');
  const payment = fake.payments.get(`pay_${start.subscription_id}`);
  assert.equal((await webhook('subscription.charged', entity, 'evt_a1', undefined, payment)).status, 200);
  assert.equal((await webhook('subscription.charged', entity, 'evt_a1', undefined, payment)).data.duplicate, true);
  const claimed = await post('api/checkout/claim', { subscription_id: start.subscription_id, claim_token: start.claim_token });
  assert.equal(claimed.status, 200);
  assert.equal((await license('validate', { license_key: claimed.data.license_key })).data.valid, true);
});

test('activation limit, revoked instances, renewal, cancellation and expiry', async () => {
  const { key, subscription_id: sub } = await buy('limits@example.com');
  const a = await license('activate', { license_key: key, instance_name: 'PagePress browser' });
  const b = await license('activate', { license_key: key, instance_name: 'PagePress browser' });
  assert.equal(a.data.activated && b.data.activated, true);
  const c = await license('activate', { license_key: key, instance_name: 'PagePress browser' });
  assert.equal(c.status, 400); assert.match(c.data.error, /activation limit/);
  assert.equal((await license('validate', { license_key: key, instance_id: a.data.instance.id })).data.instance.id, a.data.instance.id);
  assert.equal((await license('deactivate', { license_key: key, instance_id: a.data.instance.id })).data.deactivated, true);
  const revoked = await license('validate', { license_key: key, instance_id: a.data.instance.id });
  assert.equal(revoked.status, 404); assert.equal(revoked.data.valid, false);
  assert.equal((await license('activate', { license_key: key })).data.activated, true, 'Released slot can be reused');

  // Renewal extends access; a missed webhook is recovered by re-reading the subscription.
  clock += 366 * DAY;
  Object.assign(fake.subscriptions.get(sub), { current_end: clock + 365 * DAY });
  const renewed = await license('validate', { license_key: key, instance_id: b.data.instance.id });
  assert.equal(renewed.data.valid, true, 'Resynced after a missed renewal webhook');
  // Cancellation at cycle end, then the end-of-cycle webhook.
  const account = await post('api/manage/cancel', { license_key: key, email: 'LIMITS@example.com' });
  assert.equal(account.data.renewal_cancelled, true); assert.deepEqual(fake.cancelled, [sub]);
  assert.equal((await license('validate', { license_key: key })).data.valid, true, 'Paid period continues after cancelling renewal');
  clock += 365 * DAY;
  await webhook('subscription.cancelled', { ...fake.subscriptions.get(sub), status: 'cancelled', ended_at: clock });
  const ended = await license('validate', { license_key: key });
  assert.equal(ended.data.valid, false); assert.equal(ended.data.license_key.status, 'expired');
  assert.equal((await license('activate', { license_key: key })).status, 400);
});

test('unpaid renewals expire access when the paid period ends, even if Razorpay is unreachable', async () => {
  const { key, subscription_id: sub } = await buy('lapsed@example.com');
  await webhook('subscription.pending', { ...fake.subscriptions.get(sub), status: 'pending' });
  assert.equal((await license('validate', { license_key: key })).data.valid, true);
  clock += 366 * DAY; fake.failGet = true;
  assert.equal((await license('validate', { license_key: key })).data.valid, false);
  fake.failGet = false;
  await webhook('subscription.halted', { ...fake.subscriptions.get(sub), status: 'halted' });
  assert.equal((await license('validate', { license_key: key })).data.license_key.status, 'expired');
});

test('self-service requires the matching email and can release a browser', async () => {
  const { key } = await buy('self@example.com');
  const { data } = await license('activate', { license_key: key });
  assert.equal((await post('api/manage/status', { license_key: key, email: 'other@example.com' })).status, 404);
  const status = await post('api/manage/status', { license_key: key, email: 'self@example.com' });
  assert.equal(status.data.instances.length, 1);
  const released = await post('api/manage/release', { license_key: key, email: 'self@example.com', instance_id: data.instance.id });
  assert.equal(released.data.instances.length, 0);
  assert.equal((await license('validate', { license_key: key, instance_id: data.instance.id })).data.valid, false);
});

test('unknown keys and malformed requests are rejected', async () => {
  assert.equal((await license('validate', { license_key: 'PP-AAAAA-AAAAA-AAAAA-AAAAA' })).status, 404);
  assert.equal((await license('validate', {})).status, 400);
  assert.equal((await post('api/checkout', null, { raw: 'x'.repeat(70000) })).status, 413);
});

test('the PagePress extension client activates, verifies and deactivates against this server', async () => {
  const { key } = await buy('extension@example.com');
  const values = {};
  const storage = { async get(name) { return { [name]: values[name] }; }, async set(data) { Object.assign(values, data); }, async remove(name) { delete values[name]; } };
  const origins = [];
  const client = createClient({ config: { razorpay: { serverUrl: base, inrPriceLabel: '₹799/year' } }, storage, hasPermission: async (origin) => { origins.push(origin); return true; } });
  await assert.rejects(client.activate(key, 'wrong@example.com'), /email does not match/);
  const active = await client.activate(key, 'extension@example.com');
  assert.equal(active.plan, 'pro'); assert.equal(active.provider, 'razorpay');
  assert.equal((await client.refresh()).plan, 'pro');
  assert.equal((await client.authorize(150)).allowed, true);
  assert.equal(client.checkout('INR'), base + 'buy?currency=INR&plan=year');
  assert.equal(await client.portal(), base + 'manage');
  assert.ok(origins.every((o) => o === new URL(base).origin + '/*'));
  assert.equal((await client.deactivate()).plan, 'free');
  assert.equal(values.pagepressLicense, undefined);

  // A 1-week pass bought on this server activates in the extension as a week plan.
  const start = (await post('api/checkout', { email: 'extension@example.com', currency: 'INR', plan: 'week' })).data;
  const pass = await post('api/checkout/claim', { purchase_id: start.order_id, claim_token: start.claim_token, ...payOrder(start.order_id) });
  const weekly = await client.activate(pass.data.license_key, 'extension@example.com');
  assert.deepEqual([weekly.plan, weekly.licensePlan], ['pro', 'week']);
  assert.equal((await client.refresh()).licensePlan, 'week');
});

test('license and checkout endpoints are rate limited per client', async () => {
  const limitedDb = openDatabase(':memory:');
  const limited = http.createServer(createApp({ config: { ...config, rateLimits: { license: 2, checkout: 1, manage: 1 } }, db: limitedDb, razorpay: fake, now: () => clock }));
  await new Promise((resolve) => limited.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${limited.address().port}/`;
  try {
    const call = (path, body) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
    const key = { license_key: 'PP-AAAAA-AAAAA-AAAAA-AAAAA' };
    assert.deepEqual([await call('v1/licenses/validate', key), await call('v1/licenses/validate', key), await call('v1/licenses/validate', key)], [404, 404, 429]);
    assert.deepEqual([await call('api/checkout', { email: 'a@b.co', currency: 'INR' }), await call('api/checkout', { email: 'a@b.co', currency: 'INR' })], [200, 429]);
  } finally { limited.close(); limitedDb.close(); }
});

test('with INR_INDIAN_PAYMENTS_ONLY, international cards cannot buy the INR price: refunded, cancelled, no license', async () => {
  const start = (await post('api/checkout', { email: 'abroad@example.com', currency: 'INR' })).data;
  const paid = pay(start.subscription_id, 365, true);
  const claimed = await post('api/checkout/claim', { subscription_id: start.subscription_id, claim_token: start.claim_token, ...paid });
  assert.equal(claimed.status, 403); assert.match(claimed.data.error, /refunded.*USD plan/);
  assert.deepEqual([fake.refunds.at(-1), fake.cancelledNow.at(-1)], [paid.razorpay_payment_id, start.subscription_id]);
  // A later charged webhook for the same checkout must not issue a key either.
  await webhook('subscription.charged', fake.subscriptions.get(start.subscription_id), 'evt_intl', undefined, fake.payments.get(paid.razorpay_payment_id));
  assert.equal((await post('api/checkout/claim', { subscription_id: start.subscription_id, claim_token: start.claim_token })).status, 403);

  // Webhook arriving first (tab closed) applies the same rule.
  const second = (await post('api/checkout', { email: 'abroad2@example.com', currency: 'INR' })).data;
  const paid2 = pay(second.subscription_id, 365, true);
  await webhook('subscription.charged', fake.subscriptions.get(second.subscription_id), 'evt_intl2', undefined, fake.payments.get(paid2.razorpay_payment_id));
  assert.equal(fake.refunds.at(-1), paid2.razorpay_payment_id);
  assert.equal((await post('api/checkout/claim', { subscription_id: second.subscription_id, claim_token: second.claim_token })).status, 403);

  // International cards are fine on the USD plan.
  const usd = (await post('api/checkout', { email: 'abroad3@example.com', currency: 'USD' })).data;
  const ok = await post('api/checkout/claim', { subscription_id: usd.subscription_id, claim_token: usd.claim_token, ...pay(usd.subscription_id, 365, true) });
  assert.equal(ok.status, 200);
});

test('with a universal price (default), international cards can buy the INR plan and webhooks issue on activation', async () => {
  const openDb = openDatabase(':memory:');
  const open = http.createServer(createApp({ config: { ...config, inrIndianPaymentsOnly: false }, db: openDb, razorpay: fake, now: () => clock }));
  await new Promise((resolve) => open.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${open.address().port}/`;
  const call = (path, body) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  try {
    const refunds = fake.refunds.length;
    const start = (await call('api/checkout', { email: 'traveller@example.com', currency: 'INR' })).data;
    const claimed = await call('api/checkout/claim', { subscription_id: start.subscription_id, claim_token: start.claim_token, ...pay(start.subscription_id, 365, true) });
    assert.equal(claimed.status, 200); assert.equal(fake.refunds.length, refunds);
    assert.equal((await (await fetch(url + 'api/offer?currency=INR')).json()).indianPaymentsOnly, false);
  } finally { open.close(); openDb.close(); }
});

function payOrder(orderId, { amount, currency, status = 'captured', international = false } = {}) {
  const order = fake.orders.get(orderId), paymentId = `pay_${orderId}`;
  fake.payments.set(paymentId, { id: paymentId, order_id: orderId, amount: amount ?? order.amount, currency: currency ?? order.currency, status, international, method: 'upi' });
  return { razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_signature: hmac(config.keySecret, `${orderId}|${paymentId}`) };
}

test('1-week and 1-month passes: offers, one-time order, 7/30-day expiry, no renewal', async () => {
  const week = await (await fetch(base + 'api/offer?currency=INR&plan=week')).json();
  assert.deepEqual([week.plan, week.recurring, week.amount, week.days], ['week', false, 19900, 7]);
  assert.equal((await fetch(base + 'api/offer?currency=USD&plan=month')).status, 404, 'A pass without a configured amount is not sold');

  const start = (await post('api/checkout', { email: 'weekly@example.com', currency: 'INR', plan: 'week' })).data;
  assert.match(start.order_id, /^order_/); assert.equal(start.subscription_id, undefined);
  assert.equal(fake.orders.get(start.order_id).amount, 19900);
  assert.equal(fake.orders.get(start.order_id).notes.plan, 'week');
  const forged = { ...payOrder(start.order_id), razorpay_signature: hmac(config.keySecret, `${start.order_id}|pay_other`) };
  assert.equal((await post('api/checkout/claim', { purchase_id: start.order_id, claim_token: start.claim_token, ...forged })).status, 400);
  const claimed = await post('api/checkout/claim', { purchase_id: start.order_id, claim_token: start.claim_token, ...payOrder(start.order_id) });
  assert.equal(claimed.status, 200); assert.equal(claimed.data.plan, 'week');
  assert.equal(claimed.data.expires_at, new Date((clock + 7 * DAY) * 1000).toISOString());
  const key = claimed.data.license_key;
  const valid = await license('validate', { license_key: key });
  assert.equal(valid.data.valid, true); assert.equal(valid.data.meta.plan, 'week');
  const account = await post('api/manage/status', { license_key: key, email: 'weekly@example.com' });
  assert.deepEqual([account.data.plan, account.data.renews], ['week', false]);
  await post('api/manage/cancel', { license_key: key, email: 'weekly@example.com' });
  assert.ok(!fake.cancelled.includes(start.order_id), 'Passes have no renewal to cancel');
  clock += 8 * DAY;
  const ended = await license('validate', { license_key: key });
  assert.equal(ended.data.valid, false); assert.equal(ended.data.license_key.status, 'expired');

  // Month pass in INR with an authorized (not yet captured) payment: captured, then 30 days.
  const month = (await post('api/checkout', { email: 'monthly@example.com', currency: 'INR', plan: 'month' })).data;
  const paid = payOrder(month.order_id, { status: 'authorized' });
  const monthly = await post('api/checkout/claim', { purchase_id: month.order_id, claim_token: month.claim_token, ...paid });
  assert.equal(monthly.status, 200); assert.ok(fake.captured.includes(paid.razorpay_payment_id));
  assert.equal(monthly.data.expires_at, new Date((clock + 30 * DAY) * 1000).toISOString());
});

test('passes require the exact order amount and are issued by order.paid when the tab was closed', async () => {
  const short = (await post('api/checkout', { email: 'short@example.com', currency: 'USD', plan: 'week' })).data;
  const underpaid = await post('api/checkout/claim', { purchase_id: short.order_id, claim_token: short.claim_token, ...payOrder(short.order_id, { amount: 100 }) });
  assert.equal(underpaid.status, 202, 'A payment for the wrong amount issues nothing');

  const closed = (await post('api/checkout', { email: 'closed@example.com', currency: 'USD', plan: 'week' })).data;
  payOrder(closed.order_id);
  const raw = JSON.stringify({ event: 'order.paid', payload: { order: { entity: fake.orders.get(closed.order_id) }, payment: { entity: fake.payments.get(`pay_${closed.order_id}`) } } });
  assert.equal((await post('api/razorpay/webhook', null, { raw, headers: { 'X-Razorpay-Signature': hmac(config.webhookSecret, raw), 'X-Razorpay-Event-Id': 'evt_order_1' } })).status, 200);
  const claimed = await post('api/checkout/claim', { purchase_id: closed.order_id, claim_token: closed.claim_token });
  assert.equal(claimed.status, 200); assert.equal(claimed.data.plan, 'week');

  // Orders this server did not create never issue licenses.
  const foreign = JSON.stringify({ event: 'order.paid', payload: { order: { entity: { id: 'order_elsewhere' } }, payment: { entity: { id: 'pay_x', order_id: 'order_elsewhere', amount: 249, currency: 'USD', status: 'captured' } } } });
  await post('api/razorpay/webhook', null, { raw: foreign, headers: { 'X-Razorpay-Signature': hmac(config.webhookSecret, foreign), 'X-Razorpay-Event-Id': 'evt_order_2' } });
  assert.equal((await license('validate', { license_key: 'PP-AAAAA-AAAAA-AAAAA-AAAAA' })).status, 404);
});

test('review fixes: malformed request lines get 400 and the server keeps running', async () => {
  const net = require('node:net');
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1', () => socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'));
    let data = ''; socket.on('data', (d) => { data += d; }); socket.on('end', () => resolve(data)); socket.on('error', reject);
    setTimeout(() => { socket.destroy(); resolve(data); }, 1000);
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal((await fetch(base + 'healthz')).status, 200);
});

test('review fixes: behind a proxy, the right-most forwarded address is rate limited, not a spoofed first entry', async () => {
  const proxiedDb = openDatabase(':memory:');
  const proxied = http.createServer(createApp({ config: { ...config, trustProxy: true, rateLimits: { license: 2, checkout: 1, manage: 1 } }, db: proxiedDb, razorpay: fake, now: () => clock }));
  await new Promise((resolve) => proxied.listen(0, '127.0.0.1', resolve));
  try {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`http://127.0.0.1:${proxied.address().port}/v1/licenses/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` }, body: JSON.stringify({ license_key: 'PP-AAAAA-AAAAA-AAAAA-AAAAA' }) });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [404, 404, 429, 429]);
  } finally { proxied.close(); proxiedDb.close(); }
});

test('review fixes: a pass bought before a price change still issues at the price it was ordered for', async () => {
  const start = (await post('api/checkout', { email: 'pricechange@example.com', currency: 'INR', plan: 'week' })).data;
  const original = config.passes.week.amounts.INR;
  config.passes.week.amounts.INR = 29900;
  try {
    const claimed = await post('api/checkout/claim', { purchase_id: start.order_id, claim_token: start.claim_token, ...payOrder(start.order_id) });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
    assert.equal(fake.orders.get(start.order_id).amount, original);
  } finally { config.passes.week.amounts.INR = original; }
});

test('review fixes: an authenticated-only subscription gets a short provisional license that resyncs to the paid period', async () => {
  const start = (await post('api/checkout', { email: 'mandate@example.com', currency: 'INR' })).data;
  const paid = pay(start.subscription_id);
  Object.assign(fake.subscriptions.get(start.subscription_id), { status: 'authenticated', current_end: null });
  const claimed = await post('api/checkout/claim', { subscription_id: start.subscription_id, claim_token: start.claim_token, ...paid });
  assert.equal(claimed.data.expires_at, new Date((clock + 2 * DAY) * 1000).toISOString(), 'Provisional, not a full year');
  clock += 3 * DAY;
  Object.assign(fake.subscriptions.get(start.subscription_id), { status: 'active', current_end: clock + 365 * DAY });
  const valid = await license('validate', { license_key: claimed.data.license_key });
  assert.equal(valid.data.valid, true);
  assert.equal(valid.data.license_key.expires_at, new Date((clock + 365 * DAY) * 1000).toISOString());
});

test('review fixes: a late out-of-order "halted" webhook cannot expire a recovered subscription', async () => {
  const { key, subscription_id: sub } = await buy('ordering@example.com');
  // Razorpay now reports the subscription active; a stale halted event arrives afterwards.
  await webhook('subscription.halted', { ...fake.subscriptions.get(sub), status: 'halted' }, 'evt_stale_halt');
  assert.equal((await license('validate', { license_key: key })).data.valid, true);
  // If the API is unreachable the event's copy is used, and the next check after an hour heals it.
  fake.failGet = true;
  await webhook('subscription.halted', { ...fake.subscriptions.get(sub), status: 'halted' }, 'evt_stale_halt_2');
  fake.failGet = false;
  assert.equal((await license('validate', { license_key: key })).data.valid, false);
  clock += 2 * 3600;
  assert.equal((await license('validate', { license_key: key })).data.valid, true, 'Re-checked against Razorpay and restored');
});
