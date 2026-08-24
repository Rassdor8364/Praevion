-- =============================================================================
-- 0004_crypto
--
-- Market data for the crypto domain (IMPLEMENTATION_PLAN §5, §10).
--
-- MONEY IS NEVER float8. IEEE-754 binary floating point cannot represent 0.1
-- exactly, so a float8 column silently loses the low satoshi digits, makes
-- `sum(volume)` order-dependent, and makes equality comparisons unreliable —
-- which in turn makes an idempotent upsert non-idempotent. Every price and
-- quantity here is `numeric`, which is exact decimal arithmetic.
--
-- numeric(24,10) is chosen so that both ends of the range fit in one type:
--   0.0000000100  (10 decimal places — sub-satoshi for a BTC pair)
--   99999999999999.0000000000  (14 integer digits — six-figure BTC and beyond)
-- Volumes get numeric(30,10) because a low-unit-price token can trade
-- trillions of units per day.
--
-- All of this is reference/market data: world-readable to authenticated users,
-- writable only by service_role (see 0007).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

-- Mirrors CandleInterval in src/providers/types.ts.
create type candle_interval as enum ('1m', '5m', '15m', '1h', '4h', '1d');

create type asset_class as enum ('crypto', 'equity', 'fx', 'commodity', 'index');

-- -----------------------------------------------------------------------------
-- assets  — the cross-domain instrument registry
-- -----------------------------------------------------------------------------
create table assets (
  id           uuid primary key default gen_random_uuid(),
  asset_class  asset_class not null,
  symbol       text not null,
  name         text not null,
  is_tracked   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (asset_class, symbol)
);

create trigger assets_set_updated_at
  before update on assets
  for each row execute function set_updated_at();

comment on table assets is
  'Instrument registry shared by crypto today and equities/FX later. `symbol` is the Vixera canonical symbol (BTC, ETH), not a venue ticker — venue tickers live on crypto_assets.';

