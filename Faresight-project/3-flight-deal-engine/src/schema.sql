-- Flight Deal Engine schema (PostgreSQL 16+). Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
  code     text PRIMARY KEY,          -- IN
  currency text NOT NULL,             -- INR
  gl       text NOT NULL,             -- Google market code: in
  language text NOT NULL DEFAULT 'en',
  active   boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS airports (
  iata    text PRIMARY KEY,
  city    text NOT NULL,
  country text NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
  id           serial PRIMARY KEY,
  market       text NOT NULL REFERENCES markets(code),
  origin       text NOT NULL REFERENCES airports(iata),
  destination  text NOT NULL REFERENCES airports(iata),
  haul         text NOT NULL CHECK (haul IN ('short','medium','long')),
  max_stops    int  NOT NULL DEFAULT 1,           -- 0 = nonstop only, 1 = up to one stop, 2 = up to two
  trip_lengths int[] NOT NULL,                    -- nights; first one is the sweep length
  priority     int  NOT NULL DEFAULT 1,           -- higher = scanned first when the budget is tight
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (market, origin, destination)
);

CREATE TABLE IF NOT EXISTS search_jobs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('sweep','deep','verify')),
  route_id    int  NOT NULL REFERENCES routes(id),
  deal_id     int,
  depart      date NOT NULL,
  return_date date NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts    int  NOT NULL DEFAULT 0,
  credits     int  NOT NULL DEFAULT 0,
  error       text,
  run_at      timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS search_jobs_queue ON search_jobs (status, run_at);
CREATE INDEX IF NOT EXISTS search_jobs_deal ON search_jobs (deal_id) WHERE deal_id IS NOT NULL;
-- At most one open job per route/date pair/kind, so the scheduler can't pile up duplicates
CREATE UNIQUE INDEX IF NOT EXISTS search_jobs_open
  ON search_jobs (kind, route_id, depart, return_date, coalesce(deal_id, 0))
  WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS price_observations (
  id          bigserial PRIMARY KEY,
  route_id    int  NOT NULL REFERENCES routes(id),
  depart      date NOT NULL,
  return_date date NOT NULL,
  nights      int  NOT NULL,
  price       double precision,                     -- cheapest option within the route's stop limit (null = none)
  cheapest_any double precision,                    -- cheapest option with any number of stops
  currency    text NOT NULL,
  stops       int,
  airlines    text,
  source      text NOT NULL,
  kind        text NOT NULL DEFAULT 'sweep',     -- job kind; only sweep prices feed the normal price
  job_id      bigint,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS obs_route_depart ON price_observations (route_id, depart, observed_at DESC);

CREATE TABLE IF NOT EXISTS route_norms (
  route_id     int  NOT NULL REFERENCES routes(id),
  month        date NOT NULL,                    -- first day of the departure month
  trip_band    text NOT NULL,                    -- short (<=5 nights), mid (6-9), long (10+)
  median_price double precision NOT NULL,
  sample_size  int  NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id, month, trip_band)
);

CREATE TABLE IF NOT EXISTS deals (
  id            serial PRIMARY KEY,
  route_id      int  NOT NULL REFERENCES routes(id),
  month         date NOT NULL,                   -- departure month the deal is filed under
  price         double precision NOT NULL,          -- price shown to users
  normal_price  double precision NOT NULL,
  saving_pct    double precision NOT NULL,
  currency      text NOT NULL,
  status        text NOT NULL CHECK (status IN ('candidate','review','live','expired','rejected')),
  reason        text,                            -- why it was rejected or expired
  first_seen    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  last_verified timestamptz,
  expired_at    timestamptz
);
-- One open deal per route per month
CREATE UNIQUE INDEX IF NOT EXISTS deals_open
  ON deals (route_id, month) WHERE status IN ('candidate','review','live');

