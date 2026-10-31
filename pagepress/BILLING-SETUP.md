# Enable PagePress payments

Version 0.4.0 sells Pro in two currencies:

| Buyer | Currency | Checkout | License keys from |
| --- | --- | --- | --- |
| India | INR yearly subscription (UPI Autopay, cards, netbanking) | Razorpay, on your PagePress license server's `/buy` page | Your PagePress license server (`server/`) |
| Outside India | USD yearly subscription | Lemon Squeezy hosted checkout | Lemon Squeezy |

Either store works alone, and the shipped build has neither configured: it runs as Free and marks purchases unavailable. There is no bundled master key, test entitlement, or pretend payment success. If Lemon Squeezy is not available to you, the license server can also sell the USD plan through Razorpay international payments (see "USD through Razorpay" below).

PagePress uses **one universal price worldwide**, shown in the buyer's currency: about US$12/year, which is ₹999/year in India. Browsers set to Indian time see the INR price; everyone else sees USD. A small link switches currency for travellers. Because both prices are worth the same, nobody gains by choosing the other currency. Keep the two amounts roughly equal when you change prices or exchange rates move a lot.

## Plans

| Plan | Price | Capture limit |
| --- | --- | --- |
| Free | ₹0 / $0 | 5 document pages per capture |
| Pro (universal price) | ₹999/year in India (Razorpay plan amount) = US$12/year elsewhere, recurring | 200 document pages per capture |

To change the price, change the Razorpay plan amount, the Lemon Squeezy variant price, and both labels in the configure command below.

Both plans include PDF, individual JPEG and JPEG ZIP export, 200%/300% quality, and interrupted-capture recovery. Retained captures remain exportable after Pro ends. The page limit applies to the full requested range, including resumed jobs; changing output format does not bypass it.

## Part A: India (Razorpay, INR)

Razorpay is a payment gateway, not a license provider and not a merchant of record. The PagePress license server creates the subscription, verifies payment, issues `PP-XXXXX-XXXXX-XXXXX-XXXXX` keys, and answers the extension's license checks. You are the seller of record: GST registration, tax invoices and refund handling are your responsibility.

1. **Razorpay account.** Complete KYC and activate live mode. Enable **Subscriptions** (and UPI Autopay) on the account.
2. **Plan.** In the Razorpay Dashboard → Subscriptions → Plans, create a plan: billing frequency **yearly**, interval 1, currency **INR**, amount **₹999** (the INR equivalent of the universal US$12 price). Copy the plan ID (`plan_...`).
3. **API keys.** Dashboard → Account & Settings → API Keys: generate a key ID and key secret. The key secret goes only into the server's environment.
4. **Deploy the license server** (`server/`, see `server/README.md`) at a stable HTTPS address such as `https://licenses.yourdomain.com`, with a persistent disk for its SQLite database.
5. **Webhook.** Dashboard → Webhooks → Add: URL `https://licenses.yourdomain.com/api/razorpay/webhook`, a strong secret (also set as `RAZORPAY_WEBHOOK_SECRET`), and these events: `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused`, `subscription.resumed`.
6. **Policies.** Razorpay requires public terms, privacy, refund/cancellation and contact pages on your website. Explain that Pro renews yearly until cancelled at `https://licenses.yourdomain.com/manage`.

## Part B: Outside India (Lemon Squeezy, USD)

1. Create and activate a Lemon Squeezy store. Check first that Lemon Squeezy accepts and pays out to your business's country; India has had restrictions.
2. Create **PagePress Pro** as a **US$12 yearly subscription**, enable **Generate license keys**, activation limit **2**, and customer cancellation in the customer portal.
3. Copy the public **store ID**, **product ID**, **variant ID**, and hosted checkout URL (`https://YOUR-STORE.lemonsqueezy.com/buy/VARIANT-UUID`). Lemon Squeezy acts as merchant of record and handles sales tax for these sales.

### Regional pricing (optional, not the default)

If you ever make INR cheaper than USD, set `INR_INDIAN_PAYMENTS_ONLY=1` on the license server. An international card that pays the INR plan then gets no license: the payment is refunded automatically, the subscription is cancelled, and the buyer is told to use the USD plan. UPI, Indian netbanking and Indian cards are unaffected. With the universal price this stays off, so travellers and diaspora can pay either way.

