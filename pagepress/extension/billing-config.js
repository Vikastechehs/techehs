/* Public seller settings only. See BILLING-SETUP.md. Never put secret API keys here. */
globalThis.PagePressBillingConfig = Object.freeze({
  // One universal price, shown in the buyer's currency: e.g. ₹999/year in India, US$12/year elsewhere.
  // India: INR yearly subscription through Razorpay, licensed by your PagePress license server (server/).
  razorpay: { serverUrl: '', inrPriceLabel: '', usdPriceLabel: '' },
  // Outside India: USD yearly subscription through Lemon Squeezy.
  lemonsqueezy: { storeId: null, productId: null, variantId: null, checkoutUrl: '', priceLabel: '$12/year' }
});