CREATE TABLE IF NOT EXISTS deal_dates (
  id           serial PRIMARY KEY,
  deal_id      int  NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  depart       date NOT NULL,
  return_date  date NOT NULL,
  price        double precision NOT NULL,
  normal_price double precision NOT NULL,
  airlines     text,
  stops        int,
  last_checked timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, depart, return_date)
);

CREATE TABLE IF NOT EXISTS clicks (
  id           bigserial PRIMARY KEY,
  deal_id      int NOT NULL REFERENCES deals(id),
  deal_date_id int REFERENCES deal_dates(id),
  channel      text,                             -- web, telegram, whatsapp
  partner      text,
  clicked_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================================
-- Users and user data (accounts, sessions, alerts, channels, watches, saved deals, notifications)
-- ============================================================================================

CREATE TABLE IF NOT EXISTS users (
  id                serial PRIMARY KEY,
  email             text NOT NULL,
  name              text,
  phone             text,                          -- E.164, e.g. +919812345678
  password_hash     text,                          -- scrypt$N$salt$hash; null = code-only login
  email_verified_at timestamptz,
  home_airport      text REFERENCES airports(iata),
  market            text NOT NULL DEFAULT 'IN',
  currency          text NOT NULL DEFAULT 'INR',
  locale            text NOT NULL DEFAULT 'en',
  role              text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  marketing_consent boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz,
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (lower(email)) WHERE status <> 'deleted';

CREATE TABLE IF NOT EXISTS sessions (
  id           text PRIMARY KEY,                   -- sha256 hex of the session token (the token itself is never stored)
  user_id      int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'web' CHECK (kind IN ('web','app')),
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS login_codes (
  id         serial PRIMARY KEY,
  email      text NOT NULL,
  code_hash  text NOT NULL,                        -- sha256 hex of the 6-digit code
  purpose    text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login','verify','reset')),
  attempts   int  NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codes_email ON login_codes (lower(email), created_at DESC);

-- City alerts: "tell me about deals from DEL at least 35% below normal"
CREATE TABLE IF NOT EXISTS alert_subscriptions (
  id             serial PRIMARY KEY,
  user_id        int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin         text NOT NULL REFERENCES airports(iata),
  min_saving_pct int  NOT NULL DEFAULT 25 CHECK (min_saving_pct BETWEEN 25 AND 90),
  max_price      double precision,                 -- optional budget cap
  regions        text[],                           -- optional: seAsia, saGulf, eastAsia, europe, longHaul (null = all)
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, origin)
);

-- Where to send messages. kind=push: address = push endpoint, meta = {keys:{p256dh,auth}}
CREATE TABLE IF NOT EXISTS notification_channels (
  id          serial PRIMARY KEY,
  user_id     int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('email','telegram','whatsapp','push')),
  address     text NOT NULL,
  meta        jsonb,
  frequency   text NOT NULL DEFAULT 'instant' CHECK (frequency IN ('instant','daily')),
  verified_at timestamptz,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, address)
);

-- Route watch: notify when this route gets a live deal (optionally under a price)
CREATE TABLE IF NOT EXISTS route_watches (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id   int NOT NULL REFERENCES routes(id),
  max_price  double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, route_id)
);

CREATE TABLE IF NOT EXISTS saved_deals (
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id    int NOT NULL REFERENCES deals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, deal_id)
);

