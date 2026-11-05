// Starts everything: database, scheduler loop, search workers, deal engine and the website.
import { config } from './config.ts';
import { getSettings, migrate, openDb } from './db.ts';
import { seed } from './routes.ts';
import { requeueStuck, scheduleSweeps } from './scheduler.ts';
import { runWorkers } from './worker.ts';
import { makeAfterSearch, engineTick, setDealEndedHook } from './engine/deals.ts';
import { rebuildRouteNorms } from './engine/norms.ts';
import { makeNotifier } from './engine/notify.ts';
import { onDealLive, onDealEnded } from './notify/fanout.ts';
import { deliverOutbox } from './notify/deliver.ts';
import { sendDailyDigests } from './notify/digest.ts';
import { pollTelegram } from './notify/telegram.ts';
import { startServer } from './web/server.ts';
import { makeSource } from './sources/index.ts';

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

const db = await openDb();
await migrate(db);
const added = await seed(db);
if (added) log(`added ${added} routes`);

const source = makeSource();
const channelPost = makeNotifier(db, log);
// A deal going live: post to the public Telegram channel, then alert matching users (alerts and route watches)
const notify = async (dealId: number) => {
  await channelPost(dealId);
  try { const r = await onDealLive(db, dealId); if (r.instant || r.daily) log(`deal ${dealId}: ${r.instant} alerts queued, ${r.daily} for digests`); }
  catch (e) { log(`alerts for deal ${dealId}: ${(e as Error).message}`); }
};
setDealEndedHook(async dealId => { await onDealEnded(db, dealId); });
const after = makeAfterSearch(db, () => getSettings(db), notify);
const server = await startServer(db, notify);
log(`website: ${config.publicUrl}  ·  admin: ${config.publicUrl}/admin (user "admin")`);
log(`fare source: ${source.name}${source.name === 'mock' ? ' (simulated; set SCRAPEDO_TOKEN in .env for real fares)' : ''}  ·  database: ${db.kind}  ·  ${config.concurrency} searches at once`);

const stop = new AbortController();
let lastNorms = 0;
async function tick() {
  try {
    const s = await getSettings(db);
    await requeueStuck(db);
    const sw = await scheduleSweeps(db, s, { market: config.market });
    const t = await engineTick(db, s, notify);
    if (sw.enqueued || t.verifies || t.expired) log(`queued ${sw.enqueued} scans, ${t.verifies} re-checks; expired ${t.expired}${sw.reason ? ` (${sw.reason})` : ''}`);
    const digests = await sendDailyDigests(db);
    if (digests) log(`queued ${digests} daily digests`);
    if (Date.now() - lastNorms > 6 * 3600e3) { lastNorms = Date.now(); await rebuildRouteNorms(db, s); }
  } catch (e) { log(`scheduler error: ${(e as Error).message}`); }
}
await tick();
const timer = setInterval(tick, 60_000);

// Outbox: deliver queued messages (alerts, digests, login codes) every 15 seconds
let delivering = false;
const deliverTimer = setInterval(async () => {
  if (delivering) return;
  delivering = true;
  try { const r = await deliverOutbox(db, { limit: 100, log }); if (r.sent || r.failed) log(`messages: ${r.sent} sent, ${r.logged} logged, ${r.retried} to retry, ${r.failed} failed`); }
  catch (e) { log(`outbox error: ${(e as Error).message}`); }
  finally { delivering = false; }
}, 15_000);
// Telegram bot: "/start <token>" from the account page's Connect link (only when TELEGRAM_BOT_TOKEN is set)
const telegramPoll = config.telegramToken && config.telegramBotUsername ? pollTelegram(db, stop.signal, { log }) : Promise.resolve();

const s = await getSettings(db);
const workers = runWorkers(db, source, s, after, { concurrency: config.concurrency, signal: stop.signal, log });

let lastDone = 0;
const report = setInterval(async () => {
  const [r] = await db.query(`SELECT count(*) FILTER (WHERE finished_at > now() - interval '5 minutes')::int AS done5,
    (SELECT count(*)::int FROM search_jobs WHERE status = 'queued') AS queued,
    (SELECT count(*)::int FROM deals WHERE status = 'live') AS live,
    (SELECT count(*)::int FROM deals WHERE status = 'review') AS review FROM search_jobs`);
  if (r.done5 !== lastDone || r.queued) log(`searches last 5 min: ${r.done5} · queued: ${r.queued} · live deals: ${r.live} · waiting for review: ${r.review}`);
  lastDone = r.done5;
}, 5 * 60_000);

workers.then(r => { if (r.fatal) log(`workers stopped: ${r.fatal}. Fix the problem (token or credits) and restart.`); });

async function shutdown() {
  log('stopping...'); clearInterval(timer); clearInterval(report); clearInterval(deliverTimer); stop.abort();
  await workers; await telegramPoll; server.close(); await db.close(); process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
