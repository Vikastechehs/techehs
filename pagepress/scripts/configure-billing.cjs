const fs = require('node:fs');
const path = require('node:path');
const { configured } = require('../extension/licensing.js');
const args = process.argv.slice(2), values = {};
for (let n = 0; n < args.length; n += 2) {
  if (!['--store-id', '--product-id', '--variant-id', '--checkout-url'].includes(args[n]) || !args[n + 1]) throw new Error('Use --store-id NUMBER --product-id NUMBER --variant-id NUMBER --checkout-url HTTPS_URL. No secret keys are needed.');
  values[args[n]] = args[n + 1];
}
const config = { provider: 'lemonsqueezy', storeId: Number(values['--store-id']), productId: Number(values['--product-id']), variantId: Number(values['--variant-id']), checkoutUrl: values['--checkout-url'], priceLabel: '$19/year' };
if (!configured(config)) throw new Error('Supply valid public product IDs and your Lemon Squeezy hosted /buy/ checkout URL.');
fs.writeFileSync(path.join(__dirname, '../extension/billing-config.js'), '/* Public seller settings. Never add secret API keys. */\nglobalThis.PagePressBillingConfig = Object.freeze(' + JSON.stringify(config, null, 2) + ');\n');
console.log('Public billing settings saved. Reload the extension and test checkout and license activation before publishing.');
