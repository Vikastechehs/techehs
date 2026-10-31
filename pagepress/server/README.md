# PagePress license server

Sells PagePress Pro through Razorpay subscriptions and issues and verifies license keys for the extension. Plain Node.js with the built-in SQLite module; no npm dependencies.

## What it serves

| Route | Purpose |
| --- | --- |
| `GET /buy?currency=INR&plan=year` (`plan` = `week`, `month` or `year`; `currency` = `INR` or `USD`) | Checkout page: email, Razorpay payment window, then shows the license key |
| `GET /manage` | Customer self-service: renewal status, release browsers, cancel renewal |
| `POST /api/checkout`, `POST /api/checkout/claim` | Create a yearly subscription or a one-time pass order; verify the payment signature and return the key |
| `POST /api/razorpay/webhook` | Signed Razorpay events: `order.paid` for passes; subscription renewals, failures, cancellations |
| `POST /v1/licenses/validate`, `/activate`, `/deactivate` | License API used by the extension (same response shape as Lemon Squeezy's) |
| `GET /healthz` | Health check |

## Run

Requires Node.js 22.13 or later.

```bash
cd pagepress/server
cp .env.example .env   # fill in, then export the values or use your host's secret settings
set -a && . ./.env && set +a
npm start
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | yes | Public HTTPS address, for example `https://licenses.yourdomain.com` |
| `RAZORPAY_KEY_ID` | yes | Razorpay API key ID (public, sent to the checkout page) |
| `RAZORPAY_KEY_SECRET` | yes | Razorpay API key secret. Server only. |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Secret entered when creating the Razorpay webhook |
| `RAZORPAY_PLAN_ID_INR` | yes | Yearly INR plan ID |
| `RAZORPAY_PLAN_ID_USD` | no | Yearly USD plan, only if Razorpay (not Lemon Squeezy) sells USD |
| `PASS_WEEK_INR`, `PASS_MONTH_INR` | no | One-time 1-week (7 days) and 1-month (30 days) pass prices in **paise**, e.g. `24900` = ₹249. Omit to not sell that pass |
| `PASS_WEEK_USD`, `PASS_MONTH_USD` | no | Same in cents, only if Razorpay sells USD |
| `ACTIVATION_LIMIT` | no | Browsers per license, default 2 |
| `INR_INDIAN_PAYMENTS_ONLY` | no | `1` refunds international cards on the INR plan. Only for regional pricing; leave off with the universal price |
| `SUBSCRIPTION_TOTAL_COUNT` | no | Yearly renewals authorised in the mandate, default 10 |
| `DATABASE_PATH` | no | SQLite file, default `./data/pagepress.sqlite` |
| `PORT` | no | Default 8787 |
| `TRUST_PROXY` | no | `1` when behind a reverse proxy that sets `X-Forwarded-For` (used for rate limiting) |
| `SELLER_NAME`, `SUPPORT_EMAIL` | no | Shown in the Razorpay window and on the checkout page |

## Deploy

- Run behind HTTPS (Caddy, nginx, or a platform load balancer) on a fixed domain. The extension's manifest permission is tied to this origin, so changing the domain needs an extension update.
- Give the database a **persistent disk** and back it up daily. It holds every issued key; losing it locks paying customers out. Platforms with ephemeral disks need a mounted volume.
- Serve the app at the domain root, or have the proxy strip any path prefix.
- One process is enough; rate limits are in memory per process.

## Operate

```bash
node scripts/admin.js find buyer@example.com     # keys, status, expiry, activations
node scripts/admin.js disable PP-XXXXX-XXXXX-XXXXX-XXXXX
node scripts/admin.js enable PP-XXXXX-XXXXX-XXXXX-XXXXX
```

## How access is decided

- **Passes (1 week, 1 month)** are Razorpay one-time orders. The key is issued only for a captured payment of the exact order amount and currency, verified by the order signature (`HMAC-SHA256(order_id|payment_id)`) or a signed `order.paid` webhook. An authorized-but-uncaptured payment is captured first. Access runs 7 or 30 days from issue and never renews; buying again gives a new key.

- **Yearly plans:** a key is issued only after a verified checkout signature (`HMAC-SHA256(payment_id|subscription_id)` with the key secret), or after a signed `subscription.activated`/`subscription.charged` webhook. That second path covers buyers who closed the tab; reopening `/buy` in the same browser shows their key.
- Access lasts until the subscription's `current_end`. Renewal webhooks extend it. If a renewal webhook is missed, the next license check after expiry re-reads the subscription from Razorpay (at most hourly), so paying customers are not cut off.
- `pending` (renewal retrying) keeps the already-paid period. `halted`, `cancelled`, `completed` and `paused` end access. Cancelling on `/manage` stops renewal at the end of the paid period.
- Activations are counted per license; parallel activations cannot exceed the limit.

## Test

```bash
npm test
npm run test:pages   # browser test of /buy and /manage; needs Playwright with Chromium
```

The tests run the real HTTP server against an in-memory database and a fake Razorpay API: no network and no payments. They cover signature forgery, claim tokens, webhook signatures and deduplication, the closed-tab path, activation limits, revocation, renewal, missed-webhook recovery, cancellation, expiry, self-service, rate limits, and the actual extension licensing client talking to the server.
