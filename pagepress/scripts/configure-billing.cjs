const fs = require('node:fs');
const path = require('node:path');
const { configured, offers } = require('../extension/licensing.js');
const usage = `Usage (all values are public; no secret keys are needed):
  India (Razorpay, via your license server):
    --server-url https://licenses.example.com --inr-price "₹799/year" [--usd-price "$19/year"]
  Outside India (Lemon Squeezy):
    --store-id NUMBER --product-id NUMBER --variant-id NUMBER --checkout-url https://STORE.lemonsqueezy.com/buy/UUID [--lemon-price "$19/year"]
Options for both stores can be combined. Use --usd-price only when Razorpay (not Lemon Squeezy) sells the USD plan.`;
const flags = ['--server-url', '--inr-price', '--usd-price', '--store-id', '--product-id', '--variant-id', '--checkout-url', '--lemon-price'];
const args = process.argv.slice(2), values = {};
for (let n = 0; n < args.length; n += 2) {
  if (!flags.includes(args[n]) || !args[n + 1]) { console.error(usage); process.exit(1); }
  values[args[n]] = args[n + 1];
}
const razorpay = values['--server-url'] ? { serverUrl: values['--server-url'], inrPriceLabel: values['--inr-price'] || '', usdPriceLabel: values['--usd-price'] || '' } : null;
const lemonsqueezy = values['--store-id'] ? { storeId: Number(values['--store-id']), productId: Number(values['--product-id']), variantId: Number(values['--variant-id']), checkoutUrl: values['--checkout-url'], priceLabel: values['--lemon-price'] || '$19/year' } : null;
const config = { razorpay, lemonsqueezy };
if (razorpay && !configured({ razorpay })) throw new Error('Supply your license server HTTPS URL and at least --inr-price.');
if (lemonsqueezy && !configured({ lemonsqueezy })) throw new Error('Supply valid Lemon Squeezy product IDs and your hosted /buy/ checkout URL.');
if (!configured(config)) { console.error(usage); process.exit(1); }
const root = path.join(__dirname, '../extension');
fs.writeFileSync(path.join(root, 'billing-config.js'), '/* Public seller settings. Never add secret API keys. */\nglobalThis.PagePressBillingConfig = Object.freeze(' + JSON.stringify(config, null, 2) + ');\n');
// Chrome only lets the extension request host access that the manifest lists as optional.
const manifestFile = path.join(root, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.optional_host_permissions = ['https://api.lemonsqueezy.com/*', ...(razorpay ? [new URL(razorpay.serverUrl).origin + '/*'] : [])];
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log('Public billing settings saved:', offers(config).map((o) => `${o.currency} ${o.priceLabel} via ${o.provider}`).join(', '));
console.log('Reload the extension and test checkout and license activation before publishing.');
