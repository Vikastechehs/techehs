# Enable PagePress payments

Version 0.3 includes Free/Pro plans, hosted checkout, license activation and validation, subscription management, and browser deactivation. The distributed build starts in Free mode. No seller account or checkout was supplied, so purchases and activation are visibly unavailable until you configure your real store. There is no bundled master key, test entitlement, or pretend payment success.

## Plans

| Plan | Price | Capture limit |
| --- | --- | --- |
| Free | $0 | 5 document pages per capture |
| Pro | US$19/year, recurring; applicable taxes shown at checkout | 200 document pages per capture |

Both plans include PDF, individual JPEG and JPEG ZIP export, 200%/300% quality, and interrupted-capture recovery. Existing captured pages remain available for export after expiration or deactivation. The page limit applies to the full requested range, including resumed jobs; changing output format does not bypass it. The existing memory and image-size limits still apply.

## Seller setup

1. Create and activate your own Lemon Squeezy store. Complete the provider's seller verification and payout setup. Account approval and eligibility are controlled by the provider.
2. Create **PagePress Pro** as a **US$19 yearly recurring subscription**. Enable **Generate license keys**, and choose an activation limit (two browser installations is a reasonable initial offer). Subscription license validity follows the subscription lifecycle. Enable customer cancellation in the hosted customer portal.
3. Add your seller identity, contact details, privacy policy, renewal/cancellation terms and refund policy to the store and checkout. Explain Free's 5-page limit and Pro's 200-page limit in the Chrome Web Store listing. Provide the extension installation instructions with the receipt.
4. Copy the public **store ID**, **product ID**, **variant ID**, and hosted checkout URL (`https://YOUR-STORE.lemonsqueezy.com/buy/VARIANT-UUID`). These are public identifiers, not credentials. Do not use an expiring checkout-session URL.
5. Configure this project from PowerShell (replace the sample values with your real public settings):

```powershell
cd pagepress
node scripts/configure-billing.cjs --store-id 123 --product-id 456 --variant-id 789 --checkout-url 'https://YOUR-STORE.lemonsqueezy.com/buy/YOUR-VARIANT-UUID'
```

The script writes `extension/billing-config.js`. No secret API key is needed or accepted. The URL must be a Lemon Squeezy HTTPS hosted checkout. Custom checkout domains and other payment providers need an adapter change.

If you only extracted the extension ZIP, edit those four public settings directly in `extension/billing-config.js`: replace the three `null` IDs with numbers and the empty checkout URL with your hosted URL. The CLI script is available in the full workspace source.

6. Reload the unpacked extension in Chrome. Test with the provider's test product and license, configuring that product's correct public IDs first. Exercise successful checkout, receipt delivery, matching email, activation, verification, activation limits, cancellation at period end, expiration/disable, renewal, and deactivation. Then configure the live product and live checkout, verify their displayed price and policies, and complete a live smoke test before selling publicly. This repository's mocked tests do not establish that your merchant checkout or payouts work.
7. Repackage after configuration; do not distribute the old unconfigured ZIP:

```powershell
cd ..
Compress-Archive -LiteralPath '.\pagepress\extension','.\pagepress\README.md','.\pagepress\PRIVACY.md','.\pagepress\BILLING-SETUP.md' -DestinationPath '.\pagepress-extension.zip' -Force
```

## Customer flow

- Choose **Plans & license → Upgrade to Pro**. Chrome opens your hosted checkout in a new tab; the extension never handles card details.
- After purchase, return to PagePress, enter the receipt's license key and checkout email, and select **Activate license**. Chrome asks for access to the license API domain. A key and matching purchase email are checked against your exact store/product/variant before an activation slot is used.
- **Verify license** checks the current browser instance. Pro is checked when the panel opens and before every capture larger than five pages. There is no offline Pro grace period; Free and previously retained exports remain available if verification cannot complete. Do not close the panel during capture.
- **Manage billing** opens your store's hosted customer portal, where customers sign in using the provider's email flow. **Deactivate here** releases this browser's instance and returns to Free; it does not cancel billing. If deactivation fails, the stored credentials remain for retry.
- Clear capture deletes document images and capture settings, not the license. Deactivate before uninstalling to release a slot. If the browser is lost or uninstalled first, release the activation from the seller dashboard. The customer can activate again subject to the provider's activation limit.

## Implementation and boundaries

The extension's panel runs billing operations through `licensing.js`. It exposes no billing message handler to document pages. License calls use the public Lemon Squeezy License API over HTTPS; there is no secret seller API key, remote executable script, payment webhook server, or upload of document captures. Product identity, license status, expiry, and browser instance must match. No saved `pro: true` flag is trusted. Do not add secret seller API credentials to extension files.

The license key, checkout email, and provider instance ID are retained in a separate IndexedDB database belonging to the extension's origin, inaccessible to document-site scripts. This is browser-local storage, not an encrypted credential vault. Only the last four key characters are shown after activation. Card/payment details remain with hosted checkout. The provider receives license requests and ordinary connection metadata. Privacy disclosures have changed from the earlier fully offline prototype.

As with any extension whose useful work happens entirely on the client, someone who modifies its source can remove local feature limits. Provider verification prevents ordinary bogus keys; it is not tamper-proof DRM. No claim of official-document authenticity, searchable PDF export, or compatibility with every portal is made.

## Verification

```powershell
cd pagepress
npm test
node tests/browser.test.cjs --unconfigured
node tests/browser.test.cjs
```

Unit tests mock provider responses for product/email mismatch, expiration, disabled licenses, activation limits, revoked instances, permission denial, connection failures, and deactivation. Browser tests use an isolated extension copy, mock the license API and checkout, and never take a real payment. No test keys or test checkout are shipped in the production extension configuration.

Provider references: [License API](https://docs.lemonsqueezy.com/api/license-api), [license integration guide](https://docs.lemonsqueezy.com/guides/tutorials/license-keys), [subscription license lifecycle](https://docs.lemonsqueezy.com/help/licensing/license-keys-subscriptions), [customer portal](https://docs.lemonsqueezy.com/help/online-store/customer-portal).
