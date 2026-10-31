# Flight Deal Engine

Finds return flights from India that are bookable right now and at least 25% below the route's measured normal price, re-checks them every 6 hours, and publishes them on a website (and Telegram) with booking links.

Build spec: https://claude.ai/artifact/R4Jegzg2hQ6nAUtSjdCxWK

## Quick start (Windows)

You need Node.js 22.18 or newer (you have 24). Nothing else: if `DATABASE_URL` is empty, a built-in PostgreSQL stores data in `data\`.

1. **`setup.bat`** installs packages, creates `.env` (copies your Scrape.do key from `..\flight-scan` if it's there, and makes an admin password), and creates the database with the 300 routes.
2. **`demo.bat`** (optional) fills a separate demo database with simulated fares, so you can see the site and admin with deals in them. It uses no credits.
3. **`test-real.bat`** runs 50 real searches through Scrape.do (about 500 credits) and prints what came back.
4. **`start.bat`** runs everything: scanner, deal engine and website at http://localhost:3000. Admin is at `/admin` (user `admin`, password in `.env`).
5. **`status.bat`** shows routes, prices stored, deals, credits this month and the queue.

**Rotate your Scrape.do key first.** The current one was shared in chat; put the new key in `.env`.

## What happens when it runs

1. **Sweep.** Every route has a calendar: one departure every 7 days for 9 months, at its main trip length. Each date is re-priced weekly, and twice a week for the next 4 weeks. Searches are capped at 6,000 a day and kept within the monthly credit budget. The first full calendar takes about 2 days.
2. **Normal price.** This is the median of sweep prices for departures within 21 days either side, seen in the last 30 days. If there's too little data, it falls back to any trip length, then to the route's 9 months.
3. **Candidate.** A fare at 75% or less of normal that also saves at least ₹3,000 (₹8,000 long haul) opens a candidate. A route needs 20 prices before it can produce one.
4. **Deep check.** Every departure 7 days either side is priced at the route's 3 trip lengths, about 45 searches. With 3 or more passing date pairs the deal goes to **review** (or straight to live with `auto_approve = true`); otherwise it's rejected with the reason.
5. **Re-check.** Every 6 hours the 3 cheapest date pairs are re-priced. The shown price drops if a fare got cheaper; the deal expires if no pair is still within 5%.

All thresholds are in the `settings` table and can be edited on the admin page.

## Files

| Path | What it does |
|---|---|
| `src/main.ts` | Starts the scheduler loop, search workers, deal engine and website |
| `src/cli.ts` | `setup`, `status`, `sweep-once N`, `demo` |
| `src/config.ts` | `.env` settings and default deal rules |
| `src/db.ts`, `src/schema.sql` | PostgreSQL (or built-in PGlite) and the 10 tables |
| `src/routes.ts` | The 300 India routes and their trip lengths |
| `src/scheduler.ts` | Sweep calendar, daily cap, credit budget |
| `src/worker.ts` | Parallel searches from a database queue, retries, stores every price |
| `src/sources/` | Scrape.do Google Flights adapter, simulated fares, source picker |
| `src/engine/norms.ts` | Normal price |
| `src/engine/deals.ts` | Candidate, deep check, review, re-check, expiry |
| `src/engine/links.ts` | Skyscanner deep links, wrapped in your affiliate link |
| `src/engine/notify.ts` | Telegram post when a deal goes live |
| `src/web/` | Website, deal pages, admin, `/go/:id` click-logged redirect, `/api/deals` |
| `test/engine.test.ts` | 7 end-to-end tests on simulated fares (`npm test`) |

## Production

- Set `DATABASE_URL` to a managed PostgreSQL 16+ and `PUBLIC_URL` to your domain.
- Run `node src/main.ts` under a process manager (pm2, systemd or a container) on a small server.
- Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to post deals, and `AFFILIATE_URL_TEMPLATE` once an affiliate programme approves you.
- To add a fare source (e.g. a cached affiliate API for the sweep), implement `FareSource` in `src/sources/` and select it in `src/sources/index.ts`.

## Not built yet (from the spec)

- Week 3: Next.js site with route pages for search traffic, WhatsApp channel, cached-API sweep source
- Week 4: metrics dashboard, second market
