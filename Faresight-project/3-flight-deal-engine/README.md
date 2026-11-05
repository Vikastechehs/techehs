# Flight Deal Engine

Finds return flights from India that are bookable right now and at least 25% below the route's measured normal price, re-checks them every 6 hours, and publishes them on a website (and Telegram) with booking links.

Build spec: https://claude.ai/artifact/R4Jegzg2hQ6nAUtSjdCxWK

## Quick start (Windows)

You need Node.js 22.18 or newer (you have 24). Nothing else: if `DATABASE_URL` is empty, a built-in PostgreSQL stores data in `data\`.

1. **`setup.bat`** installs packages, creates `.env` (copies your Scrape.do key from `..\flight-scan` if it's there, and makes an admin password), and creates the database with the 300 routes.
2. **`demo.bat`** (optional) fills a separate demo database with simulated fares, so you can see the site and admin with deals in them. It uses no credits.
3. **`test-real.bat`** runs 50 real searches through Scrape.do (about 500 credits) and prints what came back.
4. **`start.bat`** runs everything: scanner, deal engine and website at http://localhost:3000. Admin is at `/admin` (user `admin`, password in `.env`).
5. **`status.bat`** shows routes, prices stored, deals, credits this month, the queue, users and the message outbox.

`setup.bat` also fills in `APP_SECRET` in `.env` when it's empty (it signs unsubscribe and Telegram-connect links).

**Rotate your Scrape.do key first.** The current one was shared in chat; put the new key in `.env`.

## What happens when it runs

1. **Sweep.** Every route has a calendar: one departure every 7 days for 9 months, at its main trip length. Each date is re-priced weekly, and twice a week for the next 4 weeks. Searches are capped at 6,000 a day and kept within the monthly credit budget. The first full calendar takes about 2 days.
2. **Normal price.** This is the median of sweep prices for departures within 21 days either side, seen in the last 30 days. If there's too little data, it falls back to any trip length, then to the route's 9 months.
3. **Candidate.** A fare at 75% or less of normal that also saves at least ₹3,000 (₹8,000 long haul) opens a candidate. A route needs 20 prices before it can produce one.
4. **Deep check.** Every departure 7 days either side is priced at the route's 3 trip lengths, about 45 searches. With 3 or more passing date pairs the deal goes to **review** (or straight to live with `auto_approve = true`); otherwise it's rejected with the reason.
5. **Re-check.** Every 6 hours the 3 cheapest date pairs are re-priced. The shown price drops if a fare got cheaper; the deal expires if no pair is still within 5%.

All thresholds are in the `settings` table and can be edited on the admin page.

## Users and alerts

People can create an account and get told about deals that matter to them.

- **Accounts and sign-in.** Sign in with a 6-digit code sent by email (no password needed; the account is created on first sign-in), or register with an email and password. Codes expire after 10 minutes, allow 5 tries, and at most 5 are sent per email per hour. Sessions last `SESSION_DAYS` (60) days: a cookie on the website, a bearer token in the Android app. "Sign out everywhere" ends every session.
- **City alerts.** "Deals from Delhi at least 35% below normal", optionally with a budget cap and regions (South-East Asia, Gulf, East Asia, Europe, long haul).
- **Channels.** Where alerts go: email (added on sign-in), Telegram (one-tap connect link to the bot), WhatsApp and web push. Each channel is instant or a daily digest, and every message has a one-tap stop link.
- **Route watches.** "Tell me when Mumbai → Bangkok has a deal", optionally under a price.
- **Saved deals.** Bookmark deals to come back to.
- **Privacy (India DPDP Act 2023).** Users can download everything stored about them as JSON, and delete their account: sessions, alerts, channels, watches and saved deals are deleted and the account row is anonymised.
- **Messages.** Every outgoing message (sign-in codes, alerts) is written to the `outbox` table first, then delivered. With no provider configured, messages are only stored (status `logged`), so everything can be tried locally; sign-in codes can be read on the admin outbox page.
- **Admin.** `/admin/users` lists users with search and counts (total, active, new in 7 days, with alerts, channels by kind). A user's page shows profile, alerts, channels, watches, saved deals, recent notifications and account events, with **Disable / Enable**, **Sign out everywhere** and **Delete account**. `/admin/users/outbox` shows the last 100 messages and notification counts for the last 24 hours. `node src/cli.ts make-admin <email>` gives an account the admin role.

### Settings (`.env`)

| Key | What it does |
|---|---|
| `APP_SECRET` | Long random value that signs unsubscribe and Telegram-connect links. `setup` generates it. Required in production. |
| `SESSION_DAYS` | How long a sign-in lasts (default 60) |
| `EMAIL_FROM` | Sender of emails, e.g. `Faresight <deals@yourdomain.in>` |
| `RESEND_API_KEY` | Sends email through resend.com. Empty = emails are only stored in the outbox |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API (Meta) for personal WhatsApp alerts |
| `TELEGRAM_BOT_USERNAME` | Bot user name (without @) for "Connect Telegram" links; uses `TELEGRAM_BOT_TOKEN` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web push keys. Generate with `node src/cli.ts vapid` |
| `VAPID_SUBJECT` | Contact for push services, e.g. `mailto:you@yourdomain.in` |

### API (`/api/v1`, JSON)

The website uses the `fs_session` cookie; the Android app sends `"client": "app"` when signing in and then `Authorization: Bearer <token>`. Cookie-authenticated writes from another site are refused.

| Method and path | What it does |
|---|---|
| `POST auth/code` | Email a sign-in code `{email}` |
| `POST auth/verify` | Sign in with `{email, code}`; creates the account on first sign-in |
| `POST auth/register` | Create an account with `{email, password, name?}` |
| `POST auth/login` | Sign in with `{email, password}` |
| `POST auth/logout` | End this session |
| `POST auth/logout-all` | End every session of this user |
| `GET me`, `PATCH me` | Profile; update `name`, `phone`, `home_airport`, `locale`, `marketing_consent` |
| `POST me/password` | Set or change the password |
| `GET me/export` | Everything stored about the user, as JSON |
| `DELETE me` | Delete the account |
| `GET`/`POST me/alerts`, `DELETE me/alerts/:origin` | City alerts (POST creates or updates the alert for an origin) |
| `GET`/`POST me/channels`, `PATCH`/`DELETE me/channels/:id` | Notification channels |
| `GET`/`POST me/watches`, `DELETE me/watches/:id` | Route watches |
| `GET me/saved`, `PUT`/`DELETE me/saved/:dealId` | Saved deals |
| `GET airports` | Airports, with which ones are departure cities |
| `GET routes?from=DEL` | Active routes, optionally from one city |

The older public `GET /api/deals` (live deals) is unchanged.

## Files

| Path | What it does |
|---|---|
| `src/main.ts` | Starts the scheduler loop, search workers, deal engine and website |
| `src/cli.ts` | `setup`, `status`, `sweep-once N`, `demo`, `users`, `make-admin <email>`, `vapid` |
| `src/config.ts` | `.env` settings and default deal rules |
| `src/db.ts`, `src/schema.sql` | PostgreSQL (or built-in PGlite): 10 engine tables plus users, sessions, sign-in codes, alerts, channels, watches, saved deals, notifications, outbox and account events |
| `src/routes.ts` | The 300 India routes and their trip lengths |
| `src/scheduler.ts` | Sweep calendar, daily cap, credit budget |
| `src/worker.ts` | Parallel searches from a database queue, retries, stores every price |
| `src/sources/` | Scrape.do Google Flights adapter, simulated fares, source picker |
| `src/engine/norms.ts` | Normal price |
| `src/engine/deals.ts` | Candidate, deep check, review, re-check, expiry |
| `src/engine/links.ts` | Skyscanner deep links, wrapped in your affiliate link |
| `src/engine/notify.ts` | Telegram channel post when a deal goes live |
| `src/users/service.ts` | Accounts, sign-in, sessions, alerts, channels, watches, saved deals, export and delete |
| `src/users/api.ts` | The `/api/v1` JSON API |
| `src/notify/` | Outbox, delivery (email, Telegram, WhatsApp, push), per-user fan-out, daily digest, unsubscribe links, Telegram bot |
| `src/web/` | Website, deal pages, account pages, admin, `/admin/users`, `/go/:id` click-logged redirect, `/api/deals` |
| `test/engine.test.ts` | 7 end-to-end tests on simulated fares (`npm test`) |
| `test/admin.test.ts` | Admin user pages: login, list, search, detail, disable/enable, outbox |
| `Dockerfile`, `docker-compose.yml` | Container image, and PostgreSQL 16 plus the app for a single server |

## Production

- Set `DATABASE_URL` to a managed PostgreSQL 16+ and `PUBLIC_URL` to your domain.
- Run `node src/main.ts` under a process manager (pm2, systemd or a container) on a small server.
- Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to post deals, and `AFFILIATE_URL_TEMPLATE` once an affiliate programme approves you.
- Set `APP_SECRET`, and an email provider (`RESEND_API_KEY`, `EMAIL_FROM`) so sign-in codes reach people.
- To add a fare source (e.g. a cached affiliate API for the sweep), implement `FareSource` in `src/sources/` and select it in `src/sources/index.ts`.

### Docker

1. `cp .env.example .env` and fill it in (`ADMIN_PASSWORD`, `APP_SECRET`, `PUBLIC_URL`, `SCRAPEDO_TOKEN`, providers). `DATABASE_URL` is set by the compose file.
2. Optionally set `POSTGRES_PASSWORD` (and `APP_PORT`, default 3000) in your shell or a `.env` next to the compose file.
3. `docker compose up -d --build` starts PostgreSQL 16 and the app. The schema and routes are created on first start.
4. `docker compose logs -f app` to watch it; `docker compose exec app node src/cli.ts status` for counts; `docker compose exec app node src/cli.ts make-admin you@example.com`.
5. Put a reverse proxy with HTTPS (Caddy, nginx, or your host's load balancer) in front of port 3000. `/health` answers `{"ok":true}` for health checks.

The image runs as a non-root user and needs Docker Compose 2.24 or newer (for the optional `.env`). To run the image alone, pass `DATABASE_URL` and the other settings with `-e` or `--env-file`.

## Not built yet (from the spec)

- Week 3: Next.js site with route pages for search traffic, cached-API sweep source
- Week 4: metrics dashboard, second market
- Android app (the `/api/v1` API and bearer-token sign-in are ready for it)

## Hotels

Hotel deals run inside the same app, database, accounts, alerts and admin as flights.

- **Cities:** 46 (39 flight destinations plus Goa, Jaipur, Kochi, Delhi, Mumbai, Bengaluru, Udaipur), about 12 hotels tracked per city.
- **Source:** the same Scrape.do key (`SCRAPEDO_TOKEN`), Google Hotels. Hotel searches share `monthly_credit_budget` with flights and are capped by `hotel_daily_search_cap`. `HOTEL_SOURCE=mock` uses simulated hotels.
- **Deal rule:** price a night at most 75% of that hotel's own normal price and at least ₹1,000 a night cheaper, hotel rated 7.5/10+ and 3★+, on 3 or more check-in dates. Re-checked every 6 hours. All `hotel_*` settings are editable on the admin page.
- **Pages:** `/hotels`, `/hotels/expired`, `/hotel-deal/:id`, `/hotels/:city` (price-a-night calendar), `/go/h/:id` (logged redirect to Booking.com, wrapped in `HOTEL_AFFILIATE_URL_TEMPLATE` when set), `/api/hotel-deals`, admin `/admin/hotels`. Flight deal pages show hotel deals in the destination, and hotel deal pages show flights there.
- **User data:** hotel alerts by city, saving, max price a night and minimum stars; saved hotel deals; both in `/alerts`, `/account`, `/saved`, data export and account deletion. API: `GET /api/v1/hotel-cities`, `GET/POST /api/v1/me/hotel-alerts`, `DELETE /api/v1/me/hotel-alerts/:city`, `GET /api/v1/me/saved-hotels`, `PUT/DELETE /api/v1/me/saved-hotels/:id`.
- **First real test:** run `test-hotels.bat` (`node src/cli.ts hotels-once 5`, about 50 credits). The Scrape.do Google Hotels request format could not be checked against live Scrape.do yet. If no hotels are parsed, the raw reply is saved to `data/hotels-sample.json`; correct the constants at the top of `src/hotels/sources/scrapedo.ts`.
