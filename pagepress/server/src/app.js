const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyPaymentSignature, verifyWebhookSignature } = require('./razorpay');
const { createLicenses, normalizeKey } = require('./licenses');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/buy': ['buy.html', 'text/html; charset=utf-8'],
  '/manage': ['manage.html', 'text/html; charset=utf-8'],
  '/assets/buy.js': ['buy.js', 'text/javascript; charset=utf-8'],
  '/assets/manage.js': ['manage.js', 'text/javascript; charset=utf-8'],
  '/assets/site.css': ['site.css', 'text/css; charset=utf-8']
};
// Razorpay Checkout loads its script from checkout.razorpay.com and frames/requests from razorpay.com hosts.
const PAGE_CSP = "default-src 'self'; script-src 'self' https://checkout.razorpay.com; frame-src https://*.razorpay.com; connect-src 'self' https://*.razorpay.com; img-src 'self' data: https://*.razorpay.com; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function rateLimiter(limit, windowMs = 60000) {
  const hits = new Map();
  return (key, t = Date.now()) => {
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) { hits.set(key, { start: t, count: 1 }); if (hits.size > 50000) hits.clear(); return true; }
    return ++entry.count <= limit;
  };
}

function createApp({ config, db, razorpay, now }) {
  const licenses = createLicenses({ db, config, razorpay, now });
  const perMinute = { license: 60, checkout: 10, manage: 20, ...config.rateLimits };
  const limits = { license: rateLimiter(perMinute.license), checkout: rateLimiter(perMinute.checkout), manage: rateLimiter(perMinute.manage) };
  const q = {
    checkout: db.prepare('SELECT * FROM checkouts WHERE subscription_id = ?'),
    addCheckout: db.prepare('INSERT INTO checkouts (subscription_id, email, currency, claim_hash, created_at) VALUES (?, ?, ?, ?, ?)'),
    reject: db.prepare('UPDATE checkouts SET rejected = 1 WHERE subscription_id = ?'),
    seenEvent: db.prepare('SELECT 1 FROM webhook_events WHERE id = ?'),
    recordEvent: db.prepare('INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES (?, ?)')
  };
  const plans = new Map();
  async function plan(currency) {
    const id = config.plans[currency];
    if (!id) return null;
    if (!plans.has(id)) {
      const p = await razorpay.getPlan(id);
      plans.set(id, { id, currency: p.item.currency, amount: p.item.amount, name: p.item.name, period: p.period, interval: p.interval });
    }
    return plans.get(id);
  }

  function send(res, status, body, headers = {}) {
    const json = typeof body !== 'string';
    res.writeHead(status, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(json ? JSON.stringify(body) : body);
  }
  function readBody(req, max = 65536) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      // Oversized bodies are drained and discarded so the client still receives the 413 response.
      req.on('data', (chunk) => { size += chunk.length; if (size <= max) chunks.push(chunk); });
      req.on('end', () => size > max ? reject(Object.assign(new Error('Request too large.'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  function parse(raw, type = '') {
    if (type.includes('application/json')) { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
    return Object.fromEntries(new URLSearchParams(raw));
  }
  const clientIp = (req) => (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  // Start a Razorpay subscription for the buyer's email; the claim token later proves this browser started it.
  async function startCheckout(body) {
    const email = String(body.email || '').trim().toLowerCase(), currency = String(body.currency || 'INR').toUpperCase();
    if (!EMAIL.test(email) || email.length > 254) return [400, { error: 'Enter a valid email address.' }];
    const p = await plan(currency);
    if (!p) return [400, { error: `Payments in ${currency} are not available.` }];
    const subscription = await razorpay.createSubscription({
      plan_id: p.id, total_count: config.totalCount, quantity: 1, customer_notify: 1,
      notify_info: { notify_email: email }, notes: { product: 'pagepress-pro', email }
    });
    const claim = crypto.randomBytes(32).toString('base64url');
    q.addCheckout.run(subscription.id, email, currency, sha256(claim), Math.floor(Date.now() / 1000));
    return [200, { key_id: config.keyId, subscription_id: subscription.id, claim_token: claim, email, name: config.sellerName,
      description: `PagePress Pro · ${p.name}`, currency: p.currency, amount: p.amount }];
  }
  const REGION_ERROR = 'The India price needs an Indian UPI, card or bank account. Your international card payment has been refunded; please buy the USD plan instead.';
  // Optional (INR_INDIAN_PAYMENTS_ONLY=1), for regional pricing where INR is cheaper than USD: an international card
  // on the INR plan gets no license; the payment is refunded and the subscription cancelled. Off with a universal price.
  async function regionAllowed(checkout, currency, payment) {
    if (!config.inrIndianPaymentsOnly || currency !== 'INR' || !payment?.international) return true;
    if (checkout) q.reject.run(checkout.subscription_id);
    const subscriptionId = checkout?.subscription_id || payment.subscription_id;
    for (const [step, action] of [['refund', () => razorpay.refundPayment(payment.id)], ['cancel', () => razorpay.cancelNow(subscriptionId)]]) {
      try { await action(); } catch (error) { console.error(new Date().toISOString(), `Regional ${step} failed for ${payment.id}; handle it in the Razorpay dashboard.`, error.message); }
    }
    return false;
  }
  // Return the license for a checkout this browser started. A valid payment signature issues it immediately;
  // without one (for example after closing the tab) the license appears once Razorpay's webhook arrives.
  async function claim(body) {
    const checkout = q.checkout.get(String(body.subscription_id || ''));
    if (!checkout || !body.claim_token || sha256(String(body.claim_token)) !== checkout.claim_hash) return [403, { error: 'This checkout could not be found.' }];
    if (checkout.rejected) return [403, { error: REGION_ERROR }];
    let license = licenses.bySubscription(checkout.subscription_id);
    if (!license && body.razorpay_payment_id) {
      if (body.razorpay_subscription_id !== checkout.subscription_id || !verifyPaymentSignature(config.keySecret, String(body.razorpay_payment_id), checkout.subscription_id, body.razorpay_signature)) {
        return [400, { error: 'Payment verification failed. If you were charged, contact support with your payment ID.' }];
      }
      if (!await regionAllowed(checkout, checkout.currency, await razorpay.getPayment(String(body.razorpay_payment_id)))) return [403, { error: REGION_ERROR }];
      license = licenses.issue({ subscription: await razorpay.getSubscription(checkout.subscription_id), email: checkout.email, currency: checkout.currency });
    }
    if (!license) return [202, { pending: true, error: 'Payment confirmation has not arrived yet. Try again in a minute.' }];
    return [200, { license_key: license.key, email: license.email, expires_at: license.expires_at ? new Date(license.expires_at * 1000).toISOString() : null }];
  }
  async function webhook(raw, headers) {
    if (!verifyWebhookSignature(config.webhookSecret, raw, headers['x-razorpay-signature'])) return [400, { error: 'Invalid signature.' }];
    const eventId = String(headers['x-razorpay-event-id'] || '');
    if (eventId && q.seenEvent.get(eventId)) return [200, { ok: true, duplicate: true }];
    let event;
    try { event = JSON.parse(raw); } catch { return [400, { error: 'Invalid JSON.' }]; }
    const subscription = event?.payload?.subscription?.entity;
    if (!String(event?.event || '').startsWith('subscription.') || !subscription?.id) return [200, { ok: true, ignored: true }];
    if (subscription.notes?.product && subscription.notes.product !== 'pagepress-pro') return [200, { ok: true, ignored: true }];
    if (!licenses.bySubscription(subscription.id) && ['subscription.activated', 'subscription.charged'].includes(event.event)) {
      const checkout = q.checkout.get(subscription.id);
      const email = checkout?.email || subscription.notes?.email;
      const currency = checkout?.currency || Object.keys(config.plans).find((c) => config.plans[c] === subscription.plan_id);
      const payment = event.payload.payment?.entity;
      // With the regional rule on, INR licenses wait for subscription.charged, which carries the payment to check.
      const checkable = !config.inrIndianPaymentsOnly || currency !== 'INR' || payment;
      if (email && currency && checkable && !checkout?.rejected && await regionAllowed(checkout, currency, payment)) licenses.issue({ subscription, email, currency });
    } else licenses.sync(subscription);
    // Record the event only after processing, so a failed attempt is processed again on Razorpay's retry.
    if (eventId) q.recordEvent.run(eventId, Math.floor(Date.now() / 1000));
    return [200, { ok: true }];
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const ip = clientIp(req);
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, file), 'utf8'), { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': PAGE_CSP, 'Referrer-Policy': 'no-referrer' });
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/offer') {
        const p = await plan(String(url.searchParams.get('currency') || 'INR').toUpperCase());
        return p ? send(res, 200, { currency: p.currency, amount: p.amount, name: p.name, period: p.period, interval: p.interval, supportEmail: config.supportEmail, indianPaymentsOnly: config.inrIndianPaymentsOnly && p.currency === 'INR' })
          : send(res, 404, { error: 'This currency is not available.' });
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'Not found.' });
      const raw = await readBody(req);
      if (url.pathname === '/api/razorpay/webhook') return send(res, ...await webhook(raw, req.headers));
      const body = parse(raw, String(req.headers['content-type'] || ''));
      const license = /^\/v1\/licenses\/(validate|activate|deactivate)$/.exec(url.pathname);
      if (license) {
        if (!limits.license(ip)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
        const key = normalizeKey(body.license_key);
        if (!key || key.length > 64) return send(res, 400, { error: 'license_key is required.' });
        if (license[1] === 'validate') return send(res, ...await licenses.validate(key, String(body.instance_id || '')));
        if (license[1] === 'activate') return send(res, ...await licenses.activate(key, body.instance_name));
        return send(res, ...licenses.deactivate(key, String(body.instance_id || '')));
      }
      if (url.pathname === '/api/checkout' || url.pathname === '/api/checkout/claim') {
        if (!limits.checkout(ip)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
        return send(res, ...await (url.pathname === '/api/checkout' ? startCheckout(body) : claim(body)));
      }
      const manage = /^\/api\/manage\/(status|cancel|release)$/.exec(url.pathname);
      if (manage) {
        if (!limits.manage(ip)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
        if (manage[1] === 'release' && licenses.release(body.license_key, body.email, body.instance_id) === null) return send(res, 404, { error: 'No license matches that key and email.' });
        const result = manage[1] === 'cancel' ? await licenses.cancelRenewal(body.license_key, body.email) : await licenses.account(body.license_key, body.email);
        return result ? send(res, 200, result) : send(res, 404, { error: 'No license matches that key and email.' });
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (error.status === 413) return send(res, 413, { error: error.message });
      console.error(new Date().toISOString(), req.method, url.pathname, error.message);
      return send(res, 502, { error: 'The payment service is temporarily unavailable. Please try again.' });
    }
  };
}
module.exports = { createApp };
