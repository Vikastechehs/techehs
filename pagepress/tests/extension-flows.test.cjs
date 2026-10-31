// End-to-end flows with the packaged extension (loaded from pagepress-extension.zip, so the package itself is
// tested) on an emulated Retina screen (device pixel ratio 2), against the official PDF.js 6.4 viewer app with a
// 60-page document: Stop part-way, Retry missing pages, PDF export, switching to JPEG ZIP without recapturing,
// a single Save JPEG, and the viewer's page and zoom restored.
// Run from pagepress/: node tests/extension-flows.test.cjs   (needs Playwright, Pillow and pypdf; run
// tests/pdfjs-apps.test.cjs once first so PDF.js 6.4.299 is cached, and rebuild the ZIP after changes).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PAGEPRESS_PLAYWRIGHT || 'playwright');
const { jsPDF } = require('jspdf');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, '../test-results/pagepress/extension-flows');
const APP = path.resolve(ROOT, '../test-results/pagepress/pdfjs-apps/releases/v6.4.299');
const ZIP = path.resolve(ROOT, '../pagepress-extension.zip');
const TOTAL = 60;

function longPdf() {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  for (let n = 1; n <= TOTAL; n++) {
    if (n > 1) pdf.addPage(n % 15 === 0 ? [842, 595] : [595, 842], n % 15 === 0 ? 'landscape' : 'portrait');
    pdf.setFontSize(30); pdf.text(`LONG DOCUMENT / PAGE ${n}`, 40, 70);
    pdf.setFontSize(11);
    for (let y = 110; y < pdf.internal.pageSize.getHeight() - 40; y += 22) pdf.text(`Record ${n}-${y}: the quick brown fox jumps over the lazy dog.`, 40, y);
  }
  return Buffer.from(pdf.output('arraybuffer'));
}

