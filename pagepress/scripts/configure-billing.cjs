const fs = require('node:fs');
const path = require('node:path');
const { configured, offers, normalize } = require('../extension/licensing.js');
// Usage: node scripts/configure-billing.cjs billing.json   (see scripts/billing.example.json; public values only)
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/configure-billing.cjs billing.json  (start from scripts/billing.example.json)'); process.exit(1); }
const input = JSON.parse(fs.readFileSync(file, 'utf8'));
if (/secret|api[_-]?key|password/i.test(JSON.stringify(input))) throw new Error('Billing settings must contain only public values. Remove secret keys.');
const config = normalize({ razorpay: input.razorpay || null, lemonsqueezy: input.lemonsqueezy || null });
const list = offers(config);
if (input.razorpay && !list.some((o) => o.provider === 'razorpay')) throw new Error('Razorpay settings need an HTTPS serverUrl and at least one price label.');
if (input.lemonsqueezy && !list.some((o) => o.provider === 'lemonsqueezy')) throw new Error('Lemon Squeezy settings need a storeId and plans with productId, variantId and a hosted /buy/ checkoutUrl.');
if (!configured(config)) throw new Error('No store is configured.');
const root = path.join(__dirname, '../extension');
fs.writeFileSync(path.join(root, 'billing-config.js'), '/* Public seller settings. Never add secret API keys. */\nglobalThis.PagePressBillingConfig = Object.freeze(' + JSON.stringify(config, null, 2) + ');\n');
// Chrome only lets the extension request host access that the manifest lists as optional.
const manifestFile = path.join(root, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.optional_host_permissions = ['https://api.lemonsqueezy.com/*', ...(config.razorpay?.serverUrl ? [new URL(config.razorpay.serverUrl).origin + '/*'] : [])];
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log('Public billing settings saved:');
for (const o of list) console.log(`  ${o.currency} ${o.plan.padEnd(5)} ${o.priceLabel}  via ${o.provider}`);
console.log('Reload the extension and test checkout and license activation before publishing.');
