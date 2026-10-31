// All secrets come from the environment and never leave this server.
function loadConfig(env = process.env) {
  const required = (name) => {
    const value = String(env[name] || '').trim();
    if (!value) throw new Error(`Missing required environment variable ${name}.`);
    return value;
  };
  const publicUrl = new URL(required('PUBLIC_URL'));
  if (publicUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(publicUrl.hostname)) throw new Error('PUBLIC_URL must use HTTPS.');
  const plans = { INR: required('RAZORPAY_PLAN_ID_INR') };
  if (env.RAZORPAY_PLAN_ID_USD) plans.USD = String(env.RAZORPAY_PLAN_ID_USD).trim();
  // One-time passes: amounts in paise/cents, e.g. PASS_WEEK_INR=19900. A pass without an amount is not sold.
  const passes = {};
  for (const [name, days] of [['week', 7], ['month', 30]]) {
    const amounts = {};
    for (const currency of ['INR', 'USD']) {
      const raw = env[`PASS_${name.toUpperCase()}_${currency}`];
      if (raw === undefined || raw === '') continue;
      const amount = Number(raw);
      if (!/^\d+$/.test(String(raw).trim()) || amount < 100) throw new Error(`PASS_${name.toUpperCase()}_${currency} must be an amount in paise/cents (at least 100).`);
      amounts[currency] = amount;
    }
    if (Object.keys(amounts).length) passes[name] = { days, amounts };
  }
  const activationLimit = Number(env.ACTIVATION_LIMIT || 2);
  const totalCount = Number(env.SUBSCRIPTION_TOTAL_COUNT || 10);
  if (!Number.isInteger(activationLimit) || activationLimit < 1 || activationLimit > 20) throw new Error('ACTIVATION_LIMIT must be an integer from 1 to 20.');
  if (!Number.isInteger(totalCount) || totalCount < 1 || totalCount > 100) throw new Error('SUBSCRIPTION_TOTAL_COUNT must be an integer from 1 to 100.');
  return {
    port: Number(env.PORT || 8787),
    publicUrl: publicUrl.href.replace(/\/?$/, '/'),
    databasePath: env.DATABASE_PATH || './data/pagepress.sqlite',
    trustProxy: env.TRUST_PROXY === '1',
    keyId: required('RAZORPAY_KEY_ID'),
    keySecret: required('RAZORPAY_KEY_SECRET'),
    webhookSecret: required('RAZORPAY_WEBHOOK_SECRET'),
    plans,
    passes,
    activationLimit,
    totalCount,
    // Only needed if the INR price is set lower than the USD price (regional pricing).
    inrIndianPaymentsOnly: env.INR_INDIAN_PAYMENTS_ONLY === '1',
    sellerName: env.SELLER_NAME || 'PagePress',
    supportEmail: env.SUPPORT_EMAIL || ''
  };
}
module.exports = { loadConfig };
