(function (root) {
  const LEMON_ORIGIN = 'https://api.lemonsqueezy.com';
  const STORAGE_KEY = 'pagepressLicense';
  const FREE_LIMIT = 5, PRO_LIMIT = 200;
  // Keys issued by the PagePress license server (Razorpay purchases) carry this prefix; Lemon Squeezy keys do not.
  const SERVER_KEY = /^PP(-[A-Z2-7]{5}){4}$/;
  const PLANS = ['week', 'month', 'year'];
  function lemonPlanValid(plan) {
    try {
      const url = new URL(plan.checkoutUrl);
      return ['productId', 'variantId'].every((id) => Number.isSafeInteger(plan[id]) && plan[id] > 0) &&
        url.protocol === 'https:' && /^[a-z0-9-]+\.lemonsqueezy\.com$/.test(url.hostname) && /^\/buy\/[a-zA-Z0-9-]+\/?$/.test(url.pathname) && !url.username && !url.password && !url.port;
    } catch { return false; }
  }
  // Lemon Squeezy plans that are fully configured: the yearly subscription and/or 1-week and 1-month passes
  // (one-time products whose license keys expire after 7 or 30 days).
  function lemonPlans(c) {
    if (!c || !Number.isSafeInteger(c.storeId) || c.storeId <= 0) return {};
    return Object.fromEntries(PLANS.filter((p) => c.plans?.[p] && lemonPlanValid(c.plans[p])).map((p) => [p, c.plans[p]]));
  }
  function serverBase(config) {
    try {
      const url = new URL(config.serverUrl);
      const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash) return null;
      return url.href.replace(/\/?$/, '/');
    } catch { return null; }
  }
  const providers = {
    lemonsqueezy: {
      configured: (c) => Object.keys(lemonPlans(c)).length > 0,
      base: () => LEMON_ORIGIN + '/',
      origin: () => LEMON_ORIGIN + '/*',
      assertProduct(data, c) {
        const ok = data.meta && data.meta.store_id === c.storeId &&
          Object.values(lemonPlans(c)).some((p) => data.meta.product_id === p.productId && data.meta.variant_id === p.variantId);
        if (!ok) throw new Error('This license is not for PagePress Pro.');
      },
      checkout: (c, currency, plan) => lemonPlans(c)[plan]?.checkoutUrl,
      planOf: (data, c) => Object.entries(lemonPlans(c)).find(([, p]) => p.variantId === data.meta?.variant_id)?.[0] || 'year',
      portal: (c) => new URL('/billing', Object.values(lemonPlans(c))[0].checkoutUrl).href
    },
    razorpay: {
      configured: (c) => !!c && !!serverBase(c) && Object.values(c.prices || {}).some((labels) => PLANS.some((p) => labels?.[p])),
      base: (c) => serverBase(c),
      origin: (c) => new URL(serverBase(c)).origin + '/*',
      assertProduct(data) {
        if (!data.meta || data.meta.store !== 'pagepress' || data.meta.product !== 'pagepress-pro' || data.meta.provider !== 'razorpay') throw new Error('This license is not for PagePress Pro.');
      },
      checkout: (c, currency, plan) => serverBase(c) + `buy?currency=${currency}&plan=${plan}`,
      planOf: (data) => (PLANS.includes(data.meta?.plan) ? data.meta.plan : 'year'),
      portal: (c) => serverBase(c) + 'manage'
    }
  };
  // Accepts the current shape and older ones: a flat Lemon Squeezy object (0.3), or single yearly labels/IDs (0.4.0).
  function normalize(config = {}) {
    const flatLemon = config.provider === 'lemonsqueezy' ? config : null;
    let lemon = config.lemonsqueezy || flatLemon || null, rzp = config.razorpay || null;
    if (lemon && !lemon.plans && (lemon.variantId || lemon.checkoutUrl)) {
      lemon = { storeId: lemon.storeId, plans: { year: { productId: lemon.productId, variantId: lemon.variantId, checkoutUrl: lemon.checkoutUrl, priceLabel: lemon.priceLabel } } };
    }
    if (rzp && !rzp.prices) {
      rzp = { serverUrl: rzp.serverUrl, prices: { INR: rzp.inrPriceLabel ? { year: rzp.inrPriceLabel } : {}, USD: rzp.usdPriceLabel ? { year: rzp.usdPriceLabel } : {} } };
    }
    return { lemonsqueezy: lemon, razorpay: rzp };
  }
  function configured(config) {
    const c = normalize(config);
    return providers.lemonsqueezy.configured(c.lemonsqueezy) || providers.razorpay.configured(c.razorpay);
  }
  // INR is sold through Razorpay; USD through Lemon Squeezy when configured, otherwise through Razorpay.
  // Each offer is one plan (week, month or year) in one currency.
  function offers(config) {
    const c = normalize(config), list = [];
    const rzp = providers.razorpay.configured(c.razorpay), lemon = lemonPlans(c.lemonsqueezy);
    const add = (currency, provider, labels) => PLANS.forEach((plan) => labels?.[plan] && list.push({ currency, provider, plan, priceLabel: labels[plan] }));
    if (rzp) add('INR', 'razorpay', c.razorpay.prices.INR);
    if (Object.keys(lemon).length) add('USD', 'lemonsqueezy', Object.fromEntries(Object.entries(lemon).map(([p, v]) => [p, v.priceLabel || p])));
    else if (rzp) add('USD', 'razorpay', c.razorpay.prices.USD);
    return list;
  }
  // Server keys use base32 (no 0, 1 or 8), so typed look-alikes and lowercase can be corrected safely.
  function normalizeKey(key) {
    const value = String(key || '').trim();
    return /^pp-/i.test(value) ? value.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B') : value;
  }
  function providerForKey(key) { return SERVER_KEY.test(normalizeKey(key)) ? 'razorpay' : 'lemonsqueezy'; }
  function assertActive(data, key) {
    if (!data.license_key || data.license_key.key !== key || data.license_key.status !== 'active') throw new Error('This license is expired, disabled, or inactive.');
    const expiry = data.license_key.expires_at;
    if (expiry !== null) {
      const time = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(expiry || '') ? expiry : String(expiry).replace(' ', 'T') + 'Z');
      if (!Number.isFinite(time) || time <= Date.now()) throw new Error('This license has expired. Renew it in Manage billing.');
    }
  }
  function createClient({ config: rawConfig, storage, fetcher = root.fetch.bind(root), hasPermission = async () => true }) {
    const config = normalize(rawConfig);
    let activeOperation = false;
    const isConfigured = () => configured(config);
    function provider(name) {
      const p = providers[name];
      if (!p || !p.configured(config[name])) throw new Error(name === 'razorpay' && providers.lemonsqueezy.configured(config.lemonsqueezy) ?
        'This license key is for the India (INR) store, which is not available in this build.' : 'Pro purchases are not available yet. You can continue using Free.');
      return { ...p, config: config[name] };
    }
    async function request(name, action, params) {
      const p = provider(name);
      if (!await hasPermission(p.origin(p.config))) throw new Error('Allow license verification access, then try again.');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetcher(`${p.base(p.config)}v1/licenses/${action}`, {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error'
        });
        let data;
        try { data = await response.json(); } catch { data = null; }
        if (!data || typeof data !== 'object') throw new Error(response.ok ? 'The license service returned an unreadable response. Try again later.' : `License service error (HTTP ${response.status}). Try again later. Free captures remain available.`);
        if (!response.ok) throw new Error(response.status === 429 ? 'Too many license requests. Please wait a minute.' : data.error || 'License verification failed.');
        return data;
      } catch (error) {
        if (error instanceof TypeError || error.name === 'AbortError') throw new Error('License service is unreachable. Check your connection and try again. Free captures remain available.');
        throw error;
      } finally { clearTimeout(timeout); }
    }
    async function record() {
      const saved = (await storage.get(STORAGE_KEY))[STORAGE_KEY] || null;
      return saved && { ...saved, provider: saved.provider || 'lemonsqueezy' };
    }
    function summary(pro, saved, error = '') {
      return { plan: pro ? 'pro' : 'free', pageLimit: pro ? PRO_LIMIT : FREE_LIMIT, configured: isConfigured(), offers: offers(config), provider: saved?.provider || null, licensePlan: pro ? saved.plan || 'year' : null,
        hasLicense: !!saved, keySuffix: saved?.key?.slice(-4) || '', expiresAt: pro ? saved.expiresAt : null, error };
    }
    async function refresh() {
      const saved = await record();
      if (!saved) return summary(false, null);
      try {
        const p = provider(saved.provider);
        const data = await request(saved.provider, 'validate', { license_key: saved.key, instance_id: saved.instanceId });
        if (data.valid !== true) throw new Error(data.error || 'This license is no longer valid.');
        p.assertProduct(data, p.config); assertActive(data, saved.key);
        if (!saved.instanceId || data.instance?.id !== saved.instanceId) throw new Error('This browser activation is no longer valid.');
        return summary(true, { ...saved, expiresAt: data.license_key.expires_at, plan: p.planOf(data, p.config) });
      } catch (error) { return summary(false, saved, error.message); }
    }
    async function activate(inputKey, inputEmail) {
      if (!isConfigured()) throw new Error('Pro purchases are not available yet. You can continue using Free.');
      if (activeOperation) throw new Error('A license update is already in progress.');
      activeOperation = true;
      try {
        const key = normalizeKey(inputKey), email = String(inputEmail || '').trim().toLowerCase();
        if (!key || key.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter your license key and the email used at checkout.');
        const saved = await record();
        if (saved) {
          if (saved.key !== key || saved.email !== email) throw new Error('Deactivate the existing license before activating another one.');
          const status = await refresh(); if (status.plan !== 'pro') throw new Error(status.error); return status;
        }
        const name = providerForKey(key), p = provider(name);
        // Verify ownership and product before consuming an activation slot.
        const checked = await request(name, 'validate', { license_key: key });
        if (checked.valid !== true) throw new Error(checked.error || 'This license is not valid.');
        p.assertProduct(checked, p.config);
        if (!['active', 'inactive'].includes(checked.license_key?.status) || checked.license_key.key !== key) throw new Error('This license is expired or disabled.');
        if (String(checked.meta.customer_email || '').trim().toLowerCase() !== email) throw new Error('The email does not match this license purchase.');
        const data = await request(name, 'activate', { license_key: key, instance_name: 'PagePress browser' });
        if (data.activated !== true || typeof data.instance?.id !== 'string' || !data.instance.id) throw new Error(data.error || 'License activation failed.');
        const value = { provider: name, key, email, instanceId: data.instance.id, expiresAt: data.license_key?.expires_at, plan: p.planOf(data, p.config), activatedAt: new Date().toISOString() };
        // Retain the instance before final checks so a remote activation can still be deactivated after an error.
        await storage.set({ [STORAGE_KEY]: value });
        p.assertProduct(data, p.config); assertActive(data, key);
        if (String(data.meta.customer_email || '').trim().toLowerCase() !== email) throw new Error('The email does not match this license purchase.');
        return summary(true, value);
      } finally { activeOperation = false; }
    }
    async function deactivate() {
      if (activeOperation) throw new Error('A license update is already in progress.');
      activeOperation = true;
      try {
        const saved = await record(); if (!saved) return summary(false, null);
        const data = await request(saved.provider, 'deactivate', { license_key: saved.key, instance_id: saved.instanceId });
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
    function checkout(currency = 'USD', plan = 'year') {
      const offer = offers(config).find((o) => o.currency === currency && o.plan === plan);
      if (!offer) throw new Error('This plan is not available yet. You can continue using Free.');
      const p = provider(offer.provider);
      return p.checkout(p.config, currency, plan);
    }
    async function portal() {
      const saved = await record();
      const name = saved?.provider || offers(config)[0]?.provider;
      if (!name) throw new Error('Pro purchases are not available yet. You can continue using Free.');
      const p = provider(name);
      return p.portal(p.config);
    }
    // The host permission a license operation needs: for a key being activated, or for the saved license's provider.
    function permissionFor({ key, provider: name } = {}) {
      if (key) name = providerForKey(key);
      const p = providers[name];
      return p && p.configured(config[name]) ? p.origin(config[name]) : null;
    }
    return { refresh, activate, deactivate, authorize, checkout, portal, permissionFor };
  }
  root.PagePressLicensing = { createClient, configured, offers, providerForKey, normalize, PLANS, FREE_LIMIT, PRO_LIMIT, ORIGIN: LEMON_ORIGIN, STORAGE_KEY };
  if (typeof module !== 'undefined') module.exports = root.PagePressLicensing;
})(globalThis);
