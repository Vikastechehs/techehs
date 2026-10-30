const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, configured, STORAGE_KEY } = require('../extension/licensing.js');
const config = { provider: 'lemonsqueezy', storeId: 11, productId: 22, variantId: 33, checkoutUrl: 'https://pagepress-test.lemonsqueezy.com/buy/test-product', priceLabel: '$19/year' };
const key = 'test-license-key', email = 'buyer@example.com';
function harness(options = {}) {
  const values = structuredClone(options.values || {}), calls = [];
  const storage = { async get(name) { return { [name]: values[name] }; }, async set(data) { Object.assign(values, data); }, async remove(name) { delete values[name]; } };
  const response = (action) => ({ activated: action === 'activate', valid: true, deactivated: action === 'deactivate', error: null,
    license_key: { status: 'active', key, expires_at: null }, instance: { id: 'browser-instance-1' },
    meta: { store_id: 11, product_id: 22, variant_id: 33, customer_email: email } });
  const client = createClient({ config: options.config || config, storage, hasPermission: async () => options.permission !== false,
    fetcher: async (url, init) => {
      const action = url.split('/').pop(); calls.push({ action, url, init, params: Object.fromEntries(new URLSearchParams(init.body)) });
      if (options.networkError) throw new TypeError('Network unavailable');
      const data = response(action); options.mutate?.(data, action);
      return { ok: options.httpOk !== false, status: options.status || 200, json: async () => data };
    } });
  return { client, values, calls };
}
const saved = () => ({ [STORAGE_KEY]: { key, email, instanceId: 'browser-instance-1' } });

test('Free works without a configured store or network; larger captures require Pro', async () => {
  const h = harness({ config: {} });
  assert.equal((await h.client.refresh()).plan, 'free');
  assert.equal((await h.client.authorize(5)).allowed, true);
  assert.equal((await h.client.authorize(6)).allowed, false);
  assert.equal(h.calls.length, 0);
  assert.throws(() => h.client.checkout(), /not available/);
});
test('checkout configuration accepts only exact provider HTTPS URLs and product IDs', () => {
  assert.equal(configured(config), true);
  for (const checkoutUrl of ['http://pagepress-test.lemonsqueezy.com/buy/test', 'https://lemonsqueezy.com.evil.test/buy/test', 'https://pagepress-test.lemonsqueezy.com@evil.test/buy/test', 'javascript:alert(1)', 'https://pagepress-test.lemonsqueezy.com/not-checkout']) assert.equal(configured({ ...config, checkoutUrl }), false);
  assert.equal(configured({ ...config, productId: null }), false);
  const { client } = harness();
  assert.equal(client.checkout(), config.checkoutUrl);
  assert.equal(client.portal(), 'https://pagepress-test.lemonsqueezy.com/billing');
});
test('activation verifies product and purchase email, then retains the provider instance', async () => {
  const h = harness();
  const state = await h.client.activate(' ' + key + ' ', email.toUpperCase());
  assert.equal(state.plan, 'pro'); assert.equal(state.pageLimit, 200);
  assert.deepEqual(h.calls.map((c) => c.action), ['validate', 'activate']);
  assert.equal(h.values[STORAGE_KEY].instanceId, 'browser-instance-1');
  assert.equal(JSON.stringify(state).includes(key), false, 'Status must not disclose the full key');
  assert.equal((await h.client.authorize(21)).allowed, true);
  assert.equal(h.calls.at(-1).params.instance_id, 'browser-instance-1');
  assert.equal(h.calls.at(-1).init.credentials, 'omit');
  assert.equal(h.calls.at(-1).init.headers.Authorization, undefined);
});
test('wrong-product, wrong-email, and disabled keys cannot consume an activation', async () => {
  for (const mutate of [(d) => d.meta.variant_id = 99, (d) => d.meta.customer_email = 'someone@example.com', (d) => d.license_key.status = 'disabled', (d) => d.valid = false]) {
    const h = harness({ mutate });
    await assert.rejects(h.client.activate(key, email));
    assert.deepEqual(h.calls.map((c) => c.action), ['validate']);
    assert.equal(h.values[STORAGE_KEY], undefined);
  }
});
test('activation limit failures stay Free', async () => {
  const h = harness({ mutate(d, action) { if (action === 'activate') { d.activated = false; d.error = 'Activation limit reached'; } } });
  await assert.rejects(h.client.activate(key, email), /Activation limit/);
  assert.equal((await h.client.refresh()).plan, 'free');
});
test('re-entering the same license validates its instance instead of activating twice', async () => {
  const h = harness({ values: saved() });
  await h.client.activate(key, email);
  assert.deepEqual(h.calls.map((c) => c.action), ['validate']);
  await assert.rejects(h.client.activate('different-key', email), /Deactivate/);
});
test('expired, disabled, mismatched, and malformed responses never grant Pro', async () => {
  for (const mutate of [(d) => d.valid = false, (d) => d.meta.store_id = 44, (d) => d.instance.id = 'another-browser', (d) => d.license_key.status = 'disabled', (d) => d.license_key.expires_at = '2000-01-01T00:00:00Z', (d) => d.license_key.expires_at = 'bad-date', (d) => d.license_key.key = 'another-key']) {
    const h = harness({ values: saved(), mutate });
    assert.equal((await h.client.refresh()).plan, 'free');
    assert.equal((await h.client.authorize(21)).allowed, false);
    assert.ok(h.values[STORAGE_KEY], 'Keep the instance available for deactivation or renewal');
  }
});
test('no cached Pro flag grants access offline or after permission removal', async () => {
  for (const options of [{ networkError: true }, { permission: false }]) {
    const h = harness({ ...options, values: { ...saved(), plan: 'pro', pro: true } });
    assert.equal((await h.client.authorize(21)).allowed, false);
    assert.equal((await h.client.authorize(5)).allowed, true);
    assert.ok(h.values[STORAGE_KEY]);
  }
});
test('successful deactivation removes only the license; a failed request retains it', async () => {
  const h = harness({ values: { ...saved(), pagepressTabId: 123 } });
  assert.equal((await h.client.deactivate()).plan, 'free');
  assert.equal(h.values[STORAGE_KEY], undefined); assert.equal(h.values.pagepressTabId, 123);
  const failed = harness({ values: saved(), mutate(d) { d.deactivated = false; } });
  await assert.rejects(failed.client.deactivate()); assert.ok(failed.values[STORAGE_KEY]);
});
test('invalid ranges and incomplete activation forms fail before any API request', async () => {
  const h = harness();
  for (const count of [0, 201, 2.5, '21', NaN]) await assert.rejects(h.client.authorize(count));
  await assert.rejects(h.client.activate('', email)); await assert.rejects(h.client.activate(key, 'not-email'));
  assert.equal(h.calls.length, 0);
});
