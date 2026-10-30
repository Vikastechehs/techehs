(function (root) {
  const ORIGIN = 'https://api.lemonsqueezy.com';
  const STORAGE_KEY = 'pagepressLicense';
  const FREE_LIMIT = 5, PRO_LIMIT = 200;
  function configured(config) {
    try {
      const url = new URL(config.checkoutUrl);
      return config.provider === 'lemonsqueezy' && ['storeId', 'productId', 'variantId'].every((id) => Number.isSafeInteger(config[id]) && config[id] > 0) &&
        url.protocol === 'https:' && /^[a-z0-9-]+\.lemonsqueezy\.com$/.test(url.hostname) && /^\/buy\/[a-zA-Z0-9-]+\/?$/.test(url.pathname) && !url.username && !url.password && !url.port;
    } catch { return false; }
  }
  function assertProduct(data, config) {
    if (!data.meta || data.meta.store_id !== config.storeId || data.meta.product_id !== config.productId || data.meta.variant_id !== config.variantId) throw new Error('This license is not for PagePress Pro.');
  }
  function assertActive(data, key) {
    if (!data.license_key || data.license_key.key !== key || data.license_key.status !== 'active') throw new Error('This license is expired, disabled, or inactive.');
    const expiry = data.license_key.expires_at;
    if (expiry !== null) {
      const time = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(expiry || '') ? expiry : String(expiry).replace(' ', 'T') + 'Z');
      if (!Number.isFinite(time) || time <= Date.now()) throw new Error('This license has expired. Renew it in Manage billing.');
    }
  }
  function createClient({ config, storage, fetcher = root.fetch.bind(root), hasPermission = async () => true }) {
    let activeOperation = false;
    const isConfigured = () => configured(config);
    function requireConfig() { if (!isConfigured()) throw new Error('Pro purchases are not available yet. You can continue using Free.'); }
    async function request(action, params) {
      requireConfig();
      if (!await hasPermission()) throw new Error('Allow license verification access, then try again.');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetcher(`${ORIGIN}/v1/licenses/${action}`, {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error'
        });
        const data = await response.json();
        if (!response.ok) throw new Error(response.status === 429 ? 'Too many license requests. Please wait a minute.' : data.error || 'License verification failed.');
        return data;
      } catch (error) {
        if (error instanceof TypeError || error.name === 'AbortError') throw new Error('License service is unreachable. Check your connection and try again. Free captures remain available.');
        throw error;
      } finally { clearTimeout(timeout); }
    }
    async function record() { return (await storage.get(STORAGE_KEY))[STORAGE_KEY] || null; }
    function summary(pro, saved, error = '') {
      return { plan: pro ? 'pro' : 'free', pageLimit: pro ? PRO_LIMIT : FREE_LIMIT, configured: isConfigured(), priceLabel: config.priceLabel,
        hasLicense: !!saved, keySuffix: saved?.key?.slice(-4) || '', expiresAt: pro ? saved.expiresAt : null, error };
    }
    async function refresh() {
      const saved = await record();
      if (!saved) return summary(false, null);
      try {
        const data = await request('validate', { license_key: saved.key, instance_id: saved.instanceId });
        if (data.valid !== true) throw new Error(data.error || 'This license is no longer valid.');
        assertProduct(data, config); assertActive(data, saved.key);
        if (!saved.instanceId || data.instance?.id !== saved.instanceId) throw new Error('This browser activation is no longer valid.');
        return summary(true, { ...saved, expiresAt: data.license_key.expires_at });
      } catch (error) { return summary(false, saved, error.message); }
    }
    async function activate(inputKey, inputEmail) {
      requireConfig();
      if (activeOperation) throw new Error('A license update is already in progress.');
      activeOperation = true;
      try {
        const key = String(inputKey || '').trim(), email = String(inputEmail || '').trim().toLowerCase();
        if (!key || key.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter your license key and the email used at checkout.');
        const saved = await record();
        if (saved) {
          if (saved.key !== key || saved.email !== email) throw new Error('Deactivate the existing license before activating another one.');
          const status = await refresh(); if (status.plan !== 'pro') throw new Error(status.error); return status;
        }
        // Verify ownership and product before consuming an activation slot.
        const checked = await request('validate', { license_key: key });
        if (checked.valid !== true) throw new Error(checked.error || 'This license is not valid.');
        assertProduct(checked, config);
        if (!['active', 'inactive'].includes(checked.license_key?.status) || checked.license_key.key !== key) throw new Error('This license is expired or disabled.');
        if (String(checked.meta.customer_email || '').trim().toLowerCase() !== email) throw new Error('The email does not match this license purchase.');
        const data = await request('activate', { license_key: key, instance_name: 'PagePress browser' });
        if (data.activated !== true || typeof data.instance?.id !== 'string' || !data.instance.id) throw new Error(data.error || 'License activation failed.');
        const value = { key, email, instanceId: data.instance.id, expiresAt: data.license_key?.expires_at, activatedAt: new Date().toISOString() };
        // Retain the instance before final checks so a remote activation can still be deactivated after an error.
        await storage.set({ [STORAGE_KEY]: value });
        assertProduct(data, config); assertActive(data, key);
        if (String(data.meta.customer_email || '').trim().toLowerCase() !== email) throw new Error('The email does not match this license purchase.');
        return summary(true, value);
      } finally { activeOperation = false; }
    }
    async function deactivate() {
      if (activeOperation) throw new Error('A license update is already in progress.');
      activeOperation = true;
      try {
        const saved = await record(); if (!saved) return summary(false, null);
        const data = await request('deactivate', { license_key: saved.key, instance_id: saved.instanceId });
        if (data.deactivated !== true) throw new Error(data.error || 'Deactivation failed. Your saved license is retained for retry.');
        await storage.remove(STORAGE_KEY);
        return summary(false, null);
      } finally { activeOperation = false; }
    }
    async function authorize(count) {
      if (!Number.isInteger(count) || count < 1 || count > PRO_LIMIT) throw new Error('Choose between 1 and 200 pages.');
      if (count <= FREE_LIMIT) return { allowed: true, pageLimit: FREE_LIMIT };
      const status = await refresh();
      return { ...status, allowed: status.plan === 'pro', error: status.error || (status.plan !== 'pro' ? 'Free captures include up to 5 pages. Activate Pro for larger captures.' : '') };
    }
    function checkout() { requireConfig(); return config.checkoutUrl; }
    function portal() { requireConfig(); return new URL('/billing', config.checkoutUrl).href; }
    return { refresh, activate, deactivate, authorize, checkout, portal };
  }
  root.PagePressLicensing = { createClient, configured, FREE_LIMIT, PRO_LIMIT, ORIGIN, STORAGE_KEY };
  if (typeof module !== 'undefined') module.exports = root.PagePressLicensing;
})(globalThis);
