(function (root) {
  const $ = (id) => document.getElementById(id);
  let status = { plan: 'free', pageLimit: 5, configured: false, hasLicense: false, offers: [] }, pending = false, captureBusy = false;
  const enabled = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  const licensing = enabled ? PagePressLicensing.createClient({
    config: PagePressBillingConfig, storage: PagePressLicenseStore,
    hasPermission: (origin) => chrome.permissions.contains({ origins: [origin] })
  }) : null;
  // PagePress uses one universal price, shown in the buyer's currency: INR (UPI, Indian cards) for browsers set to
  // Indian time, USD elsewhere. The switch link covers travellers and anyone who prefers the other currency.
  let region = /^Asia\/(Kolkata|Calcutta)$/.test(Intl.DateTimeFormat().resolvedOptions().timeZone || '') ? 'INR' : 'USD';
  async function send(action, args = {}) {
    if (!enabled) throw new Error('Install PagePress in Chrome to manage a license.');
    switch (action) {
      case 'status': return licensing.refresh();
      case 'activate': return licensing.activate(args.key, args.email);
      case 'deactivate': return licensing.deactivate();
      case 'authorize': return licensing.authorize(args.count);
      case 'checkout': await chrome.tabs.create({ url: licensing.checkout(args.currency) }); return { opened: true };
      case 'portal': await chrome.tabs.create({ url: await licensing.portal() }); return { opened: true };
      default: throw new Error('Unknown license action.');
    }
  }
  // chrome.permissions.request must run inside the click's user gesture, before any other await.
  async function allow(origin) {
    if (!origin) return;
    if (!await chrome.permissions.request({ origins: [origin] })) throw new Error('License verification permission was not granted. Free remains available.');
  }
  function render() {
    const pro = status.plan === 'pro', locked = pending || captureBusy;
    const offer = (currency) => (status.offers || []).find((o) => o.currency === currency);
    $('plan-name').textContent = pro ? 'Pro plan' : 'Free plan';
    $('plan-summary').textContent = `Up to ${status.pageLimit} pages per capture. PDF and JPEG included.`;
    const chosen = offer(region) || (status.offers || [])[0], other = (status.offers || []).find((o) => o !== chosen);
    $('pro-price').textContent = chosen?.priceLabel || '$12/year';
    for (const [id, currency, label] of [['upgrade-inr', 'INR', 'Pay in INR'], ['upgrade', 'USD', 'Pay in USD']]) {
      const item = offer(currency), button = $(id);
      // Unconfigured builds keep one disabled "Upgrade to Pro" button.
      button.hidden = chosen ? chosen.currency !== currency : currency === 'INR';
      button.disabled = locked || !item || pro;
      button.textContent = pro ? 'Pro is active' : item ? `${label} · ${item.priceLabel}` : 'Upgrade to Pro';
    }
    $('switch-region').hidden = !other || pro;
    $('switch-region').disabled = locked;
    $('switch-region').textContent = other?.currency === 'INR' ? 'Paying from India? Pay in INR' : 'Paying from outside India? Pay in USD';
    $('activate-license').disabled = locked || !status.configured;
    $('license-email').disabled = locked; $('license-key').disabled = locked;
    $('license-form').hidden = status.hasLicense;
    $('license-details').hidden = !status.hasLicense;
    for (const id of ['refresh-license', 'manage-billing', 'deactivate-license']) $(id).disabled = locked || !status.configured;
    $('license-summary').textContent = status.hasLicense ? `License ending ${status.keySuffix}${status.expiresAt ? ' · Expires ' + new Date(status.expiresAt).toLocaleDateString() : ''}.` : '';
    $('billing-status').textContent = pending ? 'Checking your license...' : status.error || (!status.configured ? 'Pro purchases are not available yet. Free captures are ready to use.' : pro ? 'Pro is active in this browser.' : 'Use Free or upgrade for longer documents. After purchase, return here to activate your license.');
  }
  async function run(action, args) {
    if (pending || captureBusy) return;
    pending = true; render();
    try {
      const result = await send(action, args);
      if (result.plan) { status = result; root.dispatchEvent(new Event('pagepress-plan-changed')); }
      if (action === 'activate') { $('license-key').value = ''; $('license-email').value = ''; }
      return result;
    } catch (error) { status = { ...status, error: error.message }; }
    finally { pending = false; render(); }
  }
  $('plans-open').addEventListener('click', () => $('plans-dialog').showModal());
  $('plans-close').addEventListener('click', () => $('plans-dialog').close());
  $('upgrade').addEventListener('click', () => run('checkout', { currency: 'USD' }));
  $('upgrade-inr').addEventListener('click', () => run('checkout', { currency: 'INR' }));
  $('switch-region').addEventListener('click', () => { region = region === 'INR' ? 'USD' : 'INR'; render(); });
  $('manage-billing').addEventListener('click', () => run('portal'));
  $('refresh-license').addEventListener('click', async () => {
    try {
      await allow(licensing?.permissionFor({ provider: status.provider }));
      await run('status');
    } catch (error) { status = { ...status, error: error.message }; render(); }
  });
  $('license-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || captureBusy || !status.configured) return;
    try {
      const key = $('license-key').value;
      const origin = licensing?.permissionFor({ key });
      if (!origin) throw new Error(PagePressLicensing.providerForKey(key) === 'razorpay' ? 'This license key is for the India (INR) store, which is not available in this build.' : 'This license key is for the international (USD) store, which is not available in this build.');
      await allow(origin);
      await run('activate', { key, email: $('license-email').value });
    } catch (error) { status = { ...status, error: error.message }; render(); }
  });
  $('deactivate-license').addEventListener('click', () => run('deactivate'));
  const ready = run('status');
  root.PagePressBilling = {
    ready, get pageLimit() { return status.pageLimit; },
    setBusy(value) { captureBusy = value; render(); },
    openPlans() { if (!$('plans-dialog').open) $('plans-dialog').showModal(); },
    async authorize(count) {
      const result = await send('authorize', { count });
      if (result.plan) { status = result; render(); }
      return result;
    }
  };
})(globalThis);
