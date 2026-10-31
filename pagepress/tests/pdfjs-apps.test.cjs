// Real-world viewer test: serves Mozilla's official, unmodified PDF.js viewer application (web/viewer.html) in
// several releases, from old versions still common on government portals to the newest, and checks that
// PagePress detects, captures, restores and exports each one, both through the compatibility checker and through
// the actual extension panel.
// Run: node tests/pdfjs-apps.test.cjs [--versions 2.16.105,6.4.299]   (needs Playwright with Chromium, and
// network access to github.com the first time to download releases; they are cached in test-results/).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PAGEPRESS_PLAYWRIGHT || 'playwright');
const { jsPDF } = require('jspdf');
const { png } = require('./image-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.resolve(ROOT, '../test-results/pagepress/pdfjs-apps');
const DEFAULT_VERSIONS = ['2.16.105', '3.11.174', '4.10.38', '5.4.296', '6.4.299'];
const versionsArg = process.argv.indexOf('--versions');
const VERSIONS = versionsArg > 0 ? process.argv[versionsArg + 1].split(',') : DEFAULT_VERSIONS;

function release(version) {
  const dir = path.join(ARTIFACTS, 'releases', `v${version}`);
  if (fs.existsSync(path.join(dir, 'web', 'viewer.html'))) return dir;
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(ARTIFACTS, 'releases', `pdfjs-${version}-dist.zip`);
  if (!fs.existsSync(zip)) execFileSync('curl', ['-sSfL', '-m', '180', '-o', zip, `https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-dist.zip`]);
  execFileSync('unzip', ['-qo', zip, '-d', dir]);
  return dir;
}

// 7 pages: text pages, a landscape page (4), a full-page scanned image (6) and a visible watermark on every page.
function documentPdf() {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const scan = png(1240, 1754, (x, y) => (x < 30 && y < 30 ? [23, 101, 75] : (x > 1210 && y > 1724 ? [195, 58, 41] : ((y % 40 < 3 && x > 80 && x < 1160) ? [70, 70, 70] : [246, 243, 234]))));
  for (let n = 1; n <= 7; n++) {
    if (n > 1) pdf.addPage(n === 4 ? [842, 595] : [595, 842], n === 4 ? 'landscape' : 'portrait');
    const w = pdf.internal.pageSize.getWidth(), h = pdf.internal.pageSize.getHeight();
    if (n === 6) pdf.addImage('data:image/png;base64,' + scan.toString('base64'), 'PNG', 0, 0, w, h);
    pdf.setFontSize(24); pdf.setTextColor(0, 0, 0); pdf.text(`REAL VIEWER TEST / PAGE ${n}`, 30, 60);
    pdf.setFontSize(12);
    for (let y = 100; y < h - 40; y += 26) pdf.text(`Land record line ${y} on sheet ${n}. Khata 123, Khesra 456.`, 30, y);
    pdf.setTextColor(200, 80, 80); pdf.setFontSize(40); pdf.text('VIEW COPY', w / 2 - 110, h / 2);
  }
  return Buffer.from(pdf.output('arraybuffer'));
}

// 4 pages with clickable links on every page, and a text field plus a ticked check box on page 2.
function formsPdf() {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  for (let n = 1; n <= 4; n++) {
    if (n > 1) pdf.addPage();
    pdf.setFontSize(26); pdf.text('ANNOTATED PAGE ' + n, 40, 70); pdf.setFontSize(12);
    for (let y = 110; y < 740; y += 24) pdf.text(`Line ${y} with ordinary text on page ${n}`, 40, y);
    pdf.setTextColor(0, 0, 200); pdf.textWithLink('Open the registry website', 40, 760, { url: 'https://example.org/registry' }); pdf.link(300, 600, 200, 40, { pageNumber: 1 }); pdf.setTextColor(0, 0, 0);
    if (n === 2) {
      const field = new pdf.AcroFormTextField(); field.fieldName = 'applicant'; field.Rect = [40, 300, 240, 30]; field.value = 'Applicant name'; pdf.addField(field);
      const box = new pdf.AcroFormCheckBox(); box.fieldName = 'agree'; box.Rect = [300, 300, 20, 20]; box.appearanceState = 'On'; pdf.addField(box);
    }
  }
  return Buffer.from(pdf.output('arraybuffer'));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.properties': 'text/plain', '.ftl': 'text/plain', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
function serve(dirs, pdf, forms = formsPdf()) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/document.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(pdf); return; }
    if (url.pathname === '/forms.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(forms); return; }
    const match = /^\/v([^/]+)\/(.*)$/.exec(url.pathname);
    const base = match && dirs[match[1]];
    const file = base && path.resolve(base, decodeURIComponent(match[2]));
    if (!file || !file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const viewerUrl = (origin, version) => `${origin}/v${version}/web/viewer.html?file=${encodeURIComponent('/document.pdf')}#page=2&zoom=page-width`;

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const dirs = Object.fromEntries(VERSIONS.map((v) => [v, release(v)]));
  const server = await serve(dirs, documentPdf());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  try {
    // 1. Compatibility checker with a 5-page trial capture on every version.
    const out = path.join(ARTIFACTS, 'compat');
    fs.rmSync(out, { recursive: true, force: true });
    const argv = process.argv;
    const formsUrl = (v) => `${origin}/v${v}/web/viewer.html?file=${encodeURIComponent('/forms.pdf')}`;
    process.argv = [argv[0], 'compat-check', '--out', out, '--wait', '6000', '--trial', '5', ...VERSIONS.map((v) => viewerUrl(origin, v)), ...VERSIONS.map(formsUrl)];
    let reports;
    try { reports = await require('../tools/compat-check.cjs').main(); } finally { process.argv = argv; }
    for (const [i, version] of VERSIONS.entries()) {
      const r = reports[i];
      assert.equal(r.verdict, 'supported', `${version}: ${JSON.stringify(r)}`);
      assert.equal(r.viewer, 'PDF.js-compatible viewer'); assert.equal(r.pages, 7, `${version} page count`);
      assert.equal(r.trial.error, null, `${version} trial: ${r.trial.error}`);
      assert.deepEqual(r.trial.pages.map((p) => p.number), [1, 2, 3, 4, 5]);
      for (const p of r.trial.pages) assert.ok(p.width >= 1500, `${version} page ${p.number} is ${p.width}px wide`);
      const landscape = r.trial.pages[3];
      assert.ok(landscape.width > landscape.height, `${version}: page 4 must stay landscape`);
      assert.ok(Math.abs(landscape.width / landscape.height - 842 / 595) < 0.02, `${version}: page 4 proportions`);
      results.push({ version, checker: 'supported', sizes: r.trial.pages.map((p) => `${p.width}x${p.height}`) });
      // Links and form fields: link-only pages take the normal path; the form page is drawn with its layer
      // (text field, check box) at exactly the sheet's size, without the viewer's border.
      const f = reports[VERSIONS.length + i];
      assert.equal(f.verdict, 'supported', `${version} forms: ${JSON.stringify(f)}`); assert.equal(f.trial.error, null, `${version} forms: ${f.trial.error}`);
      assert.deepEqual(f.trial.pages.map((p) => p.layered), [false, true, false, false], `${version}: only the form page needs the layer renderer`);
      const widths = f.trial.pages.map((p) => p.width), heights = f.trial.pages.map((p) => p.height);
      assert.ok(Math.max(...widths) - Math.min(...widths) <= 1 && Math.max(...heights) - Math.min(...heights) <= 1, `${version}: layered page has the sheet's exact size (${widths} x ${heights})`);
    }

    // 1b. High-density screens: quality is the same pixel density on every screen (Retina at Extra high used to
    //     exceed the 32-million-pixel limit; 1.25x Windows laptops used to get 250% instead of 200%).
    for (const [dpr, quality, width] of [['2', '3', 2381], ['1.25', '2', 1587]]) {
      const dprOut = path.join(ARTIFACTS, `compat-dpr-${dpr}`);
      fs.rmSync(dprOut, { recursive: true, force: true });
      process.argv = [argv[0], 'compat-check', '--out', dprOut, '--wait', '6000', '--trial', '2', '--dpr', dpr, '--quality', quality, viewerUrl(origin, VERSIONS[0]), viewerUrl(origin, VERSIONS.at(-1))];
      let dprReports;
      try { dprReports = await require('../tools/compat-check.cjs').main(); } finally { process.argv = argv; }
      for (const r of dprReports) {
        assert.equal(r.trial?.error, null, `dpr ${dpr}: ${r.url}: ${r.trial?.error}`);
        for (const p of r.trial.pages) assert.ok(Math.abs(p.width - width) <= 6, `dpr ${dpr} quality ${quality}: page ${p.number} is ${p.width}px wide, expected about ${width}`);
      }
    }

    // 2. The real extension panel on the oldest and newest versions: capture all 7 pages at Extra high (300%),
    //    confirm the viewer's page and zoom are restored, and export a PDF that an independent parser reads.
    const stage = fs.mkdtempSync(path.join(ARTIFACTS, 'extension-'));
    fs.cpSync(path.join(ROOT, 'extension'), stage, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json')));
    manifest.host_permissions = ['http://127.0.0.1/*']; // The test cannot click the toolbar icon that grants activeTab.
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
    // Pro is needed for 7 pages; grant it in this isolated copy only by stubbing the license check, never the payment flow.
    fs.appendFileSync(path.join(stage, 'billing-ui.js'), '\nPagePressBilling.authorize = async () => ({ allowed: true, plan: "pro", pageLimit: 200 });\n');
    // Full Chromium (not the headless shell) is needed to load an unpacked extension.
    const context = await chromium.launchPersistentContext(path.join(stage, 'profile'), {
      executablePath: process.env.PAGEPRESS_CHROMIUM || chromium.executablePath(), headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${stage}`, `--load-extension=${stage}`], viewport: { width: 1280, height: 940 }, acceptDownloads: true
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
      const id = new URL(worker.url()).host;
      for (const version of [VERSIONS[0], VERSIONS.at(-1)]) {
        const source = await context.newPage();
        const url = viewerUrl(origin, version);
        await source.goto(url);
        await source.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount === 7 && document.querySelector('.page[data-loaded="true"] canvas'), null, { timeout: 60000 });
        await source.waitForTimeout(1500);
        const before = await source.evaluate(() => ({ page: PDFViewerApplication.page, scale: PDFViewerApplication.pdfViewer.currentScaleValue }));
        const ui = await context.newPage();
        await ui.goto(`chrome-extension://${id}/index.html`);
        const cdp = await context.newCDPSession(ui);
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: ARTIFACTS, eventsEnabled: true });
        await ui.evaluate(async (url) => {
          await PagePressStore.clear();
          const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
          await chrome.storage.local.set({ pagepressTabId: tab.id });
        }, url);
        await ui.reload();
        await ui.waitForFunction(() => document.getElementById('total').textContent === '7', null, { timeout: 30000 });
        await ui.locator('#from').fill('1'); await ui.locator('#to').fill('7');
        await ui.locator('#quality').selectOption('3');
        await ui.locator('#filename').fill(`pdfjs-${version}.pdf`);
        await ui.locator('#capture').click();
        await source.bringToFront();
        await ui.waitForFunction(() => ['Saved', 'Needs attention'].includes(document.getElementById('state').textContent), null, { timeout: 300000 });
        assert.equal(await ui.locator('#state').textContent(), 'Saved', `${version}: ${await ui.locator('#notice').textContent()} | activity: ${(await ui.locator('#activity-list li').allTextContents()).reverse().join(' / ')}`);
        const pages = await ui.evaluate(async () => (await PagePressStore.getPages()).sort((a, b) => a.number - b.number).map((p) => ({ n: p.number, w: p.width, h: p.height, warning: p.warning })));
        assert.deepEqual(pages.map((p) => p.n), [1, 2, 3, 4, 5, 6, 7]);
        for (const p of pages) assert.ok(p.w >= 2200, `${version} page ${p.n} at 300% is only ${p.w}px wide`);
        assert.ok(pages[3].w > pages[3].h, `${version}: landscape page`);
        await source.waitForFunction((b) => PDFViewerApplication.page === b.page && String(PDFViewerApplication.pdfViewer.currentScaleValue) === String(b.scale), before, { timeout: 15000 });
        const item = await ui.evaluate(async () => (await chrome.downloads.search({ state: 'complete', orderBy: ['-startTime'], limit: 1 }))[0]);
        const saved = path.join(ARTIFACTS, `pdfjs-${version}-panel.pdf`);
        fs.copyFileSync(item.filename, saved);
        results.find((r) => r.version === version).panel = { pages: pages.length, sizes: pages.map((p) => `${p.w}x${p.h}`), warnings: pages.filter((p) => p.warning).map((p) => `${p.n}: ${p.warning}`), restored: before, pdf: saved };
        await ui.close(); await source.close();
      }
    } finally { await context.close(); }
  } finally { server.close(); }
  fs.writeFileSync(path.join(ARTIFACTS, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(`PASS: official PDF.js viewer ${VERSIONS.join(', ')}: detected, 5-page trial at native size with landscape kept; extension captured all 7 pages at 300% on ${VERSIONS[0]} and ${VERSIONS.at(-1)}, restored page and zoom, and exported PDFs.`);
}
if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });
module.exports = { documentPdf };
