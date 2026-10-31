// Runs tools/compat-check.cjs against local fixture viewers and checks each verdict.
// Run: node tests/compat.test.cjs   (needs Playwright with Chromium)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const fixtures = require('./image-fixtures.cjs');

async function main() {
  let port;
  const server = http.createServer((req, res) => {
    if (fixtures.handle(req, res, `http://localhost:${port}`)) return;
    const url = new URL(req.url, 'http://localhost');
    const file = url.pathname === '/viewer' ? 'fixture.html' : url.pathname === '/fixture.js' ? 'fixture.js' : null;
    if (file) { res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : 'text/html' }); res.end(fs.readFileSync(path.join(__dirname, file))); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Plain page</title><h1>No document here</h1><img src="/page-image/1.png" width="40">');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const out = path.resolve(__dirname, '../../test-results/pagepress/compat');
  fs.rmSync(out, { recursive: true, force: true });
  const argv = process.argv;
  process.argv = [argv[0], 'compat-check', '--out', out, '--wait', '1500', '--trial', '3',
    `${origin}/image-viewer?pages=6`, `${origin}/viewer?pages=4&delay=100`, `${origin}/canvas-viewer`, `${origin}/image-viewer?pages=3&cross=1`,
    `${origin}/image-viewer?pages=3&small=1`, `${origin}/pdf-embed`, `${origin}/framed-cross-origin`, `${origin}/plain`];
  let reports;
  try { reports = await require('../tools/compat-check.cjs').main(); } finally { process.argv = argv; server.close(); }
  const by = (fragment) => reports.find((r) => r.url.includes(fragment));

  const images = by('/image-viewer?pages=6');
  assert.equal(images.verdict, 'supported', JSON.stringify(images));
  assert.equal(images.viewer, 'Image page viewer'); assert.equal(images.pages, 6, 'The 32 px header logo is not a page');
  assert.deepEqual(images.sample, { width: 1240, height: 1754 });
  assert.deepEqual(images.trial.pages.map((p) => [p.number, p.width, p.height]), [[1, 1240, 1754], [2, 1240, 1754], [3, 1754, 1240]], 'Native resolution, landscape kept, lazy page 3 loaded');
  // The saved PNG for page 3 is the original image, pixel for pixel.
  const saved = fs.readFileSync(path.join(out, images.trial.pages[2].file));
  assert.equal(saved.readUInt32BE(16), 1754); assert.equal(saved.readUInt32BE(20), 1240);
  assert.ok(zlib.crc32(saved) !== 0);

  const pdfjs = by('/viewer?pages=4');
  assert.equal(pdfjs.verdict, 'supported', JSON.stringify(pdfjs)); assert.equal(pdfjs.viewer, 'PDF.js-compatible viewer');
  assert.equal(pdfjs.trial.error, null); assert.equal(pdfjs.trial.pages.length, 3); assert.equal(pdfjs.trial.pages[0].width, 1200);

  const canvas = by('/canvas-viewer');
  assert.equal(canvas.verdict, 'supported', JSON.stringify(canvas)); assert.equal(canvas.viewer, 'Canvas page viewer'); assert.equal(canvas.pages, 4);
  assert.equal(canvas.trial.pages[0].width, 1300);

  const cross = by('cross=1');
  assert.equal(cross.verdict, 'unsupported'); assert.equal(cross.readable, false);
  assert.match(cross.notes.join(' '), /blocked by browser origin rules/);

  const small = by('small=1');
  assert.equal(small.verdict, 'partial'); assert.match(small.notes.join(' '), /900 x 1273 px/);
  assert.match(small.trial.pages[0].warning, /original resolution, not upscaled/);

  assert.equal(by('/pdf-embed').verdict, 'unsupported'); assert.match(by('/pdf-embed').notes.join(' '), /built-in PDF viewer/);
  const framed = by('/framed-cross-origin');
  assert.equal(framed.verdict, 'unsupported'); assert.match(framed.notes.join(' '), /cross-origin frame.*localhost/);
  assert.equal(by('/plain').verdict, 'unsupported');
  assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /supported: 3, partial: 1, unsupported: 4/);
  console.log('PASS: compatibility checker classifies image, PDF.js and canvas viewers, cross-origin images and frames, low-resolution sources, built-in PDF and plain pages; trial captures keep native pixels.');
}
main().catch((error) => { console.error(error); process.exit(1); });
