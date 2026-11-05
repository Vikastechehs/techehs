// Command-line helpers: setup, status, a small real-fare test, and a demo with simulated fares.
//   node src/cli.ts setup              create .env (if missing), database and routes
//   node src/cli.ts status             what's in the database and queue
//   node src/cli.ts sweep-once 50      run 50 real searches end to end (about 500 Scrape.do credits)
//   node src/cli.ts demo               fill the database with simulated fares and deals, to try the website
//   node src/cli.ts users              user counts and the 20 newest accounts
//   node src/cli.ts make-admin <email> give an account the admin role
//   node src/cli.ts vapid              print a new key pair for web push (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { config, ROOT } from './config.ts';
import { getSettings, migrate, openDb } from './db.ts';
import { seed } from './routes.ts';
import { creditsThisMonth, queueStats, scheduleSweeps } from './scheduler.ts';
import { runWorkers } from './worker.ts';
import { makeAfterSearch, engineTick } from './engine/deals.ts';
import { makeSource } from './sources/index.ts';
import { mockSource } from './sources/mock.ts';

const [cmd = 'status', arg] = process.argv.slice(2);
const log = (m: string) => console.log(m);

if (cmd === 'vapid') {
  // Needs no database. Paste both lines into .env; changing them later invalidates existing push subscriptions.
  const webpush = (await import('web-push')).default;
  const k = webpush.generateVAPIDKeys();
  log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
  log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
  process.exit(0);
}

