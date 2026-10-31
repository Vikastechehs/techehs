const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PAGEPRESS_PLAYWRIGHT || 'playwright');

async function main() {
  const unconfigured = process.argv.includes('--unconfigured');
  const root = path.resolve(__dirname, '..');
  const artifacts = path.resolve(root, '../test-results/pagepress');
  fs.mkdirSync(artifacts, { recursive: true });
  const stage = fs.mkdtempSync(path.join(artifacts, 'isolated-'));
  fs.cpSync(path.join(root, 'extension'), stage, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json')));
  manifest.host_permissions = ['http://127.0.0.1/*', 'https://api.lemonsqueezy.com/*', 'https://licenses.pagepress.test/*'];
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
  // Small parts make every test page cross the multi-message transfer path used for very large sheets.
  const captureFile = path.join(stage, 'capture.js'), captureSource = fs.readFileSync(captureFile, 'utf8');
  assert.ok(captureSource.includes('const CHUNK_CHARS = 8 * 1048576;'));
  fs.writeFileSync(captureFile, captureSource.replace('const CHUNK_CHARS = 8 * 1048576;', 'const CHUNK_CHARS = 64 * 1024;'));
  if (!unconfigured) fs.writeFileSync(path.join(stage, 'billing-config.js'), 'globalThis.PagePressBillingConfig = Object.freeze(' + JSON.stringify({ razorpay: { serverUrl: 'https://licenses.pagepress.test', inrPriceLabel: '₹999/year' }, lemonsqueezy: { storeId: 11, productId: 22, variantId: 33, checkoutUrl: 'https://pagepress-test.lemonsqueezy.com/buy/test-product', priceLabel: '$12/year' } }) + ');');
  const { jsPDF } = require('jspdf');
  const realPdf = new jsPDF({ unit: 'pt', format: 'a4' });
  for (let n = 1; n <= 6; n++) {
    if (n > 1) realPdf.addPage(n === 4 ? [595, 260] : [595, 842], n === 4 ? 'landscape' : 'portrait');
    realPdf.setFontSize(25); realPdf.text(`REAL PDF.JS / PAGE ${n}`, 30, 65);
    realPdf.setFontSize(13);
    for (let y = 100; y < realPdf.internal.pageSize.getHeight() - 30; y += 30) realPdf.text(`Actual PDF text, rendered by PDF.js. Sheet ${n}, line ${y}.`, 30, y);
    realPdf.setTextColor(220, 120, 120); realPdf.text('SOURCE WATERMARK', 150, 190); realPdf.setTextColor(0, 0, 0);
  }
  fs.writeFileSync(path.join(artifacts, 'real-source.pdf'), Buffer.from(realPdf.output('arraybuffer')));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/pdfjs/')) {
      const base = path.resolve(root, 'node_modules/pdfjs-dist');
      const file = path.resolve(base, url.pathname.slice('/pdfjs/'.length));
      if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': file.endsWith('.mjs') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
      res.end(fs.readFileSync(file)); return;
    }
    if (url.pathname === '/real-document.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(fs.readFileSync(path.join(artifacts, 'real-source.pdf'))); return; }
    const file = url.pathname === '/viewer' ? 'fixture.html' : url.pathname === '/fixture.js' ? 'fixture.js' : url.pathname === '/real-viewer' ? 'real-viewer.html' : url.pathname === '/real-viewer.js' ? 'real-viewer.js' : null;
    if (file) { res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : 'text/html' }); res.end(fs.readFileSync(path.join(__dirname, file))); }
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Unsupported page</title><h1>No document viewer</h1>'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context;
  const errors = [];
  const sourceErrors = [];
  const realOnly = process.argv.includes('--real-only');
  let captured = [], restored = null, resumedNumbers = [];
  try {
    const executablePath = process.env.PAGEPRESS_CHROMIUM || chromium.executablePath();
    context = await chromium.launchPersistentContext(path.join(stage, 'profile'), {
      executablePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${stage}`, `--load-extension=${stage}`], viewport: { width: 1280, height: 940 }, timezoneId: 'America/New_York'
    });
    console.log('Browser launched.');
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
    console.log('Extension worker loaded.');
    const id = new URL(worker.url()).host;
    if (!unconfigured) {
      // Mock only in isolated test pages: never contact a payment service or take a payment.
      await context.addInitScript(() => {
        if (location.protocol !== 'chrome-extension:') return;
        globalThis.licenseTest = JSON.parse(localStorage.getItem('pagepress-test-provider') || 'null') || { active: false, disabled: false, calls: [] };
        globalThis.fetch = async (url, options) => {
          if (!String(url).startsWith('https://api.lemonsqueezy.com/v1/licenses/')) throw new Error('Unexpected test request');
          const action = String(url).split('/').pop(), params = Object.fromEntries(new URLSearchParams(options.body));
          licenseTest.calls.push({ action, params });
          const validKey = params.license_key === 'TEST-PAGEPRESS-PRO-KEY';
          const valid = validKey && !licenseTest.disabled && (!params.instance_id || licenseTest.active && params.instance_id === 'test-browser-instance');
          if (action === 'activate' && valid) licenseTest.active = true;
          const data = { valid, activated: action === 'activate' && valid, deactivated: action === 'deactivate' && validKey, error: valid ? null : 'Invalid or expired test license.',
            license_key: { key: params.license_key, status: licenseTest.disabled ? 'disabled' : licenseTest.active ? 'active' : 'inactive', expires_at: null },
            instance: { id: 'test-browser-instance' }, meta: { store_id: 11, product_id: 22, variant_id: 33, customer_email: 'buyer@example.com' } };
          if (action === 'deactivate') licenseTest.active = false;
          localStorage.setItem('pagepress-test-provider', JSON.stringify(licenseTest));
          return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
      });
      await context.route('https://pagepress-test.lemonsqueezy.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Isolated checkout test. No payment collected.</h1>' }));
      await context.route('https://licenses.pagepress.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Isolated Razorpay checkout test. No payment collected.</h1>' }));
    }
    const source = await context.newPage(); await source.setViewportSize({ width: 640, height: 760 });
    source.on('pageerror', (error) => sourceErrors.push(error.message));
    await source.goto(origin + '/viewer');
    await source.locator('.page[data-loaded="true"]').waitFor();
    const ui = await context.newPage(); ui.on('pageerror', (error) => errors.push(error.message));
    ui.on('console', (message) => { if (message.type() === 'error') console.error('Panel console:', message.text()); });
    await ui.goto(`chrome-extension://${id}/index.html`);
    console.log('Panel loaded.');
    await ui.evaluate(() => Promise.race([PagePressBilling.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Billing initialization timed out')), 20000))]));
    console.log('Billing initialized.');
    if (unconfigured) {
      await ui.locator('#plans-open').click();
      assert.equal(await ui.locator('#upgrade').isDisabled(), true);
      assert.equal(await ui.locator('#activate-license').isDisabled(), true);
      assert.match(await ui.locator('#billing-status').textContent(), /not available yet/);
      for (const width of [390, 320]) {
        await ui.setViewportSize({ width, height: 940 });
        assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('plans-dialog').scrollWidth <= document.getElementById('plans-dialog').clientWidth), true);
        await ui.screenshot({ path: path.join(artifacts, `plans-unconfigured-${width}.png`) });
      }
      console.log('PASS: shipped unconfigured build stays Free and clearly disables purchases and activation; narrow plan layouts fit.');
      return;
    }
    const cdp = await context.newCDPSession(ui);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: artifacts, eventsEnabled: true });
    async function selectSource(url) {
      await source.goto(url); await source.locator('body').waitFor({ state: 'attached' });
      if (new URL(url).pathname !== '/unsupported') await source.locator('.page[data-loaded="true"]').waitFor({ timeout: 30000 });
      await ui.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({}); const selected = tabs.find((t) => t.url === url);
        await chrome.storage.local.set({ pagepressTabId: selected.id });
      }, url);
      await ui.locator('#detect').click();
    }
    async function retainDownload(name) {
      const item = await ui.evaluate(async () => (await chrome.downloads.search({ state: 'complete', orderBy: ['-startTime'], limit: 1 }))[0]);
      assert.ok(item && fs.existsSync(item.filename), 'Chrome must report an existing completed download');
      fs.copyFileSync(item.filename, path.join(artifacts, name));
    }
    // First exercise the Free gate and the real UI activation flow.
    await ui.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({}); const selected = tabs.find((t) => t.url === url);
      await chrome.storage.local.set({ pagepressTabId: selected.id });
    }, origin + '/viewer');
    await ui.locator('#detect').click();
    await ui.waitForFunction(() => document.getElementById('total').textContent === '21');
    assert.equal(await ui.locator('#to').inputValue(), '5');
    await ui.locator('#to').fill('21'); await ui.locator('#capture').click();
    await ui.locator('#plans-dialog').waitFor({ state: 'visible' });
    assert.equal(await ui.evaluate(async () => (await PagePressStore.getPages()).length), 0);
    assert.match(await ui.locator('#notice').textContent(), /up to 5 pages/);
    // The browser runs in New York time, so the universal price is shown in USD until the buyer switches currency.
    assert.match(await ui.locator('#upgrade').textContent(), /Pay in USD · \$12\/year/);
    assert.equal(await ui.locator('#upgrade-inr').isVisible(), false, 'Buyers outside India see only the USD price');
    assert.equal(await ui.locator('#pro-price').textContent(), '$12/year');
    await ui.locator('#switch-region').click();
    assert.match(await ui.locator('#upgrade-inr').textContent(), /Pay in INR · ₹999\/year/);
    assert.equal(await ui.locator('#upgrade').isVisible(), false);
    assert.equal(await ui.locator('#pro-price').textContent(), '₹999/year');
    for (const width of [390, 320]) {
      await ui.setViewportSize({ width, height: 760 });
      assert.equal(await ui.evaluate(() => document.getElementById('plans-dialog').scrollWidth <= document.getElementById('plans-dialog').clientWidth), true);
      await ui.screenshot({ path: path.join(artifacts, `plans-free-${width}.png`) });
    }
    await ui.setViewportSize({ width: 1280, height: 940 });
    const inrTabEvent = context.waitForEvent('page'); await ui.locator('#upgrade-inr').click();
    const inrTab = await inrTabEvent; await inrTab.waitForURL('https://licenses.pagepress.test/buy?currency=INR');
    await inrTab.close(); await ui.bringToFront();
    assert.equal(await ui.locator('#plan-name').textContent(), 'Free plan', 'Opening Razorpay checkout alone never unlocks Pro');
    await ui.locator('#switch-region').click();
    assert.equal(await ui.locator('#upgrade').isVisible(), true);
    const checkoutTabEvent = context.waitForEvent('page'); await ui.locator('#upgrade').click();
    const checkoutTab = await checkoutTabEvent; await checkoutTab.waitForURL('https://pagepress-test.lemonsqueezy.com/buy/test-product');
    await checkoutTab.close(); await ui.bringToFront();
    assert.equal(await ui.locator('#plan-name').textContent(), 'Free plan', 'Opening checkout alone never unlocks Pro');
    await ui.locator('#license-email').fill('buyer@example.com'); await ui.locator('#license-key').fill('WRONG-KEY');
    await ui.locator('#activate-license').click();
    await ui.waitForFunction(() => document.getElementById('billing-status').textContent.includes('Invalid or expired'));
    assert.equal(await ui.locator('#plan-name').textContent(), 'Free plan');
    await ui.locator('#license-key').fill('TEST-PAGEPRESS-PRO-KEY'); await ui.locator('#activate-license').click();
    await ui.waitForFunction(() => document.getElementById('plan-name').textContent === 'Pro plan');
    assert.equal(await ui.locator('#license-key').inputValue(), '');
    for (const width of [390, 320]) {
      await ui.setViewportSize({ width, height: 940 });
      assert.equal(await ui.evaluate(() => document.getElementById('plans-dialog').scrollWidth <= document.getElementById('plans-dialog').clientWidth), true);
      await ui.screenshot({ path: path.join(artifacts, `plans-pro-${width}.png`) });
    }
    await ui.locator('#plans-close').click(); await ui.setViewportSize({ width: 1280, height: 940 });
    await ui.reload(); await ui.waitForFunction(() => document.getElementById('plan-name').textContent === 'Pro plan');
    if (!realOnly) {
    await ui.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({}); const selected = tabs.find((t) => t.url === url);
      await chrome.storage.local.set({ pagepressTabId: selected.id });
    }, origin + '/viewer');
    await ui.locator('#detect').click();
    await ui.waitForFunction(() => document.getElementById('total').textContent === '21');
    await ui.locator('#filename').fill('pagepress-21-pages.pdf');
    await ui.locator('#capture').click();
    await ui.waitForFunction(() => document.querySelectorAll('.page-row').length >= 2, null, { timeout: 30000 });
    const during = await ui.evaluate(() => ({ completed: document.querySelectorAll('.page-row').length, state: document.getElementById('state').textContent }));
    assert.equal(during.state, 'Capturing');
    await ui.waitForFunction(() => document.getElementById('state').textContent === 'Saved' || document.getElementById('state').textContent === 'Needs attention', null, { timeout: 180000 });
    assert.equal(await ui.locator('#state').textContent(), 'Saved', await ui.locator('#notice').textContent());
    assert.equal(await ui.locator('.page-row').count(), 21);
    captured = await ui.evaluate(async () => {
      const records = await PagePressStore.getPages();
      return records.map((p) => ({ number: p.number, width: p.width, height: p.height, layered: p.layered, warning: p.warning }));
    });
    assert.deepEqual(captured.map((p) => p.number), Array.from({ length: 21 }, (_, i) => i + 1));
    assert.ok(captured.every((p) => p.width >= 1200));
    assert.ok(captured[12].width > captured[12].height);
    assert.equal(captured[4].layered, true);
    assert.match(captured[16].warning, /unavailable/);
    const page5 = await ui.evaluate(async () => {
      const record = (await PagePressStore.getPages()).find((p) => p.number === 5);
      const image = new Image(); image.src = record.data; await image.decode();
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
      const red = [...ctx.getImageData(image.width - 60, image.height - 60, 1, 1).data];
      return { red, width: image.width, height: image.height, data: record.data };
    });
    assert.deepEqual(page5.red.slice(0, 3), [195, 58, 41], 'Bottom-right document content must not be clipped by the viewer');
    fs.writeFileSync(path.join(artifacts, 'layered-page.png'), Buffer.from(page5.data.split(',')[1], 'base64'));
    restored = await source.evaluate(() => ({ page: document.getElementById('pageNumber').value, scale: document.getElementById('scaleSelect').value }));
    assert.deepEqual(restored, { page: '4', scale: '0.5' });
    await retainDownload('pagepress-21-pages.pdf');
    await ui.locator('#format').selectOption('jpeg');
    assert.equal(await ui.locator('#filename').inputValue(), 'pagepress-21-pages.zip');
    await ui.locator('#save').click();
    await ui.waitForFunction(() => document.getElementById('notice').textContent.includes('Saved 21 separate JPEG'), null, { timeout: 60000 });
    await retainDownload('pagepress-21-jpegs.zip');
    const jpegFiles = require('fflate').unzipSync(fs.readFileSync(path.join(artifacts, 'pagepress-21-jpegs.zip')));
    assert.deepEqual(Object.keys(jpegFiles), Array.from({ length: 21 }, (_, i) => `pagepress-21-pages-page-${String(i + 1).padStart(3, '0')}.jpg`));
    for (const bytes of Object.values(jpegFiles)) assert.deepEqual([...bytes.slice(0, 3)], [255, 216, 255]);
    await ui.locator('[data-jpeg="13"]').click();
    await ui.waitForFunction(() => document.getElementById('notice').textContent.includes('Saved page 13 as JPEG'), null, { timeout: 30000 });
    await retainDownload('pagepress-page-013.jpg');
    for (const width of [1280, 390, 320]) {
      await ui.setViewportSize({ width, height: 940 });
      assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow at ${width}px`);
      await ui.screenshot({ path: path.join(artifacts, `extension-${width}.png`) });
    }
    await ui.reload();
    await ui.waitForFunction(() => document.querySelectorAll('.page-row').length === 21);
    await ui.locator('#save').waitFor({ state: 'visible' });
    assert.equal(await ui.locator('#save').isVisible(), true);
    assert.equal(await ui.locator('#format').inputValue(), 'jpeg');
    await ui.locator('#format').selectOption('pdf');
    assert.equal(await ui.locator('#filename').inputValue(), 'pagepress-21-pages.pdf');

    await ui.setViewportSize({ width: 720, height: 940 });
    await selectSource(origin + '/viewer?pages=6&delay=500');
    await ui.locator('#from').fill('2'); await ui.locator('#to').fill('4');
    await ui.locator('#filename').fill('pagepress-resumed-range.pdf');
    await ui.locator('#format').selectOption('jpeg');
    await ui.locator('#capture').click(); await ui.locator('button[value="confirm"]').click();
    await ui.waitForFunction(() => document.querySelectorAll('.page-row').length >= 1, null, { timeout: 30000 });
    await ui.locator('#stop').click();
    await ui.waitForFunction(() => document.getElementById('state').textContent === 'Stopped', null, { timeout: 15000 });
    assert.equal(await ui.locator('#resume').isVisible(), true);
    assert.equal(await ui.locator('#save').isVisible(), false);
    await ui.locator('#resume').click();
    await ui.waitForFunction(() => document.getElementById('state').textContent === 'Saved' || document.getElementById('state').textContent === 'Needs attention', null, { timeout: 60000 });
    assert.equal(await ui.locator('#state').textContent(), 'Saved', await ui.locator('#notice').textContent());
    resumedNumbers = await ui.evaluate(async () => (await PagePressStore.getPages()).map((p) => p.number));
    assert.deepEqual(resumedNumbers, [2, 3, 4]);
    await retainDownload('pagepress-resumed-range.zip');
    await ui.locator('#format').selectOption('pdf');
    await ui.locator('#save').click();
    await ui.waitForFunction(() => document.getElementById('notice').textContent.includes('Saved one PDF with 3 separate pages'), null, { timeout: 30000 });
    await retainDownload('pagepress-resumed-range.pdf');

    await selectSource(origin + '/viewer?pages=3&delay=100&fail=2');
    await worker.evaluate(async () => {
      const { pagepressTabId } = await chrome.storage.local.get('pagepressTabId');
      await chrome.scripting.executeScript({ target: { tabId: pagepressTabId }, func: () => {
        const original = globalThis.PagePressCapture.start;
        globalThis.PagePressCapture.start = (config) => original({ ...config, timeoutMs: 1800 });
      } });
    });
    await ui.locator('#from').fill('1'); await ui.locator('#to').fill('3');
    await ui.locator('#capture').click(); await ui.locator('button[value="confirm"]').click();
    await ui.waitForFunction(() => document.getElementById('state').textContent === 'Needs attention', null, { timeout: 30000 });
    assert.match(await ui.locator('#notice').textContent(), /Page 2 did not finish rendering/);
    assert.equal(await ui.locator('.page-row').count(), 1);
    assert.equal(await ui.locator('#save').isVisible(), false, 'An incomplete PDF must not be downloadable');
    assert.equal(await ui.locator('#resume').isVisible(), true);
    await ui.locator('[data-jpeg="1"]').click();
    await ui.waitForFunction(() => document.getElementById('notice').textContent.includes('Saved page 1 as JPEG'), null, { timeout: 30000 });
    assert.equal(await ui.locator('#state').textContent(), 'Needs attention');
    assert.equal(await ui.locator('#resume').isVisible(), true);
    assert.equal(await ui.locator('#save').isVisible(), false);
    }

    await selectSource(origin + '/real-viewer');
    await ui.locator('#from').fill('1'); await ui.locator('#to').fill('6');
    await ui.locator('#filename').fill('pagepress-real-pdfjs.pdf');
    await ui.locator('#capture').click(); if (!realOnly) await ui.locator('button[value="confirm"]').click();
    // The previous scenario leaves "Needs attention" displayed; wait for this run to start before awaiting its outcome.
    await ui.waitForFunction(() => document.getElementById('state').textContent === 'Capturing', null, { timeout: 30000 });
    await source.bringToFront();
    if (realOnly) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      console.log('Real viewer DOM:', JSON.stringify(await source.evaluate(() => ({ visibility: document.visibilityState, page: document.getElementById('pageNumber').value, zoom: document.getElementById('scaleSelect').value, pages: [...document.querySelectorAll('.page')].map((p) => ({ number: p.dataset.pageNumber, loaded: p.dataset.loaded, bounds: { width: p.clientWidth, height: p.clientHeight }, canvases: [...p.querySelectorAll('canvas')].map((c) => ({ width: c.width, height: c.height, cssWidth: c.getBoundingClientRect().width, parent: c.parentElement.className })) })) })), null, 2));
    }
    await ui.waitForFunction(() => document.getElementById('state').textContent === 'Saved' || document.getElementById('state').textContent === 'Needs attention', null, { timeout: 120000 });
    assert.equal(await ui.locator('#state').textContent(), 'Saved', await ui.locator('#notice').textContent());
    await ui.bringToFront();
    const realPages = await ui.evaluate(async () => (await PagePressStore.getPages()).map((p) => ({ number: p.number, width: p.width, height: p.height })));
    assert.equal(realPages.length, 6);
    assert.ok(realPages.every((p) => p.width >= 1500));
    assert.ok(realPages[3].width > realPages[3].height);
    await retainDownload('pagepress-real-pdfjs.pdf');

    await ui.locator('#plans-open').click();
    const portalEvent = context.waitForEvent('page'); await ui.locator('#manage-billing').click();
    const portal = await portalEvent; await portal.waitForURL('https://pagepress-test.lemonsqueezy.com/billing'); await portal.close(); await ui.bringToFront();
    await ui.evaluate(() => { licenseTest.disabled = true; });
    await ui.locator('#refresh-license').click(); await ui.waitForFunction(() => document.getElementById('plan-name').textContent === 'Free plan');
    await ui.locator('#plans-close').click();
    // A revoked license cannot start a new six-page run or destroy the retained six-page capture.
    await ui.locator('#capture').click(); await ui.locator('#plans-dialog').waitFor({ state: 'visible' });
    assert.equal(await ui.locator('.page-row').count(), 6);
    await ui.locator('#deactivate-license').click();
    await ui.waitForFunction(() => !document.getElementById('license-form').hidden);
    assert.equal(await ui.evaluate(async () => (await PagePressLicenseStore.get('pagepressLicense')).pagepressLicense), undefined);
    assert.equal(await ui.locator('.page-row').count(), 6, 'Deactivation must preserve captured pages');
    await ui.locator('#plans-close').click();
    await ui.locator('#from').fill('1'); await ui.locator('#to').fill('1'); await ui.locator('#filename').fill('pagepress-free-page.pdf');
    await ui.locator('#capture').click(); await ui.locator('button[value="confirm"]').click(); await source.bringToFront();
    await ui.waitForFunction(() => document.getElementById('state').textContent === 'Saved' && document.querySelectorAll('.page-row').length === 1, null, { timeout: 30000 });
    await ui.bringToFront(); assert.equal(await ui.locator('.page-row').count(), 1);
    await retainDownload('pagepress-free-page.pdf');

    await selectSource(origin + '/unsupported');
    await ui.waitForFunction(() => document.getElementById('notice').textContent.includes('No supported document viewer'));
    assert.equal(await ui.locator('#capture').isDisabled(), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(sourceErrors, []);
    fs.writeFileSync(path.join(artifacts, realOnly ? 'verification-real.json' : 'verification.json'), JSON.stringify({ captured, restored, rangePages: resumedNumbers, realPdfJsPages: realPages, checks: ['21-page auto capture and PDF download', '1200px minimum at 200%', 'DOM watermark/approval layers', 'bottom-edge preservation', 'landscape page', 'source warning', 'view restoration', 'persistence', 'cancellation and retry', 'incomplete-page timeout', 'real PDF.js single-page rendering', 'unsupported viewer', 'desktop and narrow layouts'] }, null, 2));
    console.log('PASS: Free gate, hosted checkout, invalid key, Pro activation and persistence, subscription portal, revocation and deactivation; PDF, ordered JPEG ZIP, individual JPEG, capture recovery and responsive layouts.');
  } catch (error) {
    if (sourceErrors.length) console.error('Source errors:', sourceErrors);
    if (context) {
      const panel = context.pages().find((p) => p.url().startsWith('chrome-extension://'));
      if (panel) {
        await panel.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
        console.error(await panel.evaluate(() => ({ state: document.getElementById('state')?.textContent, notice: document.getElementById('notice')?.textContent, progress: document.getElementById('progress-detail')?.textContent, activity: document.getElementById('activity-list')?.textContent })).catch(() => ({})));
      }
    }
    throw error;
  } finally { if (context) await context.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
