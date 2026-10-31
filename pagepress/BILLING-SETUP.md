# Enable PagePress payments

Version 0.5.0 sells Pro as a **1-week pass, 1-month pass or yearly plan**, in two currencies:

| Buyer | Currency | Checkout | License keys from |
| --- | --- | --- | --- |
| India | INR: passes are one-time payments (UPI, cards, netbanking); yearly is a subscription (UPI Autopay, cards) | Razorpay, on your PagePress license server's `/buy` page | Your PagePress license server (`server/`) |
| Outside India | USD: passes are one-time products with expiring keys; yearly is a subscription | Lemon Squeezy hosted checkout | Lemon Squeezy |

Either store works alone, and the shipped build has neither configured: it runs as Free and marks purchases unavailable. There is no bundled master key, test entitlement, or pretend payment success. If Lemon Squeezy is not available to you, the license server can also sell the USD plan through Razorpay international payments (see "USD through Razorpay" below).

PagePress uses **one universal price worldwide**, shown in the buyer's currency. Browsers set to Indian time see the INR price; everyone else sees USD. A small link switches currency for travellers. Because both prices are worth the same, nobody gains by choosing the other currency. Keep the two amounts roughly equal when you change prices or exchange rates move a lot.

## Plans

| Plan | Price | Capture limit |
| --- | --- | --- |
| Free | ₹0 / $0 | 5 document pages per capture |
| Pro 1-week pass | ₹249 / US$2.99, one-time, 7 days, never renews | 200 document pages per capture |
| Pro 1-month pass | ₹449 / US$4.99, one-time, 30 days, never renews | 200 document pages per capture |
| Pro yearly | ₹999 / US$12 per year, renews until cancelled | 200 document pages per capture |

The USD pass prices are slightly above the exact rupee conversion because Lemon Squeezy's fixed US$0.50 fee per sale would otherwise take a large share of a small payment. To change a price, change it at the provider (Razorpay plan or `PASS_*` amount on the server; Lemon Squeezy variant price) and the matching label in your billing settings file.

Passes suit people who need one document set once. The yearly plan suits professionals. Buying a pass again gives a new key; activate it in place of the old one (Deactivate here, then Activate).

All plans include PDF, individual JPEG and JPEG ZIP export, 200%/300% quality, and interrupted-capture recovery. Retained captures remain exportable after Pro ends. The page limit applies to the full requested range, including resumed jobs; changing output format does not bypass it.

## Part A: India (Razorpay, INR)

Razorpay is a payment gateway, not a license provider and not a merchant of record. The PagePress license server creates the subscription, verifies payment, issues `PP-XXXXX-XXXXX-XXXXX-XXXXX` keys, and answers the extension's license checks. You are the seller of record: GST registration, tax invoices and refund handling are your responsibility.

1. **Razorpay account.** Complete KYC and activate live mode. Enable **Subscriptions** (and UPI Autopay) on the account.
2. **Yearly plan.** In the Razorpay Dashboard → Subscriptions → Plans, create a plan: billing frequency **yearly**, interval 1, currency **INR**, amount **₹999**. Copy the plan ID (`plan_...`).
   **Passes** need no dashboard setup: set `PASS_WEEK_INR=24900` and `PASS_MONTH_INR=44900` (paise) on the server. Make sure **automatic payment capture** is on (Account & Settings → Payment capture); the server also captures an authorized payment itself before issuing a pass.
3. **API keys.** Dashboard → Account & Settings → API Keys: generate a key ID and key secret. The key secret goes only into the server's environment.
4. **Deploy the license server** (`server/`, see `server/README.md`) at a stable HTTPS address such as `https://licenses.yourdomain.com`, with a persistent disk for its SQLite database.
5. **Webhook.** Dashboard → Webhooks → Add: URL `https://licenses.yourdomain.com/api/razorpay/webhook`, a strong secret (also set as `RAZORPAY_WEBHOOK_SECRET`), and these events: `order.paid` (passes), `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused`, `subscription.resumed`.
6. **Policies.** Razorpay requires public terms, privacy, refund/cancellation and contact pages on your website. Explain that passes are one-time and never renew, and that the yearly plan renews until cancelled at `https://licenses.yourdomain.com/manage`.

## Part B: Outside India (Lemon Squeezy, USD)

1. Create and activate a Lemon Squeezy store. Check first that Lemon Squeezy accepts and pays out to your business's country; India has had restrictions.
2. Create **PagePress Pro yearly** as a **US$12 yearly subscription**, enable **Generate license keys**, activation limit **2**, and customer cancellation in the customer portal.
3. Create **PagePress Pro pass** as a **single-payment** product with two variants: **1 week, US$2.99** and **1 month, US$4.99**. Enable **Generate license keys** with activation limit **2** and a license length of **7 days** and **30 days** respectively, so the keys expire on their own.
4. For each of the three variants, copy the public **product ID**, **variant ID** and hosted checkout URL (`https://YOUR-STORE.lemonsqueezy.com/buy/VARIANT-UUID`), plus your **store ID**. Lemon Squeezy acts as merchant of record and handles sales tax for these sales.