if (cmd === 'setup') {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    let env = readFileSync(join(ROOT, '.env.example'), 'utf8');
    // Reuse the Scrape.do key from the earlier scan folder on this PC, if it's there
    const keyFile = join(ROOT, '..', 'flight-scan', 'scrapedo-key.txt');
    if (existsSync(keyFile)) env = env.replace(/^SCRAPEDO_TOKEN=.*$/m, `SCRAPEDO_TOKEN=${readFileSync(keyFile, 'utf8').trim()}`);
    const pass = randomBytes(9).toString('base64url');
    env = env.replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${pass}`);
    writeFileSync(envPath, env);
    log(`Created .env${existsSync(keyFile) ? ' (Scrape.do key copied from ..\\flight-scan)' : ''}.`);
    log(`Admin login: user "admin", password "${pass}" (also saved in .env).`);
  } else log('.env already exists; left it as it is.');
  // APP_SECRET signs unsubscribe links; fill it in when it's empty (also in an older .env without the line)
  let env = readFileSync(envPath, 'utf8');
  if (!/^APP_SECRET=\S/m.test(env)) {
    const secret = randomBytes(32).toString('base64url');
    env = /^APP_SECRET=.*$/m.test(env) ? env.replace(/^APP_SECRET=.*$/m, `APP_SECRET=${secret}`) : `${env.replace(/\s*$/, '\n')}APP_SECRET=${secret}\n`;
    writeFileSync(envPath, env);
    log('Generated APP_SECRET in .env.');
  }
  const db = await openDb(); await migrate(db);
  const added = await seed(db);
  log(`Database ready (${db.kind}). Routes added: ${added}.`);
  await db.close();
  process.exit(0);
}

const db = await openDb(); await migrate(db); await seed(db);
const getS = () => getSettings(db);

if (cmd === 'status') {
  const [c] = await db.query(`SELECT (SELECT count(*)::int FROM routes WHERE active) AS routes,
    (SELECT count(*)::int FROM price_observations) AS prices,
    (SELECT count(*)::int FROM deals WHERE status = 'live') AS live,
    (SELECT count(*)::int FROM deals WHERE status = 'review') AS review`);
  log(`Fare source: ${config.source} · database: ${db.kind}`);
  log(`Routes: ${c.routes} · prices stored: ${c.prices} · live deals: ${c.live} · waiting for review: ${c.review}`);
  log(`Credits this month: ${await creditsThisMonth(db)}`);
  const [u] = await db.query(`SELECT count(*) FILTER (WHERE status <> 'deleted')::int AS users, count(*) FILTER (WHERE status = 'active')::int AS active,
    count(*) FILTER (WHERE status <> 'deleted' AND created_at > now() - interval '7 days')::int AS week,
    (SELECT count(*)::int FROM alert_subscriptions WHERE active) AS alerts,
    (SELECT count(*) FILTER (WHERE status = 'queued')::int FROM outbox) AS queued,
    (SELECT count(*) FILTER (WHERE status = 'failed')::int FROM outbox) AS failed FROM users`);
  log(`Users: ${u.users} (${u.active} active, ${u.week} new this week) · city alerts: ${u.alerts} · outbox: ${u.queued} queued, ${u.failed} failed`);
  console.table(await queueStats(db));
} else if (cmd === 'users') {
  const [u] = await db.query(`SELECT count(*) FILTER (WHERE status <> 'deleted')::int AS users, count(*) FILTER (WHERE status = 'active')::int AS active,
    count(*) FILTER (WHERE status = 'disabled')::int AS disabled, count(*) FILTER (WHERE status = 'deleted')::int AS deleted,
    count(*) FILTER (WHERE status <> 'deleted' AND created_at > now() - interval '7 days')::int AS week FROM users`);
  log(`Users: ${u.users} · active: ${u.active} · disabled: ${u.disabled} · deleted: ${u.deleted} · new in 7 days: ${u.week}`);
  const rows = await db.query(`SELECT u.id, u.email, coalesce(u.name, '') AS name, coalesce(u.home_airport, '') AS home, u.role, u.status,
      (SELECT count(*)::int FROM alert_subscriptions a WHERE a.user_id = u.id AND a.active) AS alerts,
      to_char(u.created_at, 'YYYY-MM-DD HH24:MI') AS created, coalesce(to_char(u.last_login_at, 'YYYY-MM-DD HH24:MI'), '') AS last_login
    FROM users u WHERE u.status <> 'deleted' ORDER BY u.created_at DESC, u.id DESC LIMIT 20`);
  if (rows.length) console.table(rows); else log('No users yet.');
} else if (cmd === 'make-admin') {
  if (!arg) { log('Usage: node src/cli.ts make-admin <email>'); process.exitCode = 1; }
  else {
    const rows = await db.query(`UPDATE users SET role = 'admin', updated_at = now() WHERE lower(email) = lower($1) AND status <> 'deleted' RETURNING id, email`, [arg.trim()]);
    if (rows.length) log(`${rows[0].email} (user ${rows[0].id}) is now an admin.`);
    else { log(`No account with email ${arg}. They need to sign in once first.`); process.exitCode = 1; }
  }
} else if (cmd === 'sweep-once') {
  // A small, real end-to-end test: price N dates across different routes and show what came back
  const n = Number(arg ?? 50);
  const s = await getS();
  const source = makeSource();
  await scheduleSweeps(db, s, { limit: n });
  log(`Running ${n} searches with ${source.name}...`);
  const r = await runWorkers(db, source, s, makeAfterSearch(db, getS, async () => {}), { concurrency: Math.min(config.concurrency, n), maxJobs: n, log });
  log(`Done: ${r.done} ok, ${r.failed} failed${r.fatal ? `, stopped: ${r.fatal}` : ''}.`);
  // Searches that errored go back to the queue for a retry; show why, so a broken key or network is obvious
  const errs = await db.query(`SELECT error, count(*)::int AS n FROM search_jobs WHERE status = 'queued' AND error IS NOT NULL GROUP BY error ORDER BY n DESC LIMIT 5`);
  if (errs.length) { log('Searches that failed and will be retried later:'); console.table(errs); }
  console.table(await db.query(`SELECT r.origin || '-' || r.destination AS route, o.depart::text, o.return_date::text AS return, o.price, o.stops, o.airlines
    FROM price_observations o JOIN routes r ON r.id = o.route_id ORDER BY o.id DESC LIMIT 15`));
} else if (cmd === 'demo') {
  if (config.source !== 'mock' && arg !== 'force') { log('Demo uses simulated fares. Remove SCRAPEDO_TOKEN from .env first, or run "demo force".'); process.exit(1); }
  // Simulated fares cost no credits, so lift the daily cap and the credit budget for the demo, then put them back.
  // (With credits counted, the budget spread over the rest of the month allows only ~3,100 searches early in a month,
  // too few for routes to build the 20-price history they need before any deal can appear.)
  const keep = await db.query(`SELECT key, value FROM settings WHERE key IN ('daily_search_cap', 'credits_per_search')`);
  await db.query(`UPDATE settings SET value = '100000' WHERE key = 'daily_search_cap'`);
  await db.query(`UPDATE settings SET value = '0' WHERE key = 'credits_per_search'`);
  const s = await getS();
  await scheduleSweeps(db, s);
  log('Scanning simulated fares for all 300 routes (about a minute)...');
  const r = await runWorkers(db, mockSource(), s, makeAfterSearch(db, getS, async () => {}), { concurrency: 50, drain: true, log });
  await engineTick(db, s, async () => {});
  for (const k of keep) await db.query(`UPDATE settings SET value = $2 WHERE key = $1`, [k.key, k.value]);
  const [c] = await db.query(`SELECT count(*) FILTER (WHERE status = 'review')::int AS review, count(*) FILTER (WHERE status = 'live')::int AS live FROM deals`);
  log(`${r.done} searches. Deals waiting for review: ${c.review}, live: ${c.live}. Start the site and open /admin to publish them.`);
} else {
  log('Commands: setup | status | sweep-once [n] | demo | users | make-admin <email> | vapid');
}
await db.close();
