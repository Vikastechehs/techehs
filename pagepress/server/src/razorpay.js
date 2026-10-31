const crypto = require('node:crypto');

function hmac(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('hex'); }
function safeEqual(expected, received) {
  const a = Buffer.from(String(expected)), b = Buffer.from(String(received || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Checkout handler signature for subscriptions: HMAC-SHA256(payment_id + "|" + subscription_id, key_secret).
function verifyPaymentSignature(secret, paymentId, subscriptionId, signature) {
  return safeEqual(hmac(secret, `${paymentId}|${subscriptionId}`), signature);
}
// Webhooks: HMAC-SHA256 of the raw request body with the webhook secret, in X-Razorpay-Signature.
function verifyWebhookSignature(secret, rawBody, signature) {
  return safeEqual(hmac(secret, rawBody), signature);
}

function createRazorpay({ keyId, keySecret, fetcher = fetch, baseUrl = 'https://api.razorpay.com/v1/' }) {
  const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  async function call(method, route, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(baseUrl + route, {
        method, signal: controller.signal,
        headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        const error = new Error(data?.error?.description || `Razorpay request failed (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  return {
    getPlan: (id) => call('GET', `plans/${encodeURIComponent(id)}`),
    createSubscription: (body) => call('POST', 'subscriptions', body),
    getSubscription: (id) => call('GET', `subscriptions/${encodeURIComponent(id)}`),
    cancelAtCycleEnd: (id) => call('POST', `subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 1 })
  };
}
module.exports = { createRazorpay, verifyPaymentSignature, verifyWebhookSignature, hmac };
