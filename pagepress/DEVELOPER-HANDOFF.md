# PagePress developer handoff

This is the complete editable source for PagePress v0.3.0, not just the installable extension. The developer brief PDF is also included at the archive root.

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

For the browser integration test on a developer machine, install Playwright locally and point the existing harness at it. The harness otherwise defaults to the original author's bundled runtime paths.

```powershell
npm install --no-save --package-lock=false playwright
npx playwright install chromium
$env:PAGEPRESS_PLAYWRIGHT = (Resolve-Path .\node_modules\playwright).Path
node tests/browser.test.cjs --unconfigured
node tests/browser.test.cjs
```

The optional `PAGEPRESS_CHROMIUM` environment variable can select a compatible Chromium executable that supports loading unpacked extensions. The tests use an isolated browser profile and a mock payment provider; they do not charge anyone. Output goes to a sibling `test-results/pagepress/` folder. The Python verification scripts require Pillow, pypdf, and pypdfium2; run them after the full browser test has generated its exports. Icon regeneration also requires Pillow.

The most recent work verified the 21-page PDF/JPEG exports and independently decoded them, and exercised license activation, persistence, revocation, deactivation, and Free capture. An integration-test timing assertion was corrected and the real-viewer/license scenarios were rerun successfully; a fresh full browser run is recommended on the recipient's machine. The included tests still need an actual installed-extension smoke test on the user's target portal.

## Payment status

Free allows five pages per capture. Pro is designed for US$19/year and up to 200 pages, subject to the documented memory limits. `extension/billing-config.js` intentionally contains no configured seller identifiers or checkout URL. It has no master activation key, seller secret, or live payment setup.

The owner has selected Lemon Squeezy but still needs to create/activate the merchant account and product. Follow `BILLING-SETUP.md` to configure the public store/product/variant IDs and hosted checkout URL. Verify test and live checkout, receipt delivery, licensing, renewal and cancellation before enabling sales. Never put a secret seller API key into extension code.

## Delivery expectations

Return updated source, an installable extension ZIP, installation notes, test evidence, accurate viewer-support limitations, and updated privacy/billing disclosures. Keep document captures local. Do not promise compatibility with every website or original PDF signature/searchable-text preservation.
