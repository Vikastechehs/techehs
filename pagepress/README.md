# PagePress

Capture all rendered sheets from a PDF.js-compatible website document viewer as a high-resolution PDF or separate JPEG images. Each document sheet stays separate.

ReleaseCheck lives separately under the workspace's original `extension` folder and is not modified by this project.

## Free and Pro

Free includes up to **5 pages per capture**, PDF and JPEG export, both quality settings and capture recovery. **Pro is a yearly subscription: paid in rupees in India (Razorpay: UPI Autopay, cards, netbanking) or US$19/year elsewhere (Lemon Squeezy)**, and allows up to **200 pages per capture**, subject to the existing image/memory limits. Use **Plans & license** to upgrade, activate a purchase key, verify a license, manage billing, or deactivate the current browser. Retained captures remain exportable after Pro ends.

The included build has no merchant store configured: it works as Free and clearly marks Pro purchases unavailable. To enable actual payments and license activation, follow [BILLING-SETUP.md](BILLING-SETUP.md) and supply your public store/product/variant IDs and hosted checkout URL. Payment account setup and a live checkout smoke test are still required. No secret API keys belong in the extension.

## Install

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `pagepress/extension` in this workspace. Select this folder, not the original ReleaseCheck folder.
4. Open the website's document viewer (for example the Bihar Bhu Abhilekh document-viewer page demonstrated in this chat).
5. Click the PagePress toolbar icon. Its side panel detects the document and page count.
6. Choose **PDF document (.pdf)** or **JPEG pages (.zip)**, choose a range within your plan's page limit, choose High / 200% or Extra high / 300%, and click **Capture ... pages**. Free starts with the first five pages; activate Pro for longer ranges.

Keep the document tab and PagePress panel open, and leave the browser running. Avoid changing the document or its zoom while capture is in progress. The extension changes pages and waits for each render automatically. It restores the original page, zoom, and scroll position afterward.

When capture completes, PagePress automatically downloads the chosen format into Chrome's default Downloads location. PDF produces one document with separate pages. JPEG produces a ZIP containing one full-resolution `.jpg` per page, named in document order (for example `document-page-001.jpg`). Extract the ZIP to access the images. Enable **Ask where to save** to choose a destination. Chrome may display its normal download/save prompt. The panel marks the file Saved only when Chrome reports download completion.

After capture, change **Download format** and click **Download PDF** or **Download JPEG ZIP** to export the same pages without capturing again. Each saved page also has a **Save JPEG** button to download just that page, even when a larger capture was stopped or failed.

## Quality

- High uses the viewer's 200% render; Extra high uses 300%. Native canvas pixels are preserved as lossless PNG inside the PDF, without JPEG compression or downsampling.
- JPEG preserves the captured image dimensions and uses 95% encoding quality on a white background. JPEG compression is lossy; the locally retained PNG source and PDF export remain lossless.
- Capturing the full rendered canvas avoids viewport clipping, toolbar capture, scrollbar seams, and screen-sized resolution limits.
- Visible extra page layers, such as DOM watermarks or annotations, use the bundled html2canvas renderer. The extension fails if those layers cannot be captured; it does not silently fall back to a canvas-only image that could omit them.
- Source watermarks and unavailable-file notices are kept. Higher zoom cannot recover detail absent from an original blurry scan.
- This is an image-based PDF, not the original signed/searchable PDF. Existing embedded PDF signatures, forms, links, and text layers are not carried over as interactive PDF objects.

## Stop and Recover

Stop cancels the run, restores the view, and retains completed page images locally. **Retry missing pages** resumes only the requested pages that were not saved. If a page times out, the extension identifies it and does not automatically export an incomplete document. Try **Slow viewer** timing or reopen the original source document before retrying.

**Download PDF** or **Download JPEG ZIP** is available when all requested pages are present, including after a cancelled download or panel reload. **Clear capture** deletes saved images from extension storage after confirmation; already downloaded files remain on disk. Starting a new capture asks before replacing the old saved pages.

One capture is retained at a time. Limit: 200 requested document pages, approximately 150 MB of captured PNG data, and 32 million pixels per individual image. For larger documents, select smaller page ranges. Chrome/device memory limits can still be reached before those bounds on low-memory devices.

## Supported Viewers

The adapter targets website PDF.js-style viewers with `.page[data-page-number]` canvases and standard `pageNumber`, `numPages`, and `scaleSelect` controls. Both continuous and single-page/lazy-loading layouts are supported. Same-origin embedded viewers are detected when accessible.

