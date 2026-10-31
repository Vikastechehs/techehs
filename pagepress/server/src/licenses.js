const crypto = require('node:crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RESYNC_SECONDS = 3600;
const PROVISIONAL_SECONDS = 366 * 86400;

// PP- plus four groups of five base32 characters: 100 random bits, and recognisable to the extension.
function newKey() {
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => BASE32[crypto.randomInt(32)]).join(''));
  return 'PP-' + groups.join('-');
}
// Keys are base32 (no 0, 1 or 8): accept lowercase and typed look-alikes.
function normalizeKey(key) {
  const value = String(key || '').trim();
  return /^pp-/i.test(value) ? value.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B') : value;
}
const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);

// Razorpay subscription status -> license status. "pending" means a renewal charge is being retried;
// the period already paid for stays valid because expires_at still bounds access.
function licenseStatus(subscription) {
  if (['active', 'authenticated', 'pending', 'resumed'].includes(subscription.status)) return 'active';
  if (['halted', 'cancelled', 'completed', 'expired', 'paused'].includes(subscription.status)) return 'expired';
  return null;
}

function createLicenses({ db, config, razorpay, now = () => Math.floor(Date.now() / 1000) }) {
  const q = {
    license: db.prepare('SELECT * FROM licenses WHERE key = ?'),
    byPurchase: db.prepare('SELECT * FROM licenses WHERE purchase_id = ?'),
    insert: db.prepare(`INSERT INTO licenses (key, purchase_id, plan, email, currency, status, expires_at, activation_limit, synced_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    sync: db.prepare('UPDATE licenses SET status = ?, expires_at = ?, synced_at = ? WHERE purchase_id = ? AND status != \'disabled\''),
    cancelRenewal: db.prepare('UPDATE licenses SET renewal_cancelled = 1 WHERE key = ?'),
    instance: db.prepare('SELECT * FROM instances WHERE id = ? AND license_key = ? AND revoked_at IS NULL'),
    instances: db.prepare('SELECT * FROM instances WHERE license_key = ? AND revoked_at IS NULL ORDER BY created_at'),
    usage: db.prepare('SELECT COUNT(*) AS n FROM instances WHERE license_key = ? AND revoked_at IS NULL'),
    addInstance: db.prepare('INSERT INTO instances (id, license_key, name, created_at) VALUES (?, ?, ?, ?)'),
    revoke: db.prepare('UPDATE instances SET revoked_at = ? WHERE id = ? AND license_key = ? AND revoked_at IS NULL')
  };

  function effectiveStatus(license) {
    if (license.status === 'active' && license.expires_at !== null && license.expires_at <= now()) return 'expired';
    return license.status;
  }
  function view(license, instance = null) {
    return {
      license_key: {
        status: effectiveStatus(license), key: license.key, activation_limit: license.activation_limit,
        activation_usage: q.usage.get(license.key).n, created_at: iso(license.created_at), expires_at: iso(license.expires_at)
      },
      instance: instance ? { id: instance.id, name: instance.name, created_at: iso(instance.created_at) } : null,
      meta: { store: 'pagepress', product: 'pagepress-pro', provider: 'razorpay', plan: license.plan, currency: license.currency, customer_email: license.email }
    };
  }

  function insert(purchaseId, plan, email, currency, expiresAt) {
    const t = now(), key = newKey();
    q.insert.run(key, purchaseId, plan, String(email).trim().toLowerCase(), currency, 'active', expiresAt, config.activationLimit, t, t);
    return q.license.get(key);
  }
  // Create the license for a paid yearly subscription exactly once; later calls return the existing license.
  function issue({ subscription, email, currency }) {
    const existing = q.byPurchase.get(subscription.id);
    if (existing) return existing;
    if (licenseStatus(subscription) !== 'active') return null;
    return insert(subscription.id, 'year', email, currency, subscription.current_end || now() + PROVISIONAL_SECONDS);
  }
  // A one-time pass (1 week or 1 month) runs from payment and never renews.
  function issuePass({ orderId, plan, days, email, currency }) {
    return q.byPurchase.get(orderId) || insert(orderId, plan, email, currency, now() + days * 86400);
  }
  function sync(subscription) {
    const license = q.byPurchase.get(subscription.id);
    const status = licenseStatus(subscription);
    if (!license || !status) return license || null;
    const expires = status === 'active' ? subscription.current_end || license.expires_at : Math.min(license.expires_at || now(), subscription.ended_at || now());
    q.sync.run(status, expires, now(), subscription.id);
    return q.byPurchase.get(subscription.id);
  }
  // A missed renewal webhook must not cut off a paying customer: re-read the subscription at most hourly.
  async function current(key) {
    let license = q.license.get(key);
    if (license && license.plan === 'year' && effectiveStatus(license) === 'expired' && license.status === 'active' && now() - license.synced_at > RESYNC_SECONDS) {
      try { sync(await razorpay.getSubscription(license.purchase_id)); } catch { /* Keep the stored state when Razorpay is unreachable. */ }
      license = q.license.get(key);
    }
    return license;
  }

  async function validate(key, instanceId) {
    const license = await current(key);
    if (!license) return [404, { valid: false, error: 'license_key not found.', license_key: null, instance: null, meta: null }];
    let instance = null;
    if (instanceId) {
      instance = q.instance.get(instanceId, key);
      if (!instance) return [404, { valid: false, error: 'instance_id not found.', ...view(license) }];
    }
    const status = effectiveStatus(license);
    return [200, { valid: status === 'active', error: status === 'active' ? null : `This license key is ${status}.`, ...view(license, instance) }];
  }
  async function activate(key, name) {
    const license = await current(key);
    if (!license) return [404, { activated: false, error: 'license_key not found.', license_key: null, instance: null, meta: null }];
    const status = effectiveStatus(license);
    if (status !== 'active') return [400, { activated: false, error: `This license key is ${status}.`, ...view(license) }];
    // Check and insert in one transaction so parallel activations cannot exceed the limit.
    db.exec('BEGIN IMMEDIATE');
    let instance;
    try {
      if (q.usage.get(key).n >= license.activation_limit) { db.exec('ROLLBACK'); return [400, { activated: false, error: 'This license key has reached the activation limit.', ...view(license) }]; }
      const id = crypto.randomUUID();
      q.addInstance.run(id, key, String(name || 'Browser').slice(0, 80), now());
      db.exec('COMMIT');
      instance = q.instance.get(id, key);
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* already closed */ } throw error; }
    return [200, { activated: true, error: null, ...view(license, instance) }];
  }
  function deactivate(key, instanceId) {
    const license = q.license.get(key);
    if (!license) return [404, { deactivated: false, error: 'license_key not found.', license_key: null, meta: null }];
    if (!instanceId || !q.revoke.run(now(), instanceId, key).changes) return [404, { deactivated: false, error: 'instance_id not found.', ...view(license) }];
    return [200, { deactivated: true, error: null, ...view(license) }];
  }

  // Customer self-service: the key and checkout email together identify the owner.
  function owned(key, email) {
    const license = q.license.get(normalizeKey(key));
    return license && license.email === String(email || '').trim().toLowerCase() ? license : null;
  }
  async function account(key, email) {
    const found = owned(key, email);
    if (!found) return null;
    const license = await current(found.key);
    return { status: effectiveStatus(license), plan: license.plan, renews: license.plan === 'year' && !license.renewal_cancelled, currency: license.currency,
      expires_at: iso(license.expires_at), renewal_cancelled: !!license.renewal_cancelled,
      activation_limit: license.activation_limit,
      instances: q.instances.all(license.key).map((i) => ({ id: i.id, name: i.name, created_at: iso(i.created_at) })) };
  }
  async function cancelRenewal(key, email) {
    const license = owned(key, email);
    if (!license) return null;
    if (license.plan === 'year' && !license.renewal_cancelled) {
      await razorpay.cancelAtCycleEnd(license.purchase_id);
      q.cancelRenewal.run(license.key);
    }
    return account(key, email);
  }
  function release(key, email, instanceId) {
    const license = owned(key, email);
    if (!license) return null;
    return q.revoke.run(now(), String(instanceId || ''), license.key).changes > 0;
  }

  return { issue, issuePass, sync, validate, activate, deactivate, account, cancelRenewal, release, licenseStatus, byPurchase: (id) => q.byPurchase.get(id) };
}
module.exports = { createLicenses, newKey, licenseStatus, normalizeKey };
