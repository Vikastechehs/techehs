// Admin user pages: login, list with search, detail, and account actions. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The admin password is read when config.ts loads, so set it before importing anything from src/
process.env.ADMIN_PASSWORD ||= 'test-admin-pass';
const { config } = await import('../src/config.ts');
const { openDb, migrate } = await import('../src/db.ts');
const { seed } = await import('../src/routes.ts');
const { startServer } = await import('../src/web/server.ts');

test('admin users pages: login, list, search, detail, disable and enable, outbox', async () => {
  const db = await openDb({ memory: true });
  await migrate(db); await seed(db);
  const [u] = await db.query(`INSERT INTO users (email, name, home_airport, email_verified_at, last_login_at)
    VALUES ('priya@example.com', 'Priya <Test>', 'DEL', now(), now()) RETURNING id`);
  await db.query(`INSERT INTO users (email, name) VALUES ('other@example.com', 'Rahul')`);
  await db.query(`INSERT INTO alert_subscriptions (user_id, origin, min_saving_pct) VALUES ($1, 'DEL', 35)`, [u.id]);
  await db.query(`INSERT INTO notification_channels (user_id, kind, address, verified_at) VALUES ($1, 'email', 'priya@example.com', now())`, [u.id]);
  await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('abc', $1, now() + interval '1 day')`, [u.id]);
  await db.query(`INSERT INTO outbox (channel, to_address, subject, body, status) VALUES ('email', 'priya@example.com', 'Your sign-in code', '123456', 'logged')`);

  const server = await startServer(db, async () => {}, 0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const auth = { authorization: 'Basic ' + Buffer.from(`admin:${config.adminPassword}`).toString('base64') };
  try {
    assert.equal((await fetch(base + '/admin/users')).status, 401);
    assert.equal((await fetch(base + '/admin/users', { headers: { authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') } })).status, 401);

    const list = await fetch(base + '/admin/users', { headers: auth });
    assert.equal(list.status, 200);
    const html = await list.text();
    assert.match(html, /priya@example\.com/);
    assert.match(html, /other@example\.com/);
    assert.match(html, /Priya &lt;Test&gt;/, 'names are escaped');
    assert.match(html, /href="\/admin"/, 'links back to the main admin page');
    assert.match(html, new RegExp(`href="/admin/users/${u.id}"`));

    const search = await (await fetch(base + '/admin/users?q=rahul', { headers: auth })).text();
    assert.match(search, /other@example\.com/);
    assert.doesNotMatch(search, /priya@example\.com/);

    const detail = await fetch(`${base}/admin/users/${u.id}`, { headers: auth });
    assert.equal(detail.status, 200);
    const d = await detail.text();
    assert.match(d, /priya@example\.com/);
    assert.match(d, /City alerts \(1\)/);
    assert.match(d, /Channels \(1\)/);
    assert.match(d, /\/disable"/);
    assert.equal((await fetch(base + '/admin/users/999999', { headers: auth })).status, 404);

    const dis = await fetch(`${base}/admin/users/${u.id}/disable`, { method: 'POST', headers: auth, redirect: 'manual' });
    assert.equal(dis.status, 303);
    assert.equal(dis.headers.get('location'), `/admin/users/${u.id}`);
    const [after] = await db.query(`SELECT status, (SELECT count(*)::int FROM sessions WHERE user_id = $1) AS sessions FROM users WHERE id = $1`, [u.id]);
    assert.equal(after.status, 'disabled');
    assert.equal(after.sessions, 0, 'disabling signs the user out');
    const [ev] = await db.query(`SELECT kind FROM user_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [u.id]);
    assert.equal(ev.kind, 'admin_disable');
    assert.equal((await fetch(`${base}/admin/users/${u.id}/disable`, { method: 'POST', redirect: 'manual' })).status, 401, 'actions need admin login');

    await fetch(`${base}/admin/users/${u.id}/enable`, { method: 'POST', headers: auth, redirect: 'manual' });
    assert.equal((await db.query(`SELECT status FROM users WHERE id = $1`, [u.id]))[0].status, 'active');

    const outbox = await fetch(base + '/admin/users/outbox', { headers: auth });
    assert.equal(outbox.status, 200);
    assert.match(await outbox.text(), /Your sign-in code/);
  } finally { server.close(); await db.close(); }
});
