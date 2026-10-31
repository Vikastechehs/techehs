# PagePress developer handoff

This is the complete editable source for PagePress v0.4.0, not just the installable extension. The developer brief PDF is included as `pagepress-developer-brief.pdf`. v0.3.1 reviews and extends the v0.3.0 prototype; see "Changes in 0.3.1" below and `TEST-RESULTS.md`.

## Start here

- Read `README.md`, `BILLING-SETUP.md`, and `PRIVACY.md`.
- `extension/` contains the Manifest V3 extension, its readable JavaScript/CSS/HTML, icons, and bundled third-party distributions and licenses. Chrome can load this folder directly without a build step.
- `scripts/` contains vendor bundling, icon generation, and public billing configuration helpers.
- `tests/` contains unit tests, browser integration tests and fixtures, plus independent PDF/JPEG verification scripts.
- `package.json` and `package-lock.json` describe and pin the Node dependencies. Installed `node_modules`, browser profiles, captured records, download history, and generated test artifacts are intentionally not included.

## Install in Chrome

Open `chrome://extensions`, enable Developer mode, choose Load unpacked, and select this project's `extension/` folder. Invoke the toolbar icon on a supported document-viewer website. This is PagePress; the unrelated ReleaseCheck project is not part of this archive.

## Development

Use a current Node.js LTS release supporting the dependency requirements. From this project's folder:

```powershell
npm ci
npm run build
npm test
```

For the browser integration test, the harness loads `playwright` from Node's normal module resolution (or from `PAGEPRESS_PLAYWRIGHT` if set). On Windows:

```powershell
npm install --no-save --package-lock=false playwright
npx playwright install chromium
$env:PAGEPRESS_PLAYWRIGHT = (Resolve-Path .\node_modules\playwright).Path
node tests/browser.test.cjs --unconfigured
node tests/browser.test.cjs
```

On macOS/Linux:

```bash
npm ci && npm test
npm install --no-save --package-lock=false playwright && npx playwright install chromium
node tests/browser.test.cjs --unconfigured
node tests/browser.test.cjs
pip install pillow pypdf pypdfium2 && python3 tests/verify_pdfs.py && python3 tests/verify_jpegs.py
```

Rebuild the installable package from the repository root after any change:

```bash
rm -f pagepress-extension.zip && zip -r -X pagepress-extension.zip pagepress/extension pagepress/README.md pagepress/PRIVACY.md pagepress/BILLING-SETUP.md
```

The optional `PAGEPRESS_CHROMIUM` environment variable can select a compatible Chromium executable that supports loading unpacked extensions. The tests use an isolated browser profile and a mock payment provider; they do not charge anyone. Output goes to a sibling `test-results/pagepress/` folder. The Python verification scripts require Pillow, pypdf, and pypdfium2; run them after the full browser test has generated its exports. Icon regeneration also requires Pillow.

The most recent work verified the 21-page PDF/JPEG exports and independently decoded them, and exercised license activation, persistence, revocation, deactivation, and Free capture. An integration-test timing assertion was corrected and the real-viewer/license scenarios were rerun successfully; a fresh full browser run is recommended on the recipient's machine. The included tests still need an actual installed-extension smoke test on the user's target portal.

## Payment status

Free allows five pages per capture. Pro is designed for US$19/year and up to 200 pages, subject to the documented memory limits. `extension/billing-config.js` intentionally contains no configured seller identifiers or checkout URL. It has no master activation key, seller secret, or live payment setup.

The owner has selected Lemon Squeezy but still needs to create/activate the merchant account and product. Follow `BILLING-SETUP.md` to configure the public store/product/variant IDs and hosted checkout URL. Verify test and live checkout, receipt delivery, licensing, renewal and cancellation before enabling sales. Never put a secret seller API key into extension code.

## Delivery expectations

Return updated source, an installable extension ZIP, installation notes, test evidence, accurate viewer-support limitations, and updated privacy/billing disclosures. Keep document captures local. Do not promise compatibility with every website or original PDF signature/searchable-text preservation.

## Changes in 0.4.0: INR (Razorpay) and USD pricing

- **India / INR:** new `server/` license server (Node 22.13+, built-in SQLite, no dependencies). It hosts the `/buy` checkout page with Razorpay's payment window, creates yearly Razorpay subscriptions, verifies the payment signature and signed webhooks, issues `PP-` license keys, and serves the same `/v1/licenses/validate|activate|deactivate` API shape the extension already used for Lemon Squeezy. `/manage` lets customers see renewal status, release browser activations and cancel renewal. See `server/README.md`.
- **Outside India / USD:** Lemon Squeezy stays the USD store. If it is unavailable, the server can sell a USD Razorpay plan instead.
- **Extension:** `licensing.js` now supports both stores. `PP-` keys are verified with the license server and other keys with Lemon Squeezy; each response must match its own store's product identity. The plan dialog shows **Pay in INR** and **Pay in USD** (INR first for Indian-timezone browsers). Only the license host matching the key is requested as an optional permission. Older saved Lemon Squeezy licenses keep working.
- `scripts/configure-billing.cjs` configures either or both stores and adds the server origin to `optional_host_permissions`.
- `BILLING-SETUP.md` and `PRIVACY.md` are rewritten for both stores. Razorpay is a gateway, not a merchant of record: the seller handles GST and invoices for INR sales.
- `npm test` now also runs the server suite. The browser test checks both buttons and the INR checkout tab, and captures 390/320 px plan screenshots.

Still open: Razorpay account, KYC, Subscriptions enablement and plan; hosting the license server on HTTPS with a persistent, backed-up disk; configuring the extension; test-mode and live purchases in both currencies.

## Changes in 0.3.1

Review of the v0.3.0 prototype against the developer brief found it substantially complete; these defects and gaps were fixed rather than rebuilding:

- **Large sheets no longer hit Chrome's 64 MiB extension-message limit.** Each captured PNG is now sent from the document tab to the panel in 8 MiB parts and reassembled and validated in order (`capture.js`, `app.js`). Previously a large Extra high (300%) scan could fail to transfer. The browser test stages a 64 KiB part size so every test page crosses the multi-part path.
- **Stale or capped canvases are no longer captured silently.** A sheet is only treated as ready when its canvas matches its displayed size at the device pixel ratio, so a CSS-stretched render left over from a zoom change is not mistaken for the 200%/300% render. If a viewer caps its canvas below the displayed size, PagePress waits up to half the page timeout, then keeps the native pixels (never upscaled) and flags that sheet with a Review warning.
- **Unreadable license-service responses** (for example an HTML 5xx page) now report a clear message, keep Free available and retain saved credentials, instead of surfacing a JSON parse error.
- Removed a dead `chrome.action.onClicked` listener: Chrome does not dispatch it when the side panel opens on action click.
- Test harness: fixed a race where the real PDF.js scenario read the previous scenario's "Needs attention" state before its own capture started; removed hard-coded Windows paths to Playwright/Chromium.
- Added `.gitignore` entries for `node_modules/` and generated `test-results/`.

Not changed (still open, outside what can be done in code): merchant account and product setup, public billing IDs, live checkout/activation/renewal test, and the installed-extension smoke test on the Bihar portal document.