-- -----------------------------------------------------------------------------
-- crypto_assets
-- -----------------------------------------------------------------------------
create table crypto_assets (
  id                  uuid primary key default gen_random_uuid(),
  asset_id            uuid not null unique references assets(id) on delete cascade,
  coingecko_id        text,
  binance_symbol      text,
  contract_addresses  jsonb not null default '{}'::jsonb,
  circulating_supply  numeric(38, 10),
  max_supply          numeric(38, 10),
  market_cap_rank     integer,
  genesis_date        date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger crypto_assets_set_updated_at
  before update on crypto_assets
  for each row execute function set_updated_at();

create unique index crypto_assets_coingecko_uidx on crypto_assets (coingecko_id)
  where coingecko_id is not null;
create unique index crypto_assets_binance_uidx on crypto_assets (binance_symbol)
  where binance_symbol is not null;

comment on column crypto_assets.binance_symbol is
  'Venue ticker (BTCUSDT). Kept off `assets` because the same asset trades under different tickers on different venues and none of them is canonical.';

-- -----------------------------------------------------------------------------
-- crypto_prices  — the tick / spot table
-- -----------------------------------------------------------------------------
create table crypto_prices (
  id                 uuid primary key default gen_random_uuid(),
  asset_id           uuid not null references assets(id) on delete cascade,
  ts                 timestamptz not null,
  price              numeric(24, 10) not null check (price >= 0),
  volume_24h         numeric(30, 10),
  quote_volume_24h   numeric(30, 10),
  change_24h_pct     numeric(12, 6),
  high_24h           numeric(24, 10),
  low_24h            numeric(24, 10),
  market_cap         numeric(30, 2),
  source_provider_id text not null,
  created_at         timestamptz not null default now(),
  -- Two providers may legitimately report the same instant with slightly
  -- different prices; that disagreement is an input to the data-quality score,
  -- so the provider is part of the natural key rather than something we
  -- flatten away.
  unique (asset_id, ts, source_provider_id)
);

-- Ticks are append-only and arrive in time order, so physical order tracks
-- logical order almost perfectly. BRIN therefore prunes nearly as well as a
-- btree here at roughly 1/1000th of the size and a fraction of the insert cost.
-- (BRIN has no notion of direction, hence no DESC — the planner reads the range
-- map and then sorts the far smaller result.)
create index crypto_prices_brin_idx on crypto_prices using brin (asset_id, ts)
  with (pages_per_range = 32);

-- The "latest price for this asset" lookup is hot enough to deserve a real
-- btree despite the BRIN above.
create index crypto_prices_latest_idx on crypto_prices (asset_id, ts desc);

comment on table crypto_prices is
  'Spot/ticker observations. Append-only. Retention is handled by a scheduled delete of rows older than the tick-retention window; the aggregate history lives in crypto_candles.';

-- -----------------------------------------------------------------------------
-- crypto_candles  — RANGE PARTITIONED BY MONTH on open_time
-- -----------------------------------------------------------------------------
-- This table dominates row count in the whole database: 6 intervals x N assets
-- x every minute, forever. Two consequences drive the design.
--
-- 1. INDEX DEPTH. A single unpartitioned btree over hundreds of millions of
--    rows is several levels deep and its hot pages stop fitting in cache.
--    Monthly partitions keep each index shallow and keep the current month —
--    which is what the feature builder actually reads — resident in memory.
--
-- 2. RETENTION. Ageing out a month with `DELETE FROM crypto_candles WHERE
--    open_time < ...` writes a WAL record per row, leaves the dead tuples
--    behind until VACUUM catches up, bloats the indexes, and competes with
--    live ingestion for I/O the entire time. Dropping the partition instead
--    (`DROP TABLE crypto_candles_2025_01`, or DETACH first if the data is
--    being archived) is a catalogue update: constant time, no bloat, no
--    vacuum, no WAL storm. Retention policy is a cron job that creates next
--    month's partition and drops the one that fell out of the window.
--
-- There is no surrogate `id`: the natural key IS the identity of a candle, and
-- a uuid would add 16 bytes per row plus an index to nothing.
create table crypto_candles (
  asset_id           uuid not null references assets(id) on delete cascade,
  -- "interval" is a reserved word in Postgres (it is a type name), so it is
  -- quoted here and everywhere it is referenced.
  "interval"         candle_interval not null,
  open_time          timestamptz not null,
  close_time         timestamptz not null,
  open               numeric(24, 10) not null check (open >= 0),
  high               numeric(24, 10) not null check (high >= 0),
  low                numeric(24, 10) not null check (low >= 0),
  close              numeric(24, 10) not null check (close >= 0),
  volume             numeric(30, 10) not null check (volume >= 0),
  quote_volume       numeric(30, 10),
  trades             integer,
  taker_buy_volume   numeric(30, 10),
  is_closed          boolean not null default true,
  source_provider_id text not null,
  created_at         timestamptz not null default now(),
  -- The partition key must be part of every unique constraint, and it is.
  primary key (asset_id, "interval", open_time),
  constraint crypto_candles_time_order check (close_time > open_time),
  -- A candle whose high is below its low (or outside its own open/close) is a
  -- corrupt payload, and a corrupt payload must fail loudly at the boundary
  -- rather than quietly poison every indicator downstream.
  constraint crypto_candles_ohlc_sane check (
    high >= low
    and high >= open and high >= close
    and low <= open and low <= close
  )
) partition by range (open_time);

comment on table crypto_candles is
  'OHLCV, declaratively partitioned by month on open_time. Retention is DROP PARTITION, never DELETE — see the block comment above this table.';
comment on column crypto_candles.is_closed is
  'False for the in-progress candle streamed from the websocket. Feature builders must exclude unclosed candles: using one is lookahead bias on a one-interval horizon.';
comment on column crypto_candles.taker_buy_volume is
  'Buyer-initiated (aggressor) volume. The order-flow model weights EXECUTED flow like this well above resting book depth, because resting orders are not commitments and spoofing is common (§10).';

-- Example partitions. A cron job (or pg_partman) creates the next month ahead
-- of time; these three exist so the schema is usable the moment it is applied.
create table crypto_candles_2026_07 partition of crypto_candles
  for values from ('2026-07-01 00:00:00+00') to ('2026-08-01 00:00:00+00');
create table crypto_candles_2026_08 partition of crypto_candles
  for values from ('2026-08-01 00:00:00+00') to ('2026-09-01 00:00:00+00');
create table crypto_candles_2026_09 partition of crypto_candles
  for values from ('2026-09-01 00:00:00+00') to ('2026-10-01 00:00:00+00');

-- Safety net so a late backfill or a missed cron does not turn into a hard
-- insert failure. CAVEAT: while a default partition exists, ATTACHing a new
-- partition takes an ACCESS EXCLUSIVE lock on it and scans it to prove no
-- conflicting rows are present. The partition-maintenance job therefore drains
-- the default (move rows into the real partition) before creating next month's.
create table crypto_candles_default partition of crypto_candles default;

comment on table crypto_candles_default is
  'Catch-all for out-of-range open_time. Should normally be empty; a non-zero count here is an alert, not a normal state.';

-- Cross-asset scans ("everything that closed in the last hour") — per-partition
-- indexes are created automatically on every existing and future partition.
create index crypto_candles_open_time_idx on crypto_candles (open_time desc);

-- -----------------------------------------------------------------------------
-- crypto_indicators
-- -----------------------------------------------------------------------------
create table crypto_indicators (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references assets(id) on delete cascade,
  "interval"    candle_interval not null,
  ts            timestamptz not null,
  indicator_key text not null,
  value         numeric(24, 10),
  -- Normalised feature form (z-score or percentile) actually consumed by the
  -- models. Indicators are FEATURES, NOT RULES — nothing anywhere says
  -- `if rsi < 30 then buy`.
  normalized    numeric(12, 8),
  params        jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  computed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  -- Recomputing indicators after a candle correction overwrites in place.
  unique (asset_id, "interval", ts, indicator_key, params)
);

create index crypto_indicators_lookup_idx
  on crypto_indicators (asset_id, "interval", indicator_key, ts desc);

comment on column crypto_indicators.params is
  'Period and variant, e.g. {"period":14}. Part of the unique key because RSI(14) and RSI(21) are different features, not two versions of one.';

-- -----------------------------------------------------------------------------
-- crypto_orderbook_snapshots
-- -----------------------------------------------------------------------------
create table crypto_orderbook_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  asset_id           uuid not null references assets(id) on delete cascade,
  ts                 timestamptz not null,
  venue              text not null,
  bids               jsonb not null check (jsonb_typeof(bids) = 'array'),
  asks               jsonb not null check (jsonb_typeof(asks) = 'array'),
  mid_price          numeric(24, 10),
  spread_bps         numeric(12, 4),
  bid_depth_quote    numeric(30, 2),
  ask_depth_quote    numeric(30, 2),
  imbalance          numeric(9, 6) check (imbalance is null or (imbalance >= -1 and imbalance <= 1)),
  source_provider_id text not null,
  created_at         timestamptz not null default now(),
  unique (asset_id, venue, ts)
);

