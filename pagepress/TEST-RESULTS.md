# PagePress 0.3.1 test results

Run on 30 October 2026 in a Linux container (Node 22, headless Chromium via Playwright, isolated profile). Payment provider responses were mocked; no real checkout or payment was made.

| Suite | Command | Result |
| --- | --- | --- |
| Unit: ranges, ordering, proportions, filenames | `npm test` (`tests/core.test.cjs`) | Pass |
| Unit: licensing (product/email mismatch, expired, disabled, activation limit, revoked instance, no cached Pro flag, permission denial, connection failure, unreadable provider response, deactivation retention) | `npm test` (`tests/licensing.test.cjs`) | Pass, 16/16 tests total |
| Browser: unconfigured build stays Free, purchases and activation disabled, narrow plan layouts fit | `node tests/browser.test.cjs --unconfigured` | Pass |
| Browser: Free 5-page gate, hosted checkout does not unlock, invalid key, Pro activation and persistence across panel reload, billing portal, revocation, deactivation; 21-sheet capture with delayed rendering, landscape sheet, visible overlay layer, unavailable-source warning, view restoration, Stop/Retry missing, page timeout, no incomplete export, individual Save JPEG, format switch without recapture, 390/320 px layouts; real PDF.js 6-page document | `node tests/browser.test.cjs` | Pass |
| Independent PDF check (pypdf + pypdfium2): 21, 3 and 6 pages; embedded image widths ≥ 1,200 / 1,200 / 1,586 px; page aspect ratios match images | `python3 tests/verify_pdfs.py` | Pass |
| Independent JPEG check (Pillow): 24 ordered JPEGs decode at captured dimensions; individual JPEG matches; source stamp retained | `python3 tests/verify_jpegs.py` | Pass |

The browser test stages a 64 KiB transfer-part size, so every captured page in it crossed the new multi-part transfer path.

## Not verified here

- The reduced-resolution (capped canvas) warning path has no automated test.
- Toolbar-icon `activeTab` grant and side-panel opening in a normal, non-test Chrome install.
- Live behaviour on the user's Bihar portal document.
- Real Lemon Squeezy checkout, receipt delivery, activation, renewal and expiry: the merchant store does not exist yet.
