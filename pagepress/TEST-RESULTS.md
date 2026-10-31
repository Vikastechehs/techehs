# PagePress 0.4.0 test results

Run on 31 October 2026 in a Linux container (Node 22, headless Chromium via Playwright, isolated profile). Razorpay and Lemon Squeezy were replaced by fakes and mocks; no real checkout or payment was made.

| Suite | Command | Result |
| --- | --- | --- |
| Extension unit tests: ranges, ordering, proportions, filenames; licensing for both stores (product/email mismatch, cross-store responses, expired, disabled, activation limit, revoked instance, no cached Pro flag, permission denial, connection failure, unreadable response, deactivation retention, key routing, INR/USD offers, legacy config) | `npm test` | Pass, 18/18 |
| License server: config secrets, checkout per currency, key secret never sent to the browser, forged payment signature, wrong claim token, checkout alone issues nothing, idempotent claim, webhook signature and deduplication, closed-tab path via webhook, activation limit, revocation, renewal, missed-webhook resync, cancel at cycle end, expiry, pending/halted, Razorpay unreachable, self-service with email check, browser release, malformed and oversized requests, rate limits, and the real extension licensing client against the running server | `npm --prefix server test` (also run by `npm test`) | Pass, 11/11 |
| Browser: unconfigured build stays Free with purchases disabled; narrow layouts | `node tests/browser.test.cjs --unconfigured` | Pass |
| Browser: both **Pay in INR** and **Pay in USD** offers shown, INR opens the license server's `/buy?currency=INR`, USD opens Lemon Squeezy, neither unlocks Pro; Free 5-page gate, invalid key, Pro activation and persistence, billing portal, revocation, deactivation; full capture and export scenarios from 0.3.1; 390/320 px plan dialog | `node tests/browser.test.cjs` (also with `TZ=Asia/Kolkata`) | Pass |
| Checkout and self-service pages in Chromium against the real server, Razorpay `checkout.js` stubbed to sign like Razorpay: INR price shown, payment completes, key displayed and recovered after reopening, `/manage` refuses a wrong email, shows renewal and cancels it; 390 px layout | `npm --prefix server run test:pages` | Pass |
| Independent PDF/JPEG checks | `python3 tests/verify_pdfs.py`, `python3 tests/verify_jpegs.py` | Pass (unchanged capture/export code) |

## Not verified here

- Real Razorpay checkout, UPI Autopay mandates, webhook delivery and international (USD) subscriptions: no Razorpay account exists yet, and this environment cannot reach razorpay.com.
- The `/buy` page with the real Razorpay Checkout window (tested with a stub of its script).
- Real Lemon Squeezy checkout, activation, renewal and expiry.
- The reduced-resolution (capped canvas) warning path; toolbar `activeTab` grant in a normal Chrome install; the Bihar portal document.
