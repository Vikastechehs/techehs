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
    activationLimit,
    totalCount,
    sellerName: env.SELLER_NAME || 'PagePress',
    supportEmail: env.SUPPORT_EMAIL || ''
  };
}
module.exports = { loadConfig };