async function main() {
  assert.ok(fs.existsSync(path.join(APP, 'web', 'viewer.html')), 'Run tests/pdfjs-apps.test.cjs first to cache PDF.js 6.4.299.');
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  // Load the extension exactly as packaged.
  const unpacked = path.join(OUT, 'unzipped');
  execFileSync('unzip', ['-q', ZIP, '-d', unpacked]);
  const stage = path.join(unpacked, 'pagepress', 'extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  for (const file of [manifest.background.service_worker, manifest.side_panel.default_path, ...Object.values(manifest.icons)]) assert.ok(fs.existsSync(path.join(stage, file)), `Packaged file missing: ${file}`);
  manifest.host_permissions = ['http://127.0.0.1/*']; // stands in for the toolbar click that grants activeTab
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
  fs.appendFileSync(path.join(stage, 'billing-ui.js'), '\nPagePressBilling.authorize = async () => ({ allowed: true, plan: "pro", pageLimit: 200 });\n');

  const pdf = longPdf();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/document.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(pdf); return; }
    const file = path.resolve(APP, decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(APP + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': { '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/web/viewer.html?file=%2Fdocument.pdf#page=7&zoom=page-width`;
  const context = await chromium.launchPersistentContext(path.join(OUT, 'profile'), {
    executablePath: process.env.PAGEPRESS_CHROMIUM || chromium.executablePath(), headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${stage}`, `--load-extension=${stage}`], viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2
  });
  const errors = [];
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
    const id = new URL(worker.url()).host;
    const source = await context.newPage();
    await source.goto(url);
    await source.waitForFunction((n) => window.PDFViewerApplication?.pdfViewer?.pagesCount === n && document.querySelector('.page[data-loaded="true"] canvas'), TOTAL, { timeout: 60000 });
    await source.waitForTimeout(1500);
    const before = await source.evaluate(() => ({ page: PDFViewerApplication.page, scale: String(PDFViewerApplication.pdfViewer.currentScaleValue), dpr: devicePixelRatio, availWidth: screen.availWidth }));
    assert.equal(before.dpr, 2);
    const ui = await context.newPage(); ui.on('pageerror', (e) => errors.push(e.message));
    await ui.goto(`chrome-extension://${id}/index.html`);
    const cdp = await context.newCDPSession(ui);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT, eventsEnabled: true });
    await ui.evaluate(async (url) => { const tab = (await chrome.tabs.query({})).find((t) => t.url === url); await chrome.storage.local.set({ pagepressTabId: tab.id }); }, url);
    await ui.reload();
    await ui.waitForFunction((n) => document.getElementById('total').textContent === String(n), TOTAL, { timeout: 30000 });
    const latest = async () => ui.evaluate(async () => (await chrome.downloads.search({ state: 'complete', orderBy: ['-startTime'], limit: 1 }))[0]?.filename);
    const stateIs = (...states) => ui.waitForFunction((s) => s.includes(document.getElementById('state').textContent), states, { timeout: 600000 });

    // 1. Start all 60 pages at High, stop after a few, check the view is restored and pages are kept.
    await ui.locator('#from').fill('1'); await ui.locator('#to').fill(String(TOTAL));
    await ui.locator('#filename').fill('long-document.pdf');
    await ui.locator('#capture').click();
    await source.bringToFront();
    await ui.waitForFunction(() => document.querySelectorAll('.page-row').length >= 6, null, { timeout: 120000 });
    await ui.locator('#stop').click();
    await stateIs('Stopped', 'Needs attention');
    assert.equal(await ui.locator('#state').textContent(), 'Stopped', await ui.locator('#notice').textContent());
    const kept = await ui.locator('.page-row').count();
    assert.ok(kept >= 6 && kept < TOTAL, `kept ${kept} pages after Stop`);
    const restored = (b) => source.waitForFunction((b) => PDFViewerApplication.page === b.page && String(PDFViewerApplication.pdfViewer.currentScaleValue) === b.scale, b, { timeout: 20000 })
      .catch(async (error) => { throw new Error(`View not restored: expected ${JSON.stringify(b)}, got ${JSON.stringify(await source.evaluate(() => ({ page: PDFViewerApplication.page, scale: String(PDFViewerApplication.pdfViewer.currentScaleValue), select: document.getElementById('scaleSelect').value, input: document.getElementById('pageNumber').value })))}`); });
    await restored(before);
    assert.equal(await source.evaluate(() => screen.availWidth), before.availWidth, 'The PDF.js canvas-limit override is removed after the run');
    assert.equal(await ui.locator('#save').isVisible(), false, 'An incomplete capture cannot be exported as a full document');

    // 2. Retry missing pages: completes the document, exports the PDF automatically.
    await ui.locator('#resume').click();
    await source.bringToFront();
    await stateIs('Saved', 'Needs attention');
    assert.equal(await ui.locator('#state').textContent(), 'Saved', await ui.locator('#notice').textContent());
    const pages = await ui.evaluate(async () => (await PagePressStore.getPages()).sort((a, b) => a.number - b.number).map((p) => [p.number, p.width, p.height, p.warning]));
    assert.deepEqual(pages.map((p) => p[0]), Array.from({ length: TOTAL }, (_, i) => i + 1));
    for (const [n, w, h, warning] of pages) {
      assert.equal(warning, '', `page ${n} warning`);
      // Retina screen, High quality: same pixels as a standard screen at 200% (about 1,587 px for A4 width).
      const landscape = n % 15 === 0;
      assert.ok(Math.abs((landscape ? h : w) - 1587) <= 3 && Math.abs((landscape ? w : h) - 2245) <= 3, `page ${n} is ${w}x${h}`);
    }
    await restored(before);
    fs.copyFileSync(await latest(), path.join(OUT, 'long-document.pdf'));

    // 3. Switch to JPEG without recapturing; then save one page as JPEG.
    await ui.locator('#format').selectOption('jpeg');
    await ui.locator('#save').click();
    await ui.waitForFunction((n) => document.getElementById('notice').textContent.includes(`Saved ${n} separate JPEG images`), TOTAL, { timeout: 300000 });
    fs.copyFileSync(await latest(), path.join(OUT, 'long-document.zip'));
    await ui.locator('[data-jpeg="15"]').click();
    await ui.waitForFunction(() => document.getElementById('notice').textContent.includes('Saved page 15 as JPEG'), null, { timeout: 60000 });
    fs.copyFileSync(await latest(), path.join(OUT, 'page-15.jpg'));
  } finally { await context.close(); server.close(); }
  assert.deepEqual(errors, [], 'Panel script errors');

  // Independent checks of the exported files.
  const report = execFileSync('python3', ['-c', `
import sys, zipfile, io, json
from pypdf import PdfReader
from PIL import Image
out = sys.argv[1]; total = int(sys.argv[2])
reader = PdfReader(out + '/long-document.pdf')
pages = [(round(float(p.mediabox.width)), round(float(p.mediabox.height))) for p in reader.pages]
z = zipfile.ZipFile(out + '/long-document.zip')
names = z.namelist()
sizes = [Image.open(io.BytesIO(z.read(n))).size for n in names]
single = Image.open(out + '/page-15.jpg')
print(json.dumps({'pdfPages': len(pages), 'landscapePdf': [i + 1 for i, (w, h) in enumerate(pages) if w > h], 'zipNames': names[:2] + names[-1:], 'zipCount': len(names),
  'zipLandscape': [i + 1 for i, (w, h) in enumerate(sizes) if w > h], 'single': list(single.size), 'singleFormat': single.format}))
`, OUT, String(TOTAL)]).toString();
  const r = JSON.parse(report);
  assert.equal(r.pdfPages, TOTAL); assert.deepEqual(r.landscapePdf, [15, 30, 45, 60]);
  assert.equal(r.zipCount, TOTAL); assert.deepEqual(r.zipNames, ['long-document-page-001.jpg', 'long-document-page-002.jpg', 'long-document-page-060.jpg']);
  assert.deepEqual(r.zipLandscape, [15, 30, 45, 60]);
  assert.equal(r.singleFormat, 'JPEG'); assert.ok(r.single[0] > r.single[1], 'page 15 JPEG is landscape');
  console.log(JSON.stringify(r));
  console.log(`PASS: packaged ZIP on a Retina (2x) screen, PDF.js 6.4, ${TOTAL} pages: Stop keeps pages and restores the view, Retry completes, PDF/JPEG ZIP/single JPEG exports verified independently.`);
}
main().catch((error) => { console.error(error); process.exit(1); });
