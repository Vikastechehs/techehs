// Settings from .env (or the real environment). Deal rules live in the database `settings` table.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..');

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvFile(join(ROOT, '.env'));

const env = (k: string, d = '') => process.env[k] || d;

export const config = {
  scrapedoToken: env('SCRAPEDO_TOKEN'),
  databaseUrl: env('DATABASE_URL'),
  localDbDir: env('LOCAL_DB_DIR', join(ROOT, 'data', 'pglite')),
  market: env('MARKET', 'IN'),
  concurrency: Number(env('CONCURRENCY', '50')),
  siteName: env('SITE_NAME', 'Flight Deals'),
  port: Number(env('PORT', '3000')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000'),
  adminPassword: env('ADMIN_PASSWORD', 'change-me'),
  affiliateTemplate: env('AFFILIATE_URL_TEMPLATE'),
  telegramToken: env('TELEGRAM_BOT_TOKEN'),
  telegramChat: env('TELEGRAM_CHAT_ID'),
  // 'scrapedo' when a token is set, otherwise simulated fares so everything can be tried without credits
  // Users and messaging
  appSecret: env('APP_SECRET', 'dev-secret-change-me'),      // signs unsubscribe links; set a long random value in production
  sessionDays: Number(env('SESSION_DAYS', '60')),
  emailFrom: env('EMAIL_FROM', 'Faresight <deals@example.com>'),
  resendApiKey: env('RESEND_API_KEY'),                       // email via resend.com HTTP API; empty = messages only logged in the outbox
  whatsappToken: env('WHATSAPP_TOKEN'),                      // WhatsApp Cloud API
  whatsappPhoneId: env('WHATSAPP_PHONE_NUMBER_ID'),
  telegramBotUsername: env('TELEGRAM_BOT_USERNAME'),         // for per-user "connect Telegram" links
  vapidPublicKey: env('VAPID_PUBLIC_KEY'),                   // web push
  vapidPrivateKey: env('VAPID_PRIVATE_KEY'),
  vapidSubject: env('VAPID_SUBJECT', 'mailto:admin@example.com'),
  source: env('FARE_SOURCE', env('SCRAPEDO_TOKEN') ? 'scrapedo' : 'mock'),
};

// Deal rules and scan rates. Stored in the `settings` table on first setup; edit them there without a deploy.
export const DEFAULT_SETTINGS: Record<string, string> = {
  deal_max_ratio: '0.75',            // price must be at most 75% of the normal price
  min_saving_short: '3000',          // minimum saving in the market currency, short and medium haul
  min_saving_long: '8000',           // minimum saving, long haul
  min_passing_pairs: '3',            // date pairs that must pass the deep check
  deep_days_each_side: '7',          // deep check: departures within 7 days either side
  norm_window_days: '21',            // normal price: departures within 21 days either side
  norm_lookback_days: '30',          // ...seen in the last 30 days
  norm_min_samples: '6',             // fewer than this -> widen to any trip length, then the route's 9-month median
  route_min_history: '20',           // a route needs this many prices before it can produce deals
  sweep_horizon_days: '270',         // scan departures up to 9 months ahead
  sweep_step_days: '7',              // one departure date every 7 days
  sweep_refresh_days: '7',           // re-price each sweep date weekly...
  sweep_refresh_days_near: '3.5',    // ...twice as often for the next 4 weeks
  near_term_days: '28',
  verify_every_hours: '6',
  verify_pairs: '3',
  verify_tolerance: '1.05',          // a deal stays live while a pair is within 5% of the shown price
  monthly_credit_budget: '800000',   // Scrape.do credits; when spent, only re-checks run
  credits_per_search: '10',
  daily_search_cap: '6000',          // most sweep searches per day (the first full calendar takes ~2 days)
  auto_approve: 'false',             // true = publish without admin review
  max_attempts: '4',
};
