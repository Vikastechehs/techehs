(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const currency = (params.get('currency') || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
  const plan = ['week', 'month'].includes(params.get('plan')) ? params.get('plan') : 'year';
  const STORE = 'pagepress-checkout';
  const post = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) throw new Error(data.error || 'Something went wrong. Please try again.');
    return { status: response.status, data };
  };
  const message = (text, error = false) => { $('message').textContent = text; $('message').className = error ? 'error' : 'muted'; };
  // The checkout id and claim token stay in this browser so the key can be shown again after a closed tab.
  const saved = () => { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; } };
  const remember = (value) => { try { localStorage.setItem(STORE, JSON.stringify(value)); } catch { /* private window */ } };
  function show(result) {
    $('offer').hidden = true; $('done').hidden = false;
    $('key').textContent = result.license_key; $('done-email').textContent = result.email;
  }
  async function claim(extra = {}) {
    const pending = saved();
    if (!pending) return;
    const { status, data } = await post('api/checkout/claim', { purchase_id: pending.purchase_id || pending.subscription_id, claim_token: pending.claim_token, ...extra });
    if (status === 202) { message(data.error); return false; }
    remember({ ...pending, license_key: data.license_key });
    show(data); return true;
  }
  async function confirm(response, attempt = 0) {
    try {
      if (await claim(response) === false && attempt < 10) setTimeout(() => confirm({}, attempt + 1), 6000);
    } catch (error) { message(error.message, true); }
  }
  fetch(`api/offer?currency=${currency}&plan=${plan}`).then((r) => r.json().then((d) => r.ok ? d : Promise.reject(new Error(d.error)))).then((offer) => {
    const amount = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: offer.currency, maximumFractionDigits: offer.amount % 100 ? 2 : 0 }).format(offer.amount / 100);
    if (offer.recurring) {
      const every = offer.interval > 1 ? `${offer.interval} ${offer.period.replace(/ly$/, '')}s` : { yearly: 'year', monthly: 'month', weekly: 'week', daily: 'day' }[offer.period] || offer.period;
      $('price').textContent = `${amount} / ${every}`;
    } else {
      $('price').textContent = `${amount} · ${offer.days} days`;
      $('renewal').textContent = `One-time payment for ${offer.days} days of Pro. It does not renew, and nothing is charged again.`;
    }
    $('plan-name').textContent = offer.name;
    if (offer.supportEmail) $('support').textContent = 'Help with a purchase: ' + offer.supportEmail;
    if (offer.indianPaymentsOnly) $('renewal').textContent += ' India price: pay with an Indian UPI ID, card or bank account. International cards are refunded.';
    $('pay').disabled = false;
  }).catch((error) => message(error.message || 'Payments are not available right now.', true));
  // Link the other plans in the same currency.
  const links = [['week', '1 week'], ['month', '1 month'], ['year', '1 year']].filter(([p]) => p !== plan).map(([p, label]) => `<a href="buy?currency=${currency}&plan=${p}">${label}</a>`);
  $('other-plans').innerHTML = 'Other options: ' + links.join(' · ');
  if (saved()?.claim_token) $('recover').hidden = false;
  $('recover').addEventListener('click', () => claim().catch((error) => message(error.message, true)));
  $('copy').addEventListener('click', async () => { await navigator.clipboard.writeText($('key').textContent); $('copy').textContent = 'Copied'; });
  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('pay').disabled = true; message('Opening secure payment…');
    try {
      if (typeof Razorpay !== 'function') throw new Error('The Razorpay payment window could not load. Check your connection or disable blockers for this page.');
      const { data } = await post('api/checkout', { email: $('email').value, currency, plan });
      remember({ purchase_id: data.purchase_id, claim_token: data.claim_token });
      // Yearly Pro is a Razorpay subscription; 1-week and 1-month passes are one-time orders.
      const purchase = data.subscription_id ? { subscription_id: data.subscription_id } : { order_id: data.order_id, amount: data.amount, currency: data.currency };
      const checkout = new Razorpay({
        key: data.key_id, ...purchase, name: data.name, description: data.description,
        prefill: { email: data.email }, notes: { product: 'pagepress-pro' }, theme: { color: '#203e33' },
        handler: (response) => { message('Payment received. Preparing your license…'); confirm(response); },
        modal: { ondismiss: () => { $('pay').disabled = false; message('Payment was not completed. You can try again.'); } }
      });
      checkout.on('payment.failed', (response) => { $('pay').disabled = false; message(response.error?.description || 'Payment failed. You were not charged.', true); });
      checkout.open(); message('');
    } catch (error) { $('pay').disabled = false; message(error.message, true); }
  });
})();
