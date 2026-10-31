/* Public seller settings only. See BILLING-SETUP.md. Never put secret API keys here. */
globalThis.PagePressBillingConfig = Object.freeze({
  // One price worldwide, shown in the buyer's currency. Plans: 1-week and 1-month one-time passes, and a yearly subscription.
  // India (INR): Razorpay, licensed by your PagePress license server (server/). Labels only; amounts are set on the server.
  razorpay: { serverUrl: '', prices: { INR: {}, USD: {} } },
  // Outside India (USD): Lemon Squeezy. Each plan is a product variant: { productId, variantId, checkoutUrl, priceLabel }.
  lemonsqueezy: { storeId: null, plans: {} }
});