-- One row per message to a user about a deal; the unique key stops duplicate sends
CREATE TABLE IF NOT EXISTS notifications (
  id         bigserial PRIMARY KEY,
  user_id    int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id    int  REFERENCES deals(id),
  channel_id int  REFERENCES notification_channels(id) ON DELETE SET NULL,
  kind       text NOT NULL CHECK (kind IN ('deal_live','deal_ended','route_watch','digest','system')),
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  attempts   int  NOT NULL DEFAULT 0,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_once ON notifications (user_id, coalesce(deal_id, 0), kind, coalesce(channel_id, 0)) WHERE kind <> 'system' AND kind <> 'digest';
CREATE INDEX IF NOT EXISTS notifications_queue ON notifications (status, created_at);

-- Every outgoing message (login codes, alerts) is written here first, then delivered. Works without any provider set up.
CREATE TABLE IF NOT EXISTS outbox (
  id         bigserial PRIMARY KEY,
  channel    text NOT NULL CHECK (channel IN ('email','telegram','whatsapp','push')),
  to_address text NOT NULL,
  subject    text,
  body       text NOT NULL,
  meta       jsonb,
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','logged')),
  attempts   int  NOT NULL DEFAULT 0,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_queue ON outbox (status, created_at);

-- Audit trail of account actions (login, export, delete, consent changes)
CREATE TABLE IF NOT EXISTS user_events (
  id         bigserial PRIMARY KEY,
  user_id    int REFERENCES users(id) ON DELETE SET NULL,
  kind       text NOT NULL,
  data       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_events_user ON user_events (user_id, created_at DESC);

ALTER TABLE clicks ADD COLUMN IF NOT EXISTS user_id int REFERENCES users(id) ON DELETE SET NULL;

-- ============================================================================================
-- Hotels: cities, hotels, price sweep, normal price per hotel, hotel deals, and user data for hotels
-- ============================================================================================

CREATE TABLE IF NOT EXISTS hotel_cities (
  code       text PRIMARY KEY,                     -- airport/city code, e.g. BKK, GOI-style codes for India use the airport IATA
  name       text NOT NULL,                        -- Bangkok
  country    text NOT NULL,                        -- TH
  region     text,                                 -- seAsia, saGulf, eastAsia, europe, longHaul, india
  query      text NOT NULL,                        -- search text sent to the source, e.g. "Bangkok, Thailand"
  stay_nights int[] NOT NULL DEFAULT '{3,2,5}',    -- first one is the sweep length
  priority   int NOT NULL DEFAULT 1,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS hotels (
  id         serial PRIMARY KEY,
  city       text NOT NULL REFERENCES hotel_cities(code),
  source     text NOT NULL,                        -- mock, scrapedo, ...
  source_id  text NOT NULL,                        -- the source's stable hotel id
  name       text NOT NULL,
  stars      int,                                  -- 1-5 hotel class
  rating     double precision,                     -- guest rating out of 10 (normalised)
  reviews    int,
  area       text,                                 -- neighbourhood
  lat        double precision,
  lng        double precision,
  image_url  text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS hotels_city ON hotels (city);

CREATE TABLE IF NOT EXISTS hotel_search_jobs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('sweep','deep','verify')),
  city          text NOT NULL REFERENCES hotel_cities(code),
  hotel_deal_id int,
  checkin       date NOT NULL,
  nights        int  NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts      int  NOT NULL DEFAULT 0,
  credits       int  NOT NULL DEFAULT 0,
  error         text,
  run_at        timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hotel_jobs_queue ON hotel_search_jobs (status, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS hotel_jobs_open
  ON hotel_search_jobs (kind, city, checkin, nights, coalesce(hotel_deal_id, 0))
  WHERE status IN ('queued','running');

-- One row per hotel per search: the cheapest bookable room rate for that stay
CREATE TABLE IF NOT EXISTS hotel_prices (
  id          bigserial PRIMARY KEY,
  hotel_id    int  NOT NULL REFERENCES hotels(id),
  checkin     date NOT NULL,
  nights      int  NOT NULL,
  per_night   double precision NOT NULL,           -- total / nights, taxes included where the source gives them
  total       double precision NOT NULL,
  currency    text NOT NULL,
  provider    text,                                -- the booking site with the lowest rate, if known
  source      text NOT NULL,
  kind        text NOT NULL DEFAULT 'sweep',
  job_id      bigint,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hotel_prices_hotel ON hotel_prices (hotel_id, checkin, observed_at DESC);

CREATE TABLE IF NOT EXISTS hotel_norms (
  hotel_id     int  NOT NULL REFERENCES hotels(id),
  month        date NOT NULL,
  median_per_night double precision NOT NULL,
  sample_size  int  NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, month)
);

CREATE TABLE IF NOT EXISTS hotel_deals (
  id            serial PRIMARY KEY,
  hotel_id      int  NOT NULL REFERENCES hotels(id),
  month         date NOT NULL,
  per_night     double precision NOT NULL,         -- price per night shown to users
  normal_per_night double precision NOT NULL,
  saving_pct    double precision NOT NULL,
  currency      text NOT NULL,
  status        text NOT NULL CHECK (status IN ('candidate','review','live','expired','rejected')),
  reason        text,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  last_verified timestamptz,
  expired_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS hotel_deals_open ON hotel_deals (hotel_id, month) WHERE status IN ('candidate','review','live');

CREATE TABLE IF NOT EXISTS hotel_deal_dates (
  id            serial PRIMARY KEY,
  hotel_deal_id int  NOT NULL REFERENCES hotel_deals(id) ON DELETE CASCADE,
  checkin       date NOT NULL,
  nights        int  NOT NULL,
  per_night     double precision NOT NULL,
  total         double precision NOT NULL,
  normal_per_night double precision NOT NULL,
  provider      text,
  last_checked  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_deal_id, checkin, nights)
);

CREATE TABLE IF NOT EXISTS hotel_clicks (
  id                 bigserial PRIMARY KEY,
  hotel_deal_id      int NOT NULL REFERENCES hotel_deals(id),
  hotel_deal_date_id int REFERENCES hotel_deal_dates(id),
  user_id            int REFERENCES users(id) ON DELETE SET NULL,
  channel            text,
  partner            text,
  clicked_at         timestamptz NOT NULL DEFAULT now()
);

-- User data for hotels
CREATE TABLE IF NOT EXISTS hotel_alert_subscriptions (
  id             serial PRIMARY KEY,
  user_id        int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city           text NOT NULL REFERENCES hotel_cities(code),
  min_saving_pct int  NOT NULL DEFAULT 25 CHECK (min_saving_pct BETWEEN 25 AND 90),
  max_per_night  double precision,
  min_stars      int CHECK (min_stars BETWEEN 1 AND 5),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, city)
);

CREATE TABLE IF NOT EXISTS saved_hotel_deals (
  user_id       int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hotel_deal_id int NOT NULL REFERENCES hotel_deals(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hotel_deal_id)
);

-- Notifications can now be about a hotel deal
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS hotel_deal_id int REFERENCES hotel_deals(id);
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('deal_live','deal_ended','route_watch','digest','system','hotel_live','hotel_ended'));
DROP INDEX IF EXISTS notifications_once;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_once_v2
  ON notifications (user_id, coalesce(deal_id, 0), coalesce(hotel_deal_id, 0), kind, coalesce(channel_id, 0))
  WHERE kind <> 'system' AND kind <> 'digest';

-- ============================================================================================
-- Confirmed channels only, WhatsApp templates, manual deal endings
-- ============================================================================================
-- Codes sent to a channel (email, WhatsApp) to confirm the person owns it. Alerts go only to channels with verified_at set.
CREATE TABLE IF NOT EXISTS channel_verifications (
  id         serial PRIMARY KEY,
  channel_id int  NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,                        -- sha256 hex of the 6-digit code (or of the link token)
  attempts   int  NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_verifications_channel ON channel_verifications (channel_id, created_at DESC);
-- Last message the person sent us on this channel. WhatsApp allows free text only within 24 h of it; otherwise templates.
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;
-- Who ended a deal: the engine (null) or an admin
ALTER TABLE deals ADD COLUMN IF NOT EXISTS ended_by text;
ALTER TABLE hotel_deals ADD COLUMN IF NOT EXISTS ended_by text;
