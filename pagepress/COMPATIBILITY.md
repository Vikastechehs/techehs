# Checking which websites PagePress supports

`tools/compat-check.cjs` runs PagePress's own detection and capture engine (`extension/capture.js`, the same code the extension injects) on real document pages. It reports whether each page is supported, and saves the first captured pages so you can check them by eye. Nothing is uploaded.

## What PagePress can capture

| Viewer type | How it is detected | Quality |
| --- | --- | --- |
| **PDF.js-style viewers** | `.page[data-page-number]` canvases, `pageNumber`/`scaleSelect` controls | Re-rendered at 200% or 300% |
| **Image page viewers** (new in 0.6) | A run of large, page-shaped `<img>` elements in document order: scanned sheets, including pages that load only when scrolled to | Each image's own original resolution |
| **Canvas page viewers** (new in 0.6) | A run of large, page-shaped `<canvas>` elements without PDF.js markup | The canvas's own pixels |

Same-origin frames are searched too. Small images (logos, icons, thumbnails under 120 px on screen or 800 px of source) are ignored.

Not supported, by design or browser rules: Chrome's built-in PDF viewer (use its download button), cross-origin frames (open the frame's address in its own tab), images or canvases from another website that the browser marks unreadable, protected or DRM viewers, and single-image viewers that swap one picture with Next/Previous buttons. That last type may be added later; the checker will show how common it is.

## Running it

Install once (Node 22 and Playwright's Chromium):

```bash
cd pagepress
npm ci
npm install --no-save --package-lock=false playwright && npx playwright install chromium
```

**Most document portals need a search form, captcha or login first.** Use interactive mode: a browser window opens, you open each document as a normal user would, then press Enter in the terminal to check it.

```bash
node tools/compat-check.cjs --interactive
```

For pages that open directly from a link:

```bash
node tools/compat-check.cjs https://example.org/viewer?doc=123 https://example.org/other
node tools/compat-check.cjs --file urls.txt
```

Options: `--trial N` captures the first N pages (default 2, `0` = detect only); `--out DIR` (default `compat-results`); `--wait MS` waits extra after load (default 4000); `--headed` shows the browser in URL mode.

A trial capture moves through pages and changes the zoom like a real capture, then restores them. Only check documents you are entitled to view.

## Reading the report

`compat-results/report.md` has one row per page, and `report.json` has the full details. `samples/` holds the captured pages.

- **supported**: readable full-sheet pages at 1,200 px or wider, or a PDF.js viewer PagePress can zoom.
- **partial**: works with caveats, such as a low-resolution source image (saved as-is, never upscaled), no zoom control, or nothing rendered yet.
- **unsupported**: no viewer found, pixels blocked by browser rules, built-in PDF viewer, cross-origin frame, or the trial capture failed. The notes say which.
- **error**: the page could not be opened or checked.

Always open the sample PNGs. Check that the text is readable, the edges are complete, and watermarks or stamps are present.

## Suggested first survey

These are starting points; open a real document on each. The addresses were not checked from the development environment, so confirm each one before relying on it.

| Area | Portal |
| --- | --- |
| Bihar land records | biharbhumi.bihar.gov.in, bhuabhilekh.bihar.gov.in |
| Uttar Pradesh land records | upbhulekh.gov.in |
| Rajasthan land records | apnakhata.rajasthan.gov.in |
| Maharashtra 7/12 | bhulekh.mahabhumi.gov.in |
| Karnataka land records | landrecords.karnataka.gov.in |
| Madhya Pradesh land records | mpbhulekh.gov.in |
| Gujarat land records | anyror.gujarat.gov.in |
| Jharkhand land records | jharbhoomi.jharkhand.gov.in |
| Court orders and judgments | services.ecourts.gov.in |
| Government gazettes | egazette.gov.in |
| Libraries and archives | ndl.iitkgp.ac.in, archive.org book reader |
| Learning platforms | A Moodle or Canvas course file you have access to |

Record each result, then use the "partial" and "unsupported" notes to decide which viewer types to support next.