create index crypto_orderbook_snapshots_lookup_idx
  on crypto_orderbook_snapshots (asset_id, ts desc);

comment on table crypto_orderbook_snapshots is
  'Resting depth snapshots. Read with the caveat that resting orders are NOT commitments and spoofing is common: the order-flow model weights this table below executed flow, and the UI says so.';

-- -----------------------------------------------------------------------------
-- crypto_onchain_metrics
-- -----------------------------------------------------------------------------
create table crypto_onchain_metrics (
  id                 uuid primary key default gen_random_uuid(),
  asset_id           uuid not null references assets(id) on delete cascade,
  ts                 timestamptz not null,
  metric_key         text not null,
  value              numeric(38, 10) not null,
  unit               text,
  source_provider_id text not null,
  created_at         timestamptz not null default now(),
  unique (asset_id, metric_key, ts, source_provider_id)
);

create index crypto_onchain_metrics_lookup_idx
  on crypto_onchain_metrics (asset_id, metric_key, ts desc);

comment on column crypto_onchain_metrics.value is
  'numeric(38,10) because on-chain quantities are denominated in wei/satoshi — 18 decimal places of raw units converted to whole coins still needs far more range than float8 can hold exactly.';

-- -----------------------------------------------------------------------------
-- crypto_derivatives
-- -----------------------------------------------------------------------------
create table crypto_derivatives (
  id                     uuid primary key default gen_random_uuid(),
  asset_id               uuid not null references assets(id) on delete cascade,
  venue                  text not null,
  ts                     timestamptz not null,
  funding_rate           numeric(14, 10),
  next_funding_time      timestamptz,
  open_interest          numeric(30, 10),
  open_interest_value    numeric(30, 2),
  long_short_ratio       numeric(14, 6),
  liquidations_long_usd  numeric(30, 2),
  liquidations_short_usd numeric(30, 2),
  source_provider_id     text not null,
  created_at             timestamptz not null default now(),
  unique (asset_id, venue, ts)
);

create index crypto_derivatives_lookup_idx on crypto_derivatives (asset_id, ts desc);

comment on column crypto_derivatives.funding_rate is
  'Per-interval rate as a fraction (0.0001 = 1bp), not a percentage. Ten decimal places because perpetual funding is routinely quoted at 1e-6 resolution.';
