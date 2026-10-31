#!/usr/bin/env node
// PagePress compatibility checker: runs PagePress's own detection and capture engine (extension/capture.js) on
// real document pages and reports whether each is supported, with sample page images for review.
//
//   node tools/compat-check.cjs URL [URL ...]          load each page, wait, check
//   node tools/compat-check.cjs --file urls.txt         one URL per line (# comments allowed)
//   node tools/compat-check.cjs --interactive           visible browser: you open each document (search forms,
//                                                       captchas, logins), then press Enter to check it
// Options: --trial N (capture the first N pages, default 2, 0 = detect only)  --out DIR (default compat-results)
//          --wait MS (extra wait after load, default 4000)  --headed (show the browser in URL mode)
//
// A trial capture changes the page and zoom like a real capture, then restores them. Only check documents you
// are entitled to view. Nothing is uploaded; reports and samples are written to --out.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { chromium } = require(process.env.PAGEPRESS_PLAYWRIGHT || 'playwright');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = ['extension/vendor/html2canvas.min.js', 'extension/capture.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));

function parseArgs(argv) {
  const options = { urls: [], trial: 2, out: 'compat-results', wait: 4000, interactive: false, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${arg} needs a value.`); return argv[++i]; };
    if (arg === '--file') options.urls.push(...fs.readFileSync(next(), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
    else if (arg === '--trial') options.trial = Math.max(0, Math.min(5, Number(next()) || 0));
    else if (arg === '--out') options.out = next();
    else if (arg === '--wait') options.wait = Math.max(0, Number(next()) || 0);
    else if (arg === '--interactive') options.interactive = true;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--help' || arg === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
    else if (/^https?:\/\//.test(arg)) options.urls.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.interactive && !options.urls.length) throw new Error('Give one or more URLs, --file urls.txt, or --interactive. Use --help for details.');
  return options;
}

// Load the engine into the page. evaluate() is not subject to the site's Content-Security-Policy.
async function loadEngine(page) {
  if (await page.evaluate(() => !!globalThis.PagePressCapture).catch(() => false)) return;
  for (const source of ENGINE) await page.evaluate(source);
}

// Run the real capture engine for the first pages, collecting its messages instead of sending them to the panel.
async function trialCapture(page, count, timeoutMs) {
  return page.evaluate(async ({ count, timeoutMs }) => {
    const info = PagePressCapture.inspect(), pages = [], chunks = {};
    let finished = null;
    globalThis.PagePressTransport = async (message) => {
      if (message.type === 'chunk') (chunks[message.number] ||= []).push(message.data);
      if (message.type === 'page') { pages.push({ ...message.page, data: chunks[message.page.number].join('') }); delete chunks[message.page.number]; }
      if (message.type === 'finished') finished = message;
      return { ok: true };
    };
    const numbers = Array.from({ length: Math.min(count, info.total) }, (_, i) => i + 1);
    // Same as the extension panel: lift the PDF.js 5+ screen-size canvas limit for the capture, then restore it.
    const windows = [];
    (function walk(win, depth) { windows.push(win); if (depth < 2) for (let i = 0; i < win.frames.length; i++) { try { void win.frames[i].document; walk(win.frames[i], depth + 1); } catch { /* cross-origin */ } } })(window, 0);
    const limit = (lift) => { for (const win of windows) for (const name of ['availWidth', 'availHeight']) { if (lift) Object.defineProperty(win.screen, name, { get: () => 32768, configurable: true }); else delete win.screen[name]; } };
    limit(true);
    PagePressCapture.start({ id: 'compat-' + Date.now(), pages: numbers, zoom: 2, settleMs: 800, timeoutMs, sourceUrl: location.href });
    const started = Date.now();
    while (!finished && Date.now() - started < timeoutMs * (numbers.length + 1)) await new Promise((r) => setTimeout(r, 200));
    delete globalThis.PagePressTransport;
    limit(false);
    return { pages, error: finished ? finished.error : 'Timed out waiting for the trial capture.' };
  }, { count, timeoutMs });
}

async function check(page, index, options) {
  const report = { index, url: page.url() };
  try {
    await loadEngine(page);
    Object.assign(report, await page.evaluate(() => PagePressCapture.diagnose()));
    if (options.trial && report.viewer && report.readable !== false) {
      const trial = await trialCapture(page, options.trial, 30000);
      report.trial = { error: trial.error || null, pages: trial.pages.map(({ data, ...p }) => p) };
      fs.mkdirSync(path.join(options.out, 'samples'), { recursive: true });
      for (const p of trial.pages) {
        const file = path.join('samples', `${index}-page-${String(p.number).padStart(3, '0')}.png`);
        fs.writeFileSync(path.join(options.out, file), Buffer.from(p.data.split(',')[1], 'base64'));
        report.trial.pages.find((t) => t.number === p.number).file = file;
      }
      if (trial.error) { report.verdict = 'unsupported'; report.notes.push(`Trial capture failed: ${trial.error}`); }
      else if (trial.pages.some((p) => p.warning)) report.notes.push(...new Set(trial.pages.filter((p) => p.warning).map((p) => `Page ${p.number}: ${p.warning}`)));
    }
  } catch (error) {
    report.verdict = 'error'; report.notes = [...(report.notes || []), `Check failed: ${error.message.split('\n')[0]}`];
  }
  return report;
}

function writeReports(reports, out) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(reports, null, 2));
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = reports.map((r) => `| ${r.index} | ${cell(r.verdict)} | ${cell(r.title || '')}<br>${cell(r.url)} | ${cell(r.viewer || '-')} | ${r.pages || '-'} | ${r.sample ? `${r.sample.width} x ${r.sample.height}` : '-'} | ${cell((r.notes || []).join(' '))} |`);
  const counts = ['supported', 'partial', 'unsupported', 'error'].map((v) => `${v}: ${reports.filter((r) => r.verdict === v).length}`).join(', ');
  fs.writeFileSync(path.join(out, 'report.md'), `# PagePress compatibility report\n\n${new Date().toISOString()} · ${counts}\n\n| # | Verdict | Page | Viewer | Pages | Sample px | Notes |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\nVerdicts: **supported** = readable full-sheet pages at 1,200 px or more (or a zoomable PDF.js viewer); **partial** = works with caveats (low source resolution, no zoom control, nothing rendered yet); **unsupported** = no viewer found, unreadable pixels, or the trial capture failed. Sample images are in \`samples/\`.\n`);
}
const line = (r) => `${String(r.index).padStart(2)}  ${r.verdict.toUpperCase().padEnd(11)} ${(r.viewer || '-').padEnd(26)} ${String(r.pages || '-').padStart(4)} pages  ${r.url}${r.notes?.length ? '\n      ' + r.notes.join('\n      ') : ''}`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({ headless: !(options.interactive || options.headed) });
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 1280, height: 900 }, acceptDownloads: false });
  const reports = [];
  try {
    if (options.interactive) {
      let active = await context.newPage();
      // Portals often open the document in a new tab; check whichever tab was opened or navigated last.
      const track = (p) => { active = p; p.on('framenavigated', (f) => { if (f === p.mainFrame()) active = p; }); };
      track(active); context.on('page', track);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = () => new Promise((resolve) => rl.question('\nOpen a document in the browser window, then press Enter to check it (q + Enter to finish): ', resolve));
      while ((await ask()).trim().toLowerCase() !== 'q') {
        const report = await check(active, reports.length + 1, options);
        reports.push(report); console.log(line(report)); writeReports(reports, options.out);
      }
      rl.close();
    } else {
      for (const url of options.urls) {
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: 'load', timeout: 60000 });
          await page.waitForTimeout(options.wait);
          const report = await check(page, reports.length + 1, options);
          reports.push(report); console.log(line(report));
        } catch (error) {
          const report = { index: reports.length + 1, url, verdict: 'error', notes: [`Could not open: ${error.message.split('\n')[0]}`] };
          reports.push(report); console.log(line(report));
        } finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }
  writeReports(reports, options.out);
  console.log(`\nReport: ${path.join(options.out, 'report.md')}`);
  return reports;
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
module.exports = { main, parseArgs };
