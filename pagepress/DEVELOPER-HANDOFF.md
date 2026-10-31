# PagePress developer handoff

This is the complete editable source for PagePress v0.9.0, not just the installable extension. The developer brief PDF is included as `pagepress-developer-brief.pdf`. v0.3.1 reviews and extends the v0.3.0 prototype; see "Changes in 0.3.1" below and `TEST-RESULTS.md`.

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

## Changes in 0.9.0: wider real-world testing and fixes

New tests against real software, and the bugs they found:
- **Screen pixel ratio.** Viewers multiply their zoom by the screen's pixel ratio, so "High (200%)" gave 400% pixels on a Retina Mac. Extra high then exceeded the 32-million-pixel limit for A4 and failed. On 1.25x Windows laptops it gave 250%. PagePress now divides the zoom by the pixel ratio, so High is about 1,587 px and Extra high about 2,380 px for A4 on every screen. The checker has new `--dpr` and `--quality` options.
- **PDFs with links and form fields.**
  - Link-only annotation layers no longer trigger the slower html2canvas path.
  - Check boxes and radio buttons are drawn as plain boxes in html2canvas's copy, because html2canvas crashed on PDF.js 2.x form styling.
  - Layered pages are cropped to the sheet, without the viewer's border.
  - Tested on all five official PDF.js releases.
- **PhotoSwipe** (real library): its full-screen lightbox calls itself a carousel, so the banner-carousel filter hid it, and the pager picked a preloaded off-screen neighbour slide. Only carousels smaller than 60% of the window are now ignored, and the pager picks the most visible page image.
- **Viewer.js** (real library): Next/Previous without any page counter is now reported as partial ("can only save the page on screen") instead of "supported, 1 page", and the panel shows that note.
- **Restoring the view after Stop/Retry on PDF.js:** PDF.js applies zoom changes a moment later and could leave the viewer on the page where the capture stopped. Success is now judged by the page actually on screen; the exact scroll position is tried first, then the page itself.
- **New tests:**
  - `tests/real-libs.test.cjs`: PhotoSwipe 5.4.4, Viewer.js 1.11.7, a react-pdf-style PDF.js canvas viewer, and the PDF.js app in an iframe, page mode, rotated and in spreads.
  - `tests/extension-flows.test.cjs`: loads the packaged ZIP on a Retina screen with a 60-page document; covers Stop, Retry, PDF, JPEG ZIP and single JPEG.
  - `server/test/process.test.cjs`: real server process; restart persistence, headers, bad input, Razorpay unreachable, SIGTERM.
  - `tests/pdfjs-apps.test.cjs` now also covers a links-and-forms document and pixel ratios.

## Changes in 0.8.0: real PDF.js releases and independent review fixes

**Tested against Mozilla's official PDF.js viewer app** (`tests/pdfjs-apps.test.cjs`, releases 2.16.105, 3.11.174, 4.10.38, 5.4.296, 6.4.299, unmodified). This found a critical issue: PDF.js 5 and later cap each page canvas at about three screens of pixels (`capCanvasAreaFactor`, from `screen.availWidth x availHeight`). On a typical laptop, every A4 page at 200% was drawn at reduced size, so capture failed on all recent PDF.js sites.
- During a capture, the panel now makes the page's own (main) world report a very large screen, and restores it afterwards.
- If the viewer is already at the target zoom, the capture steps away first so the viewer redraws.
- All five releases now pass. The extension captured all 7 pages at 300% on 2.16 and 6.4, with the viewer's page and zoom restored. The exported PDFs were checked independently.

**Fixes from an independent code review:**
- **Server:**
  - A malformed request line crashed the process; it now gets 400, and server.js catches handler errors.
  - Behind a proxy, rate limiting used the spoofable first X-Forwarded-For entry; it now uses the right-most one. Expired rate-limit entries are evicted instead of clearing every counter.
  - Passes are checked against the amount and days stored with the order, so a price change cannot strand paid orders.
  - Yearly licenses get a 2-day provisional period until Razorpay reports a paid period.
  - Subscription webhooks act on the subscription re-read from the API, because delivery order is not guaranteed. Expired yearly licenses are also re-checked hourly, so they heal.
- **Single-page viewers:**
  - Hindi labels now match; Devanagari vowel signs were being stripped.
  - A page box or drop-down is only trusted when the picture also changes; otherwise the viewer steps with Next/Previous.
  - Every step waits for the new picture.
  - An unchanged picture is saved with a "looks identical" warning, never silently.
  - The counter nearest the viewer's buttons is used. Carousels and banner sliders (and their "1 / 5" counters) are ignored. »/« are no longer treated as Next/Previous, and date-like text is not read as a page count.
  - A viewer opened on its last page (Next disabled) is detected.
  - ASP.NET `__doPostBack` links and submit buttons are treated as page-reloading controls.
  - Restoring is capped at 15 s.
  - `#fragment` changes no longer abort a capture.