### Regional pricing (optional, not the default)

If you ever make INR cheaper than USD, set `INR_INDIAN_PAYMENTS_ONLY=1` on the license server. An international card that pays the INR plan then gets no license: the payment is refunded automatically, the subscription is cancelled, and the buyer is told to use the USD plan. UPI, Indian netbanking and Indian cards are unaffected. With the universal price this stays off, so travellers and diaspora can pay either way.

### USD through Razorpay instead

If you do not use Lemon Squeezy, enable international payments on Razorpay, create a second yearly plan in **USD**, set `RAZORPAY_PLAN_ID_USD` (and `PASS_WEEK_USD`/`PASS_MONTH_USD` in cents) on the server, and add a `"USD"` entry under `razorpay.prices` in your billing settings file. Currency support for international subscriptions depends on your Razorpay account; confirm with Razorpay before relying on it.

## Configure the extension

All values are public. No secret key is needed or accepted. Copy `scripts/billing.example.json` to `billing.json`, fill in your server URL, price labels and Lemon Squeezy IDs, then from `pagepress/`:

```bash
node scripts/configure-billing.cjs billing.json
```

Leave out `razorpay` or `lemonsqueezy` to enable only one store, or leave out a plan to not sell it. The script prints every offer it configured. The script writes `extension/billing-config.js` and adds the license server's origin to `optional_host_permissions` in `extension/manifest.json`. Chrome can only request host access listed there, so always configure through the script, or edit both files consistently by hand.

Reload the unpacked extension and test before selling:

- Razorpay **test mode** (test key ID/secret and a test plan on the server): buy with a test card or UPI ID, confirm the key appears on the `/buy` page, activate it in PagePress, capture more than five pages, release a browser and cancel renewal on `/manage`, and check that the webhooks arrive (Dashboard → Webhooks → delivery logs).
- Lemon Squeezy test product: checkout, receipt key, activation, verification, activation limit, deactivation, cancellation and renewal.
- Then switch both to live mode, check the displayed prices and policies, and make one real purchase in each currency before selling publicly.

Repackage after configuration; do not distribute the unconfigured ZIP. From the repository root:

```bash
rm -f pagepress-extension.zip && zip -r -X pagepress-extension.zip pagepress/extension pagepress/README.md pagepress/PRIVACY.md pagepress/BILLING-SETUP.md
```

## Customer flow

- **India** (browser on Indian time): Plans & license shows **1 week**, **1 month** and **1 year** in rupees. Chrome opens the license server's `/buy` page in a new tab. The buyer enters an email and pays in the Razorpay window; the page then shows their license key and keeps it retrievable on that browser. Razorpay sends its own payment and subscription emails.
- **Elsewhere:** the same three plans in US dollars, which open Lemon Squeezy checkout; the license key arrives in the receipt.
- **Activate:** enter the key and checkout email in PagePress, then **Activate license**. Chrome asks for access to that store's license API only. PagePress routes `PP-` keys to your license server and other keys to Lemon Squeezy, checks product, status, expiry and the purchase email before using an activation slot, and stores the returned browser instance.
- Opening or returning from either checkout never unlocks Pro by itself. Pro is checked when the panel opens and before every capture larger than five pages. No saved `pro: true` flag is trusted, and there is no offline grace period.
- **Manage billing:** INR licenses open `/manage` on the license server, where the key and checkout email together let the customer see when their pass ends or when the yearly plan renews, release browser activations, and cancel yearly renewal at the end of the paid period. Lemon Squeezy licenses open its customer portal.
- **Deactivate here** frees this browser's activation without cancelling billing; if it fails, the stored credentials remain for retry. Clear capture never removes the license.

## Support

- Lost INR key: run `node scripts/admin.js find buyer@example.com` on the server (it also shows status, expiry and activations). Each key is also stored against the Razorpay subscription or order ID shown in your dashboard.
- Refund or abuse: refund the payment (and cancel any subscription) in Razorpay, then `node scripts/admin.js disable PP-...`.

## Boundaries

The extension holds no seller secret. The license server holds the Razorpay key secret and webhook secret in its environment only. Card and UPI details stay with Razorpay and Lemon Squeezy. Document images, titles and URLs are never sent to either store or to the license server.

As with any extension whose useful work happens in the browser, someone who modifies its source can remove local feature limits. Server-side verification stops ordinary bogus or shared keys; it is not tamper-proof DRM.

Provider references: [Lemon Squeezy License API](https://docs.lemonsqueezy.com/api/license-api), [Razorpay Subscriptions integration](https://razorpay.com/docs/payments/subscriptions/integration-guide/), [Razorpay webhooks](https://razorpay.com/docs/webhooks/).
