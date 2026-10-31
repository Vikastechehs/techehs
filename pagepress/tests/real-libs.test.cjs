// Real third-party viewers beyond Mozilla's PDF.js app: PhotoSwipe (image lightbox with a "2 / 5" counter that
// preloads neighbouring slides), Viewer.js (image viewer without a page counter), a custom PDF.js canvas viewer
// laid out like react-pdf, and the official PDF.js app embedded in an iframe, in page-at-a-time scroll mode, with
// rotated pages and in two-page spreads. Each runs PagePress's real engine through the compatibility checker.
// Run: node tests/real-libs.test.cjs   (needs Playwright with Chromium; downloads PDF.js 6.4.299 once, as
// tests/pdfjs-apps.test.cjs does).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PAGEPRESS_PLAYWRIGHT || 'playwright');
const fixtures = require('./image-fixtures.cjs');
const { documentPdf } = require('./pdfjs-apps.test.cjs');
const { check } = require('../tools/compat-check.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, '../test-results/pagepress/real-libs');
const PDFJS = '6.4.299';
const MODULES = path.join(ROOT, 'node_modules');

function pdfjsApp() {
  const releases = path.resolve(ROOT, '../test-results/pagepress/pdfjs-apps/releases'), dir = path.join(releases, `v${PDFJS}`);
  if (!fs.existsSync(path.join(dir, 'web', 'viewer.html'))) {
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(releases, `pdfjs-${PDFJS}-dist.zip`);
    if (!fs.existsSync(zip)) execFileSync('curl', ['-sSfL', '-m', '180', '-o', zip, `https://github.com/mozilla/pdf.js/releases/download/v${PDFJS}/pdfjs-${PDFJS}-dist.zip`]);
    execFileSync('unzip', ['-qo', zip, '-d', dir]);
  }
  return dir;
}
const page = (title, head, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}<style>body{margin:0;font-family:Arial;background:#eee}</style></head><body>${body}${script}</body></html>`;
const thumbs = (n) => Array.from({ length: n }, (_, i) => i + 1);

const PAGES = {
  // PhotoSwipe 5: gallery of 5 document pages opened on page 2; the lightbox keeps the previous and next slides
  // loaded beside the visible one.
  '/photoswipe': () => page('PhotoSwipe document', '<link rel="stylesheet" href="/mod/photoswipe/dist/photoswipe.css">',
    `<div id="gallery">${thumbs(5).map((n) => `<a href="/page-image/${n}.png?tagged=1${n === 3 ? '&landscape=1' : ''}" data-pswp-width="${n === 3 ? 1754 : 1240 + n * 10}" data-pswp-height="${n === 3 ? 1270 : 1754}"><img src="/page-image/${n}.png?small=1" width="90" alt="Page ${n}"></a>`).join('')}</div>`,
    `<script type="module">import PhotoSwipeLightbox from '/mod/photoswipe/dist/photoswipe-lightbox.esm.js';
      const lightbox = new PhotoSwipeLightbox({ gallery: '#gallery', children: 'a', pswpModule: () => import('/mod/photoswipe/dist/photoswipe.esm.js'), wheelToZoom: true, initialZoomLevel: 'fit' });
      lightbox.init(); lightbox.loadAndOpen(1);</script>`),
  // Viewer.js: opens on page 2; its toolbar has Previous/Next but the default title shows no page counter.
  '/viewerjs': () => page('Viewer.js document', '<link rel="stylesheet" href="/mod/viewerjs/dist/viewer.css">',
    `<ul id="images" style="list-style:none;display:flex;gap:6px">${thumbs(5).map((n) => `<li><img src="/page-image/${n}.png?small=1" data-original="/page-image/${n}.png?tagged=1" width="90" alt="Page ${n}"></li>`).join('')}</ul>`,
    `<script src="/mod/viewerjs/dist/viewer.js"></script><script>const v = new Viewer(document.getElementById('images'), { url: 'data-original', transition: false }); v.view(1);</script>`),
  // A custom PDF.js canvas viewer, laid out the way react-pdf renders documents (one canvas per page).
  '/canvas-pdf': () => page('Custom PDF.js canvas viewer', '',
    '<div class="react-pdf__Document" id="doc" style="width:760px;margin:auto"></div>',
    `<script type="module">import * as pdfjs from '/mod/pdfjs-dist/legacy/build/pdf.mjs';
      pdfjs.GlobalWorkerOptions.workerSrc = '/mod/pdfjs-dist/legacy/build/pdf.worker.mjs';
      const pdf = await pdfjs.getDocument({ url: '/document.pdf' }).promise;
      for (let n = 1; n <= pdf.numPages; n++) {
        const p = await pdf.getPage(n), css = p.getViewport({ scale: 760 / p.getViewport({ scale: 1 }).width }), out = p.getViewport({ scale: css.scale * 2 });
        const div = document.createElement('div'); div.className = 'react-pdf__Page'; div.style.margin = '12px 0';
        const canvas = document.createElement('canvas'); canvas.className = 'react-pdf__Page__canvas'; canvas.width = out.width; canvas.height = out.height; canvas.style.width = css.width + 'px'; canvas.style.height = css.height + 'px';
        div.append(canvas); document.getElementById('doc').append(div);
        await p.render({ canvasContext: canvas.getContext('2d'), viewport: out }).promise;
      }
      document.body.dataset.ready = '1';</script>`),
  '/pdfjs-iframe': () => page('Embedded document', '', `<h1>Case file</h1><iframe src="/app/web/viewer.html?file=%2Fdocument.pdf" width="1100" height="760"></iframe>`)
};

async function startServer() {
  const app = pdfjsApp(), pdf = documentPdf();
  const server = http.createServer((req, res) => {
    if (fixtures.handle(req, res, 'http://localhost')) return;
    const url = new URL(req.url, 'http://localhost');
    if (PAGES[url.pathname]) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGES[url.pathname]()); return; }
    if (url.pathname === '/document.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(pdf); return; }
    const [base, rest] = url.pathname.startsWith('/mod/') ? [MODULES, url.pathname.slice(5)] : url.pathname.startsWith('/app/') ? [app, url.pathname.slice(5)] : [];
    const file = base && path.resolve(base, decodeURIComponent(rest));
    if (!file || !file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
async function main() {
  const { server, origin } = await startServer();
  fs.rmSync(OUT, { recursive: true, force: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 1280, height: 900 } });
  const options = { trial: 3, out: OUT, zoom: 2 };
  const results = {};
  const run = async (name, url, prepare) => {
    const tab = await context.newPage();
    const errors = []; tab.on('pageerror', (e) => errors.push(e.message));
    await tab.goto(origin + url);
    if (prepare) await prepare(tab);
    await tab.waitForTimeout(2500);
    results[name] = await check(tab, Object.keys(results).length + 1, options);
    results[name].pageErrors = errors;
    await tab.close();
    console.log(`${name.padEnd(18)} ${results[name].verdict.padEnd(11)} ${results[name].viewer || '-'} · ${results[name].pages || '-'} pages · ${(results[name].trial?.pages || []).map((p) => `${p.number}:${p.width}x${p.height}${p.warning ? '!' : ''}`).join(' ')} ${results[name].trial?.error || ''}\n${' '.repeat(19)}${(results[name].notes || []).join(' | ')}`);
  };
  const appReady = (frame = (t) => t) => async (tab) => frame(tab).waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount === 7 && document.querySelector('.page[data-loaded="true"] canvas'), null, { timeout: 60000 });
  try {
    await run('photoswipe', '/photoswipe', (t) => t.waitForSelector('.pswp__counter', { timeout: 20000 }));
    await run('viewerjs', '/viewerjs', (t) => t.waitForSelector('.viewer-canvas img', { timeout: 20000 }));
    await run('canvas-pdf', '/canvas-pdf', (t) => t.waitForSelector('body[data-ready="1"]', { timeout: 60000 }));
    await run('pdfjs-iframe', '/pdfjs-iframe', async (t) => { await t.waitForFunction(() => document.querySelector('iframe').contentWindow.PDFViewerApplication?.pdfViewer?.pagesCount === 7, null, { timeout: 60000 }); await t.waitForTimeout(2000); });
    const viewer = '/app/web/viewer.html?file=%2Fdocument.pdf';
    await run('pdfjs-page-mode', viewer, async (t) => { await appReady()(t); await t.evaluate(() => { PDFViewerApplication.pdfViewer.scrollMode = 3; PDFViewerApplication.page = 2; }); });
    await run('pdfjs-rotated', viewer, async (t) => { await appReady()(t); await t.evaluate(() => { PDFViewerApplication.pdfViewer.pagesRotation = 90; }); });
    await run('pdfjs-spread', viewer, async (t) => { await appReady()(t); await t.evaluate(() => { PDFViewerApplication.pdfViewer.pagesRotation = 0; PDFViewerApplication.pdfViewer.spreadMode = 1; }); }); // PDF.js remembers rotation per document
  } finally { await browser.close(); server.close(); }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));

  const sizes = (r) => r.trial.pages.map((p) => [p.number, p.width, p.height]);
  const ps = results.photoswipe;
  assert.equal(ps.verdict, 'supported', JSON.stringify(ps)); assert.equal(ps.viewer, 'Single-page image viewer'); assert.equal(ps.pages, 5);
  assert.equal(ps.trial.error, null, ps.trial.error);
  assert.deepEqual(sizes(ps), [[1, 1250, 1754], [2, 1260, 1754], [3, 1754, 1270]], 'PhotoSwipe: the visible slide, not a preloaded neighbour');
  const vj = results.viewerjs;
  assert.equal(vj.verdict, 'partial', JSON.stringify(vj)); assert.match(vj.notes.join(' '), /no page counter/i);
  const cp = results['canvas-pdf'];
  assert.equal(cp.verdict, 'supported', JSON.stringify(cp)); assert.equal(cp.viewer, 'Canvas page viewer'); assert.equal(cp.pages, 7);
  assert.equal(cp.trial.error, null); assert.ok(cp.trial.pages.every((p) => p.width >= 1500));
  for (const name of ['pdfjs-iframe', 'pdfjs-page-mode', 'pdfjs-spread']) {
    const r = results[name];
    assert.equal(r.verdict, 'supported', `${name}: ${JSON.stringify(r)}`); assert.equal(r.pages, 7); assert.equal(r.trial.error, null, `${name}: ${r.trial.error}`);
    assert.deepEqual(r.trial.pages.map((p) => p.width > p.height), [false, false, false], `${name}: portrait pages 1-3`);
    assert.ok(r.trial.pages.every((p) => p.width >= 1500 && !p.warning), name);
  }
  const rot = results['pdfjs-rotated'];
  assert.equal(rot.trial.error, null, rot.trial.error);
  assert.deepEqual(rot.trial.pages.map((p) => p.width > p.height), [true, true, true], 'Rotated portrait pages are saved as displayed (landscape)');
  for (const [name, r] of Object.entries(results)) assert.deepEqual(r.pageErrors, [], `${name}: page script errors`);
  console.log('PASS: PhotoSwipe (visible slide among preloaded neighbours), Viewer.js (reported as partial: no page counter), custom PDF.js canvas viewer, and the PDF.js app in an iframe, page mode, rotated and in spreads.');
}
if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });
module.exports = { startServer };