- **Image lists:**
  - The page list is frozen when a capture starts.
  - Native `loading="lazy"` and still-downloading images are counted as pages.
  - Small images that finish loading are saved with a warning instead of timing out.
- **Panel:**
  - A page reload or closed tab during capture now fails the run with an explanation instead of leaving it stuck. It is confirmed by checking that the capture engine is gone, because viewers update `#page=N` while paging.
  - Submitting a license while the plan is still loading shows a message.
- **New regression tests** for each fix: server tests, checker fixtures (Hindi, an ignored page box, carousel decoy, last-page start, postback, native lazy) and mutation checks.

## Changes in 0.7.0: single-page (Next/Previous) viewers

- `capture.js` adds a **pager adapter**. It finds the largest page image or canvas, Next/Previous controls (words in English and Hindi with arrows stripped, bare arrows, or next/prev ids and classes, nearest to the page), and a counter (a "N of M" or "N / M" text, a page-number box, or a numbered drop-down).
- Navigation uses the page box or drop-down when present, otherwise steps with Next/Previous, and checks the counter after each step. Before saving, it waits until the image identity (source or pixels) differs from the previous page, because portals often update the counter before the new image arrives. Two identical pages in a row fall back after half the timeout. The viewer is returned to its starting page.
- Pagers whose Next/Previous links load a new web page are refused with an explanation. Single-image pages without pager controls are still treated as one-page documents.
- Tests: the checker test covers text-counter, page-box, drop-down, canvas and full-reload pagers. Its fixture delivers each image 1.5 s after the counter changes, and disabling the wait-for-new-image guard makes the test fail, so it really checks that. The extension browser test captures a pager end to end from page 2 and verifies it is restored to page 2.

## Changes in 0.6.0: compatibility checker and image viewers

- `extension/capture.js` adds a generic **page-list adapter** for viewers that show pages as large `<img>` (scanned sheets, lazy-loaded pages included) or `<canvas>` elements. Pages are found by size and shape, grouped by container, captured at native pixels, and never upscaled. Pages under 1,200 px get a warning. Cross-origin images are refused with the host named. PDF.js viewers are still detected first.
- The panel shows "saved at original resolution (W x H px)" and disables the quality setting for these viewers.
- `diagnose()` in the engine returns a read-only compatibility report. `tools/compat-check.cjs` runs the real engine on real pages (URL list or interactive mode for portals behind forms), optionally trial-captures the first pages, and writes `report.md`, `report.json` and sample PNGs. See `COMPATIBILITY.md`.
- The engine accepts a `PagePressTransport` hook so the checker can collect its messages. Extension content scripts run in an isolated world, so page scripts cannot set it.
- New fixtures (`tests/image-fixtures.cjs`) generate PNG sheets on the fly. `tests/compat.test.cjs` covers 8 viewer cases, and the extension browser test captures an image viewer end to end.

## Pricing model

Pro is sold as a 1-week pass (₹249 / US$2.99), a 1-month pass (₹449 / US$4.99) or a yearly plan (₹999 / US$12). Passes are one-time payments that expire and never renew: Razorpay orders issued by the license server, or Lemon Squeezy single-payment variants with 7/30-day license keys. Store settings come from a JSON file (`scripts/billing.example.json`) applied with `scripts/configure-billing.cjs`.


One universal price worldwide, shown in the buyer's currency: ₹999/year in India and US$12/year elsewhere. The panel shows only the price for the browser's region (INR for Indian time, USD otherwise), with a link to switch currency. Change prices in the Razorpay plan, the Lemon Squeezy variant and `scripts/configure-billing.cjs` labels together. If INR is ever made cheaper than USD, enable `INR_INDIAN_PAYMENTS_ONLY=1` on the server (see `BILLING-SETUP.md`).

## Changes in 0.4.0: INR (Razorpay) and USD pricing

- **India / INR:** new `server/` license server (Node 22.13+, built-in SQLite, no dependencies). It hosts the `/buy` checkout page with Razorpay's payment window, creates yearly Razorpay subscriptions, verifies the payment signature and signed webhooks, issues `PP-` license keys, and serves the same `/v1/licenses/validate|activate|deactivate` API shape the extension already used for Lemon Squeezy. `/manage` lets customers see renewal status, release browser activations and cancel renewal. See `server/README.md`.
- **Outside India / USD:** Lemon Squeezy stays the USD store. If it is unavailable, the server can sell a USD Razorpay plan instead.
- **Extension:** `licensing.js` now supports both stores. `PP-` keys are verified with the license server and other keys with Lemon Squeezy; each response must match its own store's product identity. The plan dialog shows one price for the buyer's region (**Pay in INR** for Indian time, **Pay in USD** elsewhere) with a switch link. Only the license host matching the key is requested as an optional permission. Older saved Lemon Squeezy licenses keep working.
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
