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
