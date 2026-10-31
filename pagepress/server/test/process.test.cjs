// Runs the license server as a real process (node server.js) with a database file: license API, activation,
// restart with the same database, static pages and security headers, malformed requests, an unreachable payment
// API, and a clean shutdown on SIGTERM. No payment is made: the license is placed in the database directly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { openDatabase } = require('../src/db');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagepress-server-'));
const database = path.join(dir, 'licenses.sqlite');
const KEY = 'PP-ABCDE-FGHIJ-KLMNO-PQRST';

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
async function start(port) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`, DATABASE_PATH: database,
      // Placeholder credentials: Razorpay is never reached (and is unreachable from the test environment).
      RAZORPAY_KEY_ID: 'rzp_test_placeholder', RAZORPAY_KEY_SECRET: 'placeholder-secret', RAZORPAY_WEBHOOK_SECRET: 'placeholder-webhook', RAZORPAY_PLAN_ID_INR: 'plan_placeholder', PASS_WEEK_INR: '24900' }
  });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(log, /listening/, log);
  return { child, base: `http://127.0.0.1:${port}/`, log: () => log };
}
const stop = (child) => new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.kill('SIGTERM'); });
const form = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

test('license server process: API, restart persistence, pages, bad input, unreachable Razorpay, shutdown', async () => {
  // A paid yearly license, as the checkout would have stored it.
  const db = openDatabase(database); const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO licenses (key, purchase_id, plan, email, currency, status, expires_at, activation_limit, synced_at, created_at) VALUES (?, 'sub_process', 'year', 'owner@example.com', 'INR', 'active', ?, 2, ?, ?)").run(KEY, now + 300 * 86400, now, now);
  db.close();
  const port = await freePort();
  let server = await start(port);
  const activated = await (await fetch(server.base + 'v1/licenses/activate', form({ license_key: KEY, instance_name: 'PagePress browser' }))).json();
  assert.equal(activated.activated, true); const instance = activated.instance.id;

  // Static pages carry the security headers.
  const buy = await fetch(server.base + 'buy?currency=INR&plan=week');
  assert.equal(buy.status, 200);
  assert.match(buy.headers.get('content-security-policy'), /script-src 'self' https:\/\/checkout\.razorpay\.com/);
  assert.match(buy.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(buy.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(server.base + 'manage')).status, 200);
  assert.equal((await fetch(server.base + 'nope')).status, 404);

  // Payment API unreachable: a clear 502, and the server keeps serving.
  const checkout = await fetch(server.base + 'api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'buyer@example.com', currency: 'INR', plan: 'week' }) });
  assert.equal(checkout.status, 502); assert.match((await checkout.json()).error, /temporarily unavailable/);
  assert.ok(!server.log().includes('placeholder-secret'), 'The key secret never appears in logs');

  // Malformed request line and oversized body.
  const raw = await new Promise((resolve) => { const s = net.connect(port, '127.0.0.1', () => s.write('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n')); let d = ''; s.on('data', (c) => { d += c; }); s.on('close', () => resolve(d)); setTimeout(() => s.destroy(), 1500); });
  assert.match(raw, /^HTTP\/1\.1 400/);
  assert.equal((await fetch(server.base + 'v1/licenses/validate', { method: 'POST', body: 'x'.repeat(100000) })).status, 413);
  assert.equal((await fetch(server.base + 'healthz')).status, 200);

  // Restart with the same database: the license and this browser's activation survive.
  assert.deepEqual(await stop(server.child), { code: 0, signal: null }, 'SIGTERM shuts down cleanly');
  server = await start(port);
  const validated = await (await fetch(server.base + 'v1/licenses/validate', form({ license_key: KEY, instance_id: instance }))).json();
  assert.equal(validated.valid, true); assert.equal(validated.instance.id, instance); assert.equal(validated.license_key.activation_usage, 1);
  assert.equal(validated.meta.plan, 'year');
  await stop(server.child);
  fs.rmSync(dir, { recursive: true, force: true });
});