If a viewer has no `scaleSelect` zoom control, PagePress cannot switch it to 200%/300% and captures the canvas at the viewer's current zoom (still subject to the 1,200-pixel minimum). If a viewer caps its canvas below the sheet's displayed size, PagePress waits for a full render, then keeps the native pixels without upscaling and marks that sheet **Review** with the actual pixel width.

Chrome's built-in PDF viewer, arbitrary image galleries, document viewers inside inaccessible cross-origin frames, canvas content blocked by browser origin rules, and protected viewers that do not expose readable rendered pages are not supported. Viewers that cap the full-sheet canvas below 1,200 pixels and render only a small viewport detail layer are also unsupported; PagePress stops instead of exporting an upscaled blurry image. Open an embedded document in its own website viewer tab where possible. The extension does not bypass browser security, request official downloads, or retrieve hidden source documents.

The Bihar viewer DOM and controls were inspected during implementation, and its first page exposed a 1,980 x 2,805 native canvas at 200% zoom. A live installed-extension smoke test on the user's exact Bihar document is still needed; automated fixture results do not establish compatibility with every portal version or every third-party viewer.

## Privacy and Permissions

No analytics, external AI, server upload, or cloud document capture is used. Rendered page images, source title/URL, and job settings remain in this extension's local IndexedDB. **Clear capture**, uninstalling, or clearing extension/browser data removes them. Export important documents before clearing browser data. Optional Pro billing uses Razorpay checkout with the seller's PagePress license server (INR) or Lemon Squeezy hosted checkout (USD), and the matching license verification; document captures are never sent to either. License credentials are stored in a separate extension-origin IndexedDB database and survive Clear capture. See [PRIVACY.md](PRIVACY.md).

- `activeTab`: access the document tab only after the user invokes the extension.
- `scripting`: run the document detection/render-capture code in that authorized page.
- `sidePanel`: keep controls and progress alongside the document.
- `storage`: remember the last source tab.
- `downloads`: save and observe completion of generated PDFs, JPEG images, and JPEG ZIP archives.
- Optional `https://api.lemonsqueezy.com/*` and license-server access (the seller's own HTTPS origin, added by `scripts/configure-billing.cjs`): only the one matching the user's license is requested, when they activate or verify Pro; used only for license API requests. No permanent document-site access is added.

No permanent all-sites host permission is requested. Website requests normally needed to render a page can still occur as the viewer loads each sheet. The extension does not deliberately fetch document-source PDFs or send captured images off the device. Optional rendering libraries are bundled, not loaded from a CDN.

## Development

```bash
cd pagepress
npm ci
npm run build
npm test
npm run test:browser
```

`npm run build` copies the pinned library distributions and their licenses into `extension/vendor`; the unpacked extension and packaged ZIP already include those files. End users do not need Node or a build step. No development server is needed to install or run this extension.

The browser test uses an isolated Chromium profile, not the user's profile. It grants loopback access only in a generated test copy to exercise script injection, then tests a 21-sheet delayed viewer, a landscape sheet, a visible overlay, an unavailable-source notice, source-view restoration, cancellation/retry, page timeout, saved state, and narrow layouts. Test artifacts are under the workspace's `test-results/pagepress` directory.

The production toolbar grant and actual side-panel activation still need a manual Chrome smoke test after loading the unpacked extension. The test's loopback permission is not present in the distributed manifest.

## Verification Results

The tests cover output-format validation, PDF/JPEG filename conversion, a 21-page automatic capture, JPEG ZIP ordering, individual JPEG downloads, JPEG range export, full-size PNGs, visible overlay preservation, an unclipped bottom edge, landscape proportions, source-unavailable warnings, restored viewing position, retained local data, cancellation/retry, loading failure, and unsupported-viewer messages. A separate six-page document is captured through the real PDF.js engine configured for full-sheet canvases, matching the portal's rendering mode.

The downloaded PDFs were reopened with an independent PDF parser and renderer: 21 pages for the full fixture, three for a resumed range, and six for the real PDF.js case. Embedded images retained at least 1,200 pixels of width in the synthetic fixture and 1,586 pixels in the real PDF.js case. PDF page aspect ratios were checked against the images, and rendered pages and the extension interface were visually inspected. Desktop, 390px, and 320px layouts were checked for horizontal overflow.
