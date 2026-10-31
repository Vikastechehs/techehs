// Drives the real /buy and /manage pages in Chromium against the real server, with Razorpay's
// checkout.js replaced by a stub that "pays" and signs like Razorpay. No network or payment.
// Run: node --disable-warning=ExperimentalWarning test/pages.browser.cjs  (needs playwright)
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require(process.env.PAGEPRESS_PLAYWRIGHT || 'playwright');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { hmac } = require('../src/razorpay');

const config = { keyId: 'rzp_test_public', keySecret: 'test_key_secret', webhookSecret: 'w', plans: { INR: 'plan_inr' }, passes: { week: { days: 7, amounts: { INR: 24900 } } }, activationLimit: 2, totalCount: 10, sellerName: 'PagePress', supportEmail: 'help@example.com' };
const subscriptions = new Map();
const razorpay = {
  async getPlan() { return { period: 'yearly', interval: 1, item: { name: 'PagePress Pro yearly', amount: 79900, currency: 'INR' } }; },
  async createSubscription(body) { const id = 'sub_page_' + (subscriptions.size + 1); subscriptions.set(id, { id, plan_id: body.plan_id, status: 'created', notes: body.notes }); return { id, status: 'created' }; },
  async getSubscription(id) { return { ...subscriptions.get(id) }; },
  async cancelAtCycleEnd(id) { return { ...subscriptions.get(id) }; },
  orders: new Map(),
  async createOrder(body) { const id = 'order_page_' + (this.orders.size + 1); this.orders.set(id, { id, ...body }); return { id, ...body }; },
  async getPayment(id) {
    const order = this.orders.get(id.replace(/^pay_/, ''));
    return order ? { id, order_id: order.id, amount: order.amount, currency: order.currency, status: 'captured', international: false } : { id, international: false, method: 'upi' };
  }
};

async function main() {
  const db = openDatabase(':memory:');
  const server = http.createServer(createApp({ config, db, razorpay }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    page.on('pageerror', (error) => errors.push(error.message));
    // Expose a signer standing in for Razorpay's servers, and stub checkout.js to call the page's handler.
    await page.exposeFunction('stubRazorpayPay', (subscriptionId) => {
      Object.assign(subscriptions.get(subscriptionId), { status: 'active', current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 365 * 86400 });
      const paymentId = 'pay_' + subscriptionId;
      return { razorpay_payment_id: paymentId, razorpay_subscription_id: subscriptionId, razorpay_signature: hmac(config.keySecret, `${paymentId}|${subscriptionId}`) };
    });
    await page.exposeFunction('stubRazorpayPayOrder', (orderId) => {
      const paymentId = 'pay_' + orderId;
      return { razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_signature: hmac(config.keySecret, `${orderId}|${paymentId}`) };
    });
    let opened = null;
    await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) => route.fulfill({ contentType: 'text/javascript', body: `
      window.Razorpay = function (options) { this.options = options; };
      window.Razorpay.prototype.on = function () {};
      window.Razorpay.prototype.open = async function () {
        window.__opened = this.options;
        this.options.handler(this.options.order_id ? await window.stubRazorpayPayOrder(this.options.order_id) : await window.stubRazorpayPay(this.options.subscription_id));
      };` }));
    await page.goto(base + 'buy?currency=INR');
    await page.waitForFunction(() => document.getElementById('price').textContent.includes('799'));
    assert.match(await page.locator('#price').textContent(), /₹799\s*\/\s*year/);
    await page.locator('#email').fill('Page.Buyer@example.com');
    await page.locator('#pay').click();
    await page.locator('#done').waitFor({ state: 'visible', timeout: 10000 });
    opened = await page.evaluate(() => window.__opened);
    assert.equal(opened.key, 'rzp_test_public');
    assert.match(opened.subscription_id, /^sub_page_/);
    const key = await page.locator('#key').textContent();
    assert.match(key, /^PP(-[A-Z2-7]{5}){4}$/);
    assert.equal(await page.locator('#done-email').textContent(), 'page.buyer@example.com');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.PAGEPRESS_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.PAGEPRESS_SCREENSHOT_DIR}/buy-complete-390.png` });

    // Reopening the page in the same browser recovers the key.
    await page.goto(base + 'buy?currency=INR');
    await page.locator('#recover').click();
    await page.locator('#done').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#key').textContent(), key);

    // A 1-week pass is a one-time order: no renewal wording, Razorpay opened with order_id and amount.
    await page.evaluate(() => localStorage.clear());
    await page.goto(base + 'buy?currency=INR&plan=week');
    await page.waitForFunction(() => document.getElementById('price').textContent.includes('249'));
    assert.match(await page.locator('#price').textContent(), /₹249 · 7 days/);
    assert.match(await page.locator('#renewal').textContent(), /does not renew/);
    assert.match(await page.locator('#other-plans').textContent(), /1 month · 1 year/);
    await page.locator('#email').fill('weekly@example.com');
    await page.locator('#pay').click();
    await page.locator('#done').waitFor({ state: 'visible', timeout: 10000 });
    const weekOpened = await page.evaluate(() => window.__opened);
    assert.match(weekOpened.order_id, /^order_page_/); assert.equal(weekOpened.amount, 24900); assert.equal(weekOpened.subscription_id, undefined);
    const weekKey = await page.locator('#key').textContent();
    await page.goto(base + 'manage');
    await page.locator('#email').fill('weekly@example.com'); await page.locator('#key').fill(weekKey);
    await page.locator('#form button').click();
    await page.locator('#account').waitFor({ state: 'visible' });
    assert.match(await page.locator('#status').textContent(), /1-week pass/);
    assert.match(await page.locator('#period').textContent(), /do not renew/);
    assert.equal(await page.locator('#cancel').isVisible(), false);

    // Self-service: wrong email is refused; the right one shows renewal and allows cancelling.
    await page.goto(base + 'manage');
    await page.locator('#email').fill('someone@example.com'); await page.locator('#key').fill(key);
    await page.locator('#form button').click();
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('No license'));
    await page.locator('#email').fill('page.buyer@example.com');
    await page.locator('#form button').click();
    await page.locator('#account').waitFor({ state: 'visible' });
    assert.match(await page.locator('#period').textContent(), /Renews on/);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#cancel').click();
    await page.waitForFunction(() => document.getElementById('period').textContent.includes('Renewal cancelled'));
    assert.equal(await page.locator('#cancel').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: /buy sells the yearly plan and a 1-week pass with a stubbed Razorpay, displays and recovers keys; /manage shows the pass (no renewal), checks email and cancels yearly renewal.');
  } finally { await browser.close(); server.close(); db.close(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