### USD through Razorpay instead

If you do not use Lemon Squeezy, enable international payments on Razorpay, create a second yearly plan in **USD**, set `RAZORPAY_PLAN_ID_USD` on the server, and pass `--usd-price` to the configure script below. Currency support for international subscriptions depends on your Razorpay account; confirm with Razorpay before relying on it.

## Configure the extension

All values are public. No secret key is needed or accepted. From `pagepress/`:

```bash
node scripts/configure-billing.cjs \
  --server-url https://licenses.yourdomain.com --inr-price "₹999/year" --lemon-price "$12/year" \
  --store-id 123 --product-id 456 --variant-id 789 \
  --checkout-url https://YOUR-STORE.lemonsqueezy.com/buy/YOUR-VARIANT-UUID
```

Omit either group to enable only one store. The script writes `extension/billing-config.js` and adds the license server's origin to `optional_host_permissions` in `extension/manifest.json`. Chrome can only request host access listed there, so always configure through the script, or edit both files consistently by hand.

Reload the unpacked extension and test before selling:

- Razorpay **test mode** (test key ID/secret and a test plan on the server): buy with a test card or UPI ID, confirm the key appears on the `/buy` page, activate it in PagePress, capture more than five pages, release a browser and cancel renewal on `/manage`, and check that the webhooks arrive (Dashboard → Webhooks → delivery logs).
- Lemon Squeezy test product: checkout, receipt key, activation, verification, activation limit, deactivation, cancellation and renewal.
- Then switch both to live mode, check the displayed prices and policies, and make one real purchase in each currency before selling publicly.

Repackage after configuration; do not distribute the unconfigured ZIP. From the repository root:

```bash
rm -f pagepress-extension.zip && zip -r -X pagepress-extension.zip pagepress/extension pagepress/README.md pagepress/PRIVACY.md pagepress/BILLING-SETUP.md
```

## Customer flow

- **India** (browser on Indian time): Plans & license shows **Pay in INR**. Chrome opens the license server's `/buy` page in a new tab. The buyer enters an email and pays in the Razorpay window; the page then shows their license key and keeps it retrievable on that browser. Razorpay sends its own payment and subscription emails.
- **Elsewhere:** Plans & license shows **Pay in USD**, which opens Lemon Squeezy checkout; the license key arrives in the receipt.
- **Activate:** enter the key and checkout email in PagePress, then **Activate license**. Chrome asks for access to that store's license API only. PagePress routes `PP-` keys to your license server and other keys to Lemon Squeezy, checks product, status, expiry and the purchase email before using an activation slot, and stores the returned browser instance.
- Opening or returning from either checkout never unlocks Pro by itself. Pro is checked when the panel opens and before every capture larger than five pages. No saved `pro: true` flag is trusted, and there is no offline grace period.
- **Manage billing:** INR licenses open `/manage` on the license server, where the key and checkout email together let the customer see renewal status, release browser activations, and cancel renewal at the end of the paid period. Lemon Squeezy licenses open its customer portal.
- **Deactivate here** frees this browser's activation without cancelling billing; if it fails, the stored credentials remain for retry. Clear capture never removes the license.

## Support

- Lost INR key: run `node scripts/admin.js find buyer@example.com` on the server (it also shows status, expiry and activations). Each key is also stored against the Razorpay subscription ID shown in your dashboard.
- Refund or abuse: cancel the subscription in Razorpay, then `node scripts/admin.js disable PP-...`.

## Boundaries

The extension holds no seller secret. The license server holds the Razorpay key secret and webhook secret in its environment only. Card and UPI details stay with Razorpay and Lemon Squeezy. Document images, titles and URLs are never sent to either store or to the license server.

As with any extension whose useful work happens in the browser, someone who modifies its source can remove local feature limits. Server-side verification stops ordinary bogus or shared keys; it is not tamper-proof DRM.

Provider references: [Lemon Squeezy License API](https://docs.lemonsqueezy.com/api/license-api), [Razorpay Subscriptions integration](https://razorpay.com/docs/payments/subscriptions/integration-guide/), [Razorpay webhooks](https://razorpay.com/docs/webhooks/).
