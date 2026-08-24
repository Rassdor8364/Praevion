-- =============================================================================
-- 0008_prediction_markets
--
-- Prediction-market venues (Kalshi, Polymarket, future sportsbooks), the
-- scored opportunities Vixera derives from them, trader intelligence (§14 of
-- the brief — schema now, ingestion later) and the paper portfolio.
--
-- Everything except the paper portfolio is reference/market data: facts about
-- the world, world-readable to authenticated users and writable only by
-- service_role (same pattern as 0007 — the ABSENCE of a write policy is the
-- access control). The paper portfolio is org-owned and follows the 0006/0007
-- org-scoped pattern, including the deliberate org_id denormalisation onto
-- child rows.
--
-- These tables persist the shapes in src/core/markets/types.ts exactly:
-- PredictionMarket, MarketOutcome, MarketOrderBook, VixeraOpportunity and
-- MarketDislocation all round-trip without loss.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums (created before first use)
-- -----------------------------------------------------------------------------

-- Mirrors MarketCategory in src/core/markets/types.ts.
create type market_category as enum (
  'politics', 'economics', 'crypto', 'sports', 'weather',
  'entertainment', 'science', 'companies', 'other'
);

-- Mirrors MarketStatus.
create type market_status as enum ('open', 'closed', 'settled', 'suspended', 'unknown');

-- Mirrors LiquidityGrade.
create type liquidity_grade as enum ('excellent', 'good', 'fair', 'poor', 'illiquid');

-- Mirrors ResolutionRiskLevel.
create type resolution_risk_level as enum ('low', 'medium', 'high');

-- -----------------------------------------------------------------------------
-- prediction_market_providers  (reference data — service_role writes only)
-- -----------------------------------------------------------------------------
create table prediction_market_providers (
  id           uuid primary key default gen_random_uuid(),
  provider_id  text not null unique,
  display_name text not null,
  reliability  reliability_class not null,
  is_demo      boolean not null default false,
  is_enabled   boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger prediction_market_providers_set_updated_at
  before update on prediction_market_providers
  for each row execute function set_updated_at();

comment on table prediction_market_providers is
  'Mirror of PredictionMarketProviderInfo (src/core/markets/types.ts): the venues Vixera ingests markets from. Kept separate from data_providers because a venue is a market being analysed, not a data vendor being trusted — a venue can be down-ranked as evidence without disabling its ingestion.';
comment on column prediction_market_providers.is_demo is
  'True for the demo venue module. Any market or opportunity whose provenance touches a demo venue is stamped data_mode = demo, exactly as in 0001 (§19.3).';

-- The two launch venues. Idempotent so a re-run of this migration on a scratch
-- database converges instead of failing.
insert into prediction_market_providers (provider_id, display_name, reliability)
values
  ('kalshi',     'Kalshi',     'PRIMARY_SOURCE'),
  ('polymarket', 'Polymarket', 'PRIMARY_SOURCE')
on conflict (provider_id) do nothing;

-- -----------------------------------------------------------------------------
-- prediction_markets  — the persisted PredictionMarket
-- -----------------------------------------------------------------------------
create table prediction_markets (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null references prediction_market_providers(provider_id) on delete restrict,
  external_id      text not null,
  -- Venue ticker where one exists (Kalshi ticker, Polymarket slug).
  ticker           text,
  title            text not null,
  description      text,
  category         market_category not null,
  status           market_status not null default 'unknown',
  -- Lifetime traded volume in venue units (USD notional where available).
  volume           numeric(30, 10) not null default 0 check (volume >= 0),
  volume_24h       numeric(30, 10) check (volume_24h is null or volume_24h >= 0),
  liquidity        numeric(30, 10) check (liquidity is null or liquidity >= 0),
  open_interest    numeric(30, 10) check (open_interest is null or open_interest >= 0),
  -- Bid/ask spread of the primary outcome, in probability points (0..1).
  spread           numeric(7, 6) check (spread is null or (spread >= 0 and spread <= 1)),
  close_time       timestamptz,
  resolution_time  timestamptz,
  resolution_rules text,
  url              text,
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  -- Idempotent ingestion: re-polling a venue is a plain
  -- `insert ... on conflict do update`.
  unique (provider, external_id)
);

create index prediction_markets_category_status_idx
  on prediction_markets (category, status);
create index prediction_markets_provider_idx on prediction_markets (provider);

-- The "ending soon" scanner and the resolution-risk clock only care about open
-- markets; a partial index keeps that scan off the settled history.
create index prediction_markets_closing_idx on prediction_markets (close_time)
  where status = 'open';

comment on table prediction_markets is
  'One row per market per venue, mirroring PredictionMarket. The canonical Vixera id `${provider}:${externalId}` is reconstructed from the unique key rather than stored — storing it would be a second copy of the same fact that could drift.';
comment on column prediction_markets.updated_at is
  'The venue-reported last-update instant (PredictionMarket.updatedAt) on insert, refreshed by the set_updated_at trigger on every ingestion upsert — either way it answers "how stale is this quote?".';
comment on column prediction_markets.spread is
  'Spread expressed as a probability (0.02 = 2pp), never as cents or ticks, so cross-venue comparison needs no per-venue conversion.';

create trigger prediction_markets_set_updated_at
  before update on prediction_markets
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- prediction_market_outcomes  — the persisted MarketOutcome
-- -----------------------------------------------------------------------------
create table prediction_market_outcomes (
  id                  uuid primary key default gen_random_uuid(),
  market_id           uuid not null references prediction_markets(id) on delete cascade,
  -- Stable outcome id within the market (Kalshi: 'yes'/'no'; Polymarket: token id).
  external_outcome_id text not null,
  name                text not null,
  -- What the market BELIEVES — never to be confused with what Vixera estimates.
  market_probability  numeric(7, 6) not null
                        check (market_probability >= 0 and market_probability <= 1),
  -- Best bid/ask expressed as probabilities (0..1), when the venue reports them.
  bid                 numeric(7, 6) check (bid is null or (bid >= 0 and bid <= 1)),
  ask                 numeric(7, 6) check (ask is null or (ask >= 0 and ask <= 1)),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (market_id, external_outcome_id)
);

create trigger prediction_market_outcomes_set_updated_at
  before update on prediction_market_outcomes
  for each row execute function set_updated_at();

comment on table prediction_market_outcomes is
  'Current quote per outcome, mirroring MarketOutcome. This row is the LATEST state only; the history lives in prediction_market_prices and is never reconstructed from here.';

-- -----------------------------------------------------------------------------
-- prediction_market_prices  — probability time-series
-- -----------------------------------------------------------------------------
create table prediction_market_prices (
  id          uuid primary key default gen_random_uuid(),
  market_id   uuid not null references prediction_markets(id) on delete cascade,
  outcome_id  uuid not null references prediction_market_outcomes(id) on delete cascade,
  probability numeric(7, 6) not null check (probability >= 0 and probability <= 1),
  bid         numeric(7, 6) check (bid is null or (bid >= 0 and bid <= 1)),
  ask         numeric(7, 6) check (ask is null or (ask >= 0 and ask <= 1)),
  volume      numeric(30, 10) check (volume is null or volume >= 0),
  ts          timestamptz not null,
  created_at  timestamptz not null default now(),
  -- Idempotent ingestion: a re-polled snapshot for the same instant collapses
  -- onto the same row instead of duplicating the chart point.
  unique (outcome_id, ts)
);

-- The probability-history chart: every outcome of a market over a window.
create index prediction_market_prices_market_ts_idx
  on prediction_market_prices (market_id, ts desc);

comment on table prediction_market_prices is
  'Append-only time-series of outcome probabilities. This — not interpolation over prediction_market_outcomes — is what drives the probability-history charts, and it is also the input to the probability_change opportunity sort.';

-- -----------------------------------------------------------------------------
-- prediction_market_orderbooks  — the persisted MarketOrderBook
-- -----------------------------------------------------------------------------
create table prediction_market_orderbooks (
  id          uuid primary key default gen_random_uuid(),
  market_id   uuid not null references prediction_markets(id) on delete cascade,
  outcome_id  uuid not null references prediction_market_outcomes(id) on delete cascade,
  -- MarketOrderBookLevel[]: [{ "price": 0.42, "size": 1200 }, ...] — price is a
  -- probability (0..1), size is venue units (contracts / shares).
  bids        jsonb not null check (jsonb_typeof(bids) = 'array'),
  asks        jsonb not null check (jsonb_typeof(asks) = 'array'),
  ts          timestamptz not null,
  created_at  timestamptz not null default now(),
  unique (outcome_id, ts)
);

create index prediction_market_orderbooks_market_ts_idx
  on prediction_market_orderbooks (market_id, ts desc);

comment on table prediction_market_orderbooks is
  'Resting-depth snapshots per outcome, mirroring MarketOrderBook. Read with the same caveat as crypto_orderbook_snapshots: resting orders are not commitments, so the liquidity scorer weights depth below executed volume.';

-- -----------------------------------------------------------------------------
-- market_links  — cross-venue linkage
-- -----------------------------------------------------------------------------
create table market_links (
  id         uuid primary key default gen_random_uuid(),
  -- Canonical key of the real-world event, shared by every linked market
  -- (e.g. 'election:us-president-2028').
  event_key  text not null,
  market_id  uuid not null references prediction_markets(id) on delete cascade,
  confidence numeric(7, 6) not null check (confidence >= 0 and confidence <= 1),
  method     text not null check (method in ('manual', 'embedding', 'ticker')),
  created_at timestamptz not null default now(),
  unique (event_key, market_id)
);

create index market_links_market_idx on market_links (market_id);

comment on table market_links is
  'One real-world event traded on multiple venues. Rows sharing an event_key are the same event; disagreement between their quotes is itself a signal (MarketDislocation), and the largest Vixera edge across venues says WHERE the mispricing lives.';
comment on column market_links.method is
  'How the link was established: manual (an operator asserted it), embedding (title similarity), ticker (venue tickers matched). Confidence is calibrated per method — a manual link at 1.0 outranks an embedding link at 0.83.';

-- -----------------------------------------------------------------------------
-- opportunities  — the persisted VixeraOpportunity (the product's output)
-- -----------------------------------------------------------------------------
create table opportunities (
  id                      uuid primary key default gen_random_uuid(),
  market_id               uuid not null references prediction_markets(id) on delete cascade,
  outcome_id              uuid not null references prediction_market_outcomes(id) on delete cascade,

  -- Three related but deliberately distinct numbers; the UI never merges them:
  --   edge_pp        — probability edge (belief divergence)
  --   expected_value — expected return per unit staked at the executable price
  --   confidence     — how much to trust Vixera's own estimate
  vixera_probability      numeric(7, 6) not null
                            check (vixera_probability >= 0 and vixera_probability <= 1),
  market_probability      numeric(7, 6) not null
                            check (market_probability >= 0 and market_probability <= 1),
  -- vixera − market, in probability points (−1..1).
  edge_pp                 numeric(8, 6) not null check (edge_pp >= -1 and edge_pp <= 1),
  -- Per unit staked at the ask, not the mid — you cannot trade the mid. NULL
  -- when there is no executable quote.
  expected_value          numeric(12, 6),

  confidence              numeric(7, 6) not null check (confidence >= 0 and confidence <= 1),
  data_quality            numeric(5, 2) not null check (data_quality >= 0 and data_quality <= 100),
  model_agreement         numeric(7, 6) not null check (model_agreement >= 0 and model_agreement <= 1),

  liquidity_score         numeric(5, 2) not null check (liquidity_score >= 0 and liquidity_score <= 100),
  liquidity_grade         liquidity_grade not null,
  -- The rest of LiquidityAssessment: { spreadPp, depthScore, volumeScore, notes }.
  liquidity_detail        jsonb not null default '{}'::jsonb
                            check (jsonb_typeof(liquidity_detail) = 'object'),

  resolution_risk         resolution_risk_level not null,
  -- ResolutionRisk.reasons: ["subjective resolution criteria", ...]
  resolution_risk_reasons jsonb not null default '[]'::jsonb
                            check (jsonb_typeof(resolution_risk_reasons) = 'array'),
  -- 0..1 — how heavily news flow is currently moving this market's inputs.
  news_risk               numeric(7, 6) not null check (news_risk >= 0 and news_risk <= 1),
  -- Hours until scheduled resolution; NULL when the venue does not say.
  hours_to_resolution     numeric(10, 2),

  -- 0..100 — the ranked headline number.
  opportunity_score       numeric(5, 2) not null
                            check (opportunity_score >= 0 and opportunity_score <= 100),
  action                  text not null check (action in ('opportunity', 'no_action')),
  no_action_reasons       jsonb not null default '[]'::jsonb
                            check (jsonb_typeof(no_action_reasons) = 'array'),
  score_breakdown         jsonb not null default '{}'::jsonb
                            check (jsonb_typeof(score_breakdown) = 'object'),

  prediction_id           uuid references predictions(id) on delete set null,
  data_mode               data_mode not null,
  generated_at            timestamptz not null,
  created_at              timestamptz not null default now(),

  -- Scanner idempotency: a re-run over the same snapshot converges instead of
  -- duplicating the ranked list.
  unique (market_id, outcome_id, generated_at)
);

-- The ranked opportunity feed reads only actionable rows, best first.
create index opportunities_ranked_idx
  on opportunities (opportunity_score desc)
  where action = 'opportunity';

create index opportunities_generated_idx on opportunities (generated_at desc);
create index opportunities_market_idx on opportunities (market_id, generated_at desc);

comment on table opportunities is
  'The scored output: a divergence between what a market believes and what Vixera estimates, mirroring VixeraOpportunity. action = no_action is a first-class result — Vixera must be allowed to say "nothing here", and pretending otherwise is how analytics products decay into tip sheets.';
comment on column opportunities.no_action_reasons is
  'Why the scanner declined to flag this market ("fairly priced", "too thin", "resolution too subjective"). Non-empty exactly when action = no_action; a silent no_action is unexplained and therefore a bug.';
comment on column opportunities.edge_pp is
  'vixera_probability − market_probability, in probability points. Stored rather than computed so the row remains byte-for-byte what the scanner published even if a later backfill corrects an input.';

-- -----------------------------------------------------------------------------
-- traders  — trader intelligence (§14: schema now, ingestion later)
-- -----------------------------------------------------------------------------
create table traders (
  id           uuid primary key default gen_random_uuid(),
  -- Where the identity was observed ('polymarket', 'kalshi', ...).
  source       text not null,
  -- Venue-stable identity: wallet address, account id or leaderboard handle.
  external_id  text not null,
  display_name text,
  first_seen   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (source, external_id)
);

create trigger traders_set_updated_at
  before update on traders
  for each row execute function set_updated_at();

comment on table traders is
  'One row per observed market participant per source. Identity only — everything judgemental about a trader lives in trader_metrics, where it carries a sample size and a reliability class.';

-- -----------------------------------------------------------------------------
-- trader_accounts
-- -----------------------------------------------------------------------------
create table trader_accounts (
  id                  uuid primary key default gen_random_uuid(),
  trader_id           uuid not null references traders(id) on delete cascade,
  venue               text not null,
  external_account_id text not null,
  label               text,
  is_primary          boolean not null default false,
  first_seen          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  unique (trader_id, venue, external_account_id)
);

create index trader_accounts_trader_idx on trader_accounts (trader_id);

comment on table trader_accounts is
  'Venue accounts / wallets attributed to one trader. The one-to-many split exists because the same participant demonstrably operates multiple wallets, and merging their history is what makes the metrics honest.';

-- -----------------------------------------------------------------------------
-- trader_trades
-- -----------------------------------------------------------------------------
create table trader_trades (
  id                  uuid primary key default gen_random_uuid(),
  trader_id           uuid not null references traders(id) on delete cascade,
  external_trade_id   text not null,
  -- Resolved market reference when we track the market; the raw venue ids are
  -- kept alongside so a trade observed before its market is ingested is not lost.
  market_id           uuid references prediction_markets(id) on delete set null,
  external_market_id  text,
  outcome_id          uuid references prediction_market_outcomes(id) on delete set null,
  external_outcome_id text,
  side                text not null default 'unknown'
                        check (side in ('buy', 'sell', 'unknown')),
  -- Price expressed as a probability (0..1), mirroring MarketTrade.
  price               numeric(7, 6) not null check (price >= 0 and price <= 1),
  size                numeric(30, 10) not null check (size >= 0),
  ts                  timestamptz not null,
  created_at          timestamptz not null default now(),
  -- Idempotent ingestion of venue trade feeds.
  unique (trader_id, external_trade_id)
);

create index trader_trades_trader_ts_idx on trader_trades (trader_id, ts desc);
create index trader_trades_market_ts_idx on trader_trades (market_id, ts desc);

comment on table trader_trades is
  'Executed fills attributed to a trader. Executed flow, not stated positions, is the input to trader metrics — resting orders and self-reported PnL are not evidence.';

-- -----------------------------------------------------------------------------
-- trader_positions
-- -----------------------------------------------------------------------------
create table trader_positions (
  id                     uuid primary key default gen_random_uuid(),
  trader_id              uuid not null references traders(id) on delete cascade,
  market_id              uuid references prediction_markets(id) on delete set null,
  external_market_id     text not null,
  outcome_id             uuid references prediction_market_outcomes(id) on delete set null,
  external_outcome_id    text not null,
  avg_entry_probability  numeric(7, 6)
                           check (avg_entry_probability is null
                                  or (avg_entry_probability >= 0 and avg_entry_probability <= 1)),
  size                   numeric(30, 10) not null,
  unrealized_pnl         numeric(30, 10),
  as_of                  timestamptz not null,
  created_at             timestamptz not null default now(),
  -- Snapshot idempotency: re-polling the same instant converges.
  unique (trader_id, external_market_id, external_outcome_id, as_of)
);

create index trader_positions_trader_idx on trader_positions (trader_id, as_of desc);
create index trader_positions_market_idx on trader_positions (market_id)
  where market_id is not null;

comment on table trader_positions is
  'Point-in-time position snapshots per trader per outcome. A time-series, not a current-state table: "what were the sharps holding before the announcement?" is a question the product must be able to answer after the fact.';

-- -----------------------------------------------------------------------------
-- trader_metrics
-- -----------------------------------------------------------------------------
create table trader_metrics (
  id            uuid primary key default gen_random_uuid(),
  trader_id     uuid not null references traders(id) on delete cascade,
  -- "window" is a reserved word in Postgres, so it is quoted here and
  -- everywhere it is referenced (same convention as crypto_candles."interval").
  "window"      text not null,
  trades_count  integer not null check (trades_count >= 0),
  win_rate      numeric(7, 6) check (win_rate is null or (win_rate >= 0 and win_rate <= 1)),
  profit_factor numeric(12, 6) check (profit_factor is null or profit_factor >= 0),
  expectancy    numeric(12, 6),
  sharpe        numeric(10, 4),
  sortino       numeric(10, 4),
  max_drawdown  numeric(7, 6) check (max_drawdown is null or (max_drawdown >= 0 and max_drawdown <= 1)),
  consistency   numeric(7, 6) check (consistency is null or (consistency >= 0 and consistency <= 1)),
  reliability   text not null
                  check (reliability in ('very_low', 'low', 'medium', 'high', 'very_high')),
  computed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  -- Recomputing a window overwrites rather than accumulates.
  unique (trader_id, "window")
);

comment on table trader_metrics is
  'Rolling performance per trader per window (''30d'', ''90d'', ''all''). READ reliability BEFORE ANY OTHER COLUMN: it shrinks toward very_low as the sample gets small, because the headline numbers are meaningless without it — a 4-trade account showing +240% must NOT outrank a 1,287-trade account showing +84%, and reliability is the column that encodes that ordering.';
comment on column trader_metrics.reliability is
  'Sample-size-shrunk trust class. Derived from trades_count and window coverage, never from the returns themselves; a spectacular win rate on a handful of trades stays very_low no matter how spectacular.';
comment on column trader_metrics.profit_factor is
  'Gross wins / gross losses. NULL rather than infinity when there are no losing trades yet — an undefeated record on a tiny sample is a NULL, not a signal.';

-- -----------------------------------------------------------------------------
-- trader_specializations
-- -----------------------------------------------------------------------------
create table trader_specializations (
  id          uuid primary key default gen_random_uuid(),
  trader_id   uuid not null references traders(id) on delete cascade,
  category    market_category not null,
  accuracy    numeric(7, 6) check (accuracy is null or (accuracy >= 0 and accuracy <= 1)),
  sample_size integer not null default 0 check (sample_size >= 0),
  computed_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (trader_id, category)
);

comment on table trader_specializations is
  'Per-category skill: a trader sharp on economics data releases is weak evidence about entertainment markets. accuracy is shrunk by sample_size exactly as trader_metrics.reliability is — the two columns travel together or not at all.';

-- -----------------------------------------------------------------------------
-- paper_portfolios  (org-owned)
-- -----------------------------------------------------------------------------
create table paper_portfolios (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  created_by       uuid,
  name             text not null check (length(btrim(name)) > 0),
  description      text,
  starting_balance numeric(14, 2) not null default 10000 check (starting_balance > 0),
  currency         text not null default 'USD',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, name)
);

create trigger paper_portfolios_set_updated_at
  before update on paper_portfolios
  for each row execute function set_updated_at();

comment on table paper_portfolios is
  'Simulated portfolios for tracking hypothetical exposure to opportunities. Paper only, by design: Vixera is an analytics product, and no table in this database ever represents a real order (§18-R5).';

-- -----------------------------------------------------------------------------
-- paper_positions
-- -----------------------------------------------------------------------------
create table paper_positions (
  id                uuid primary key default gen_random_uuid(),
  portfolio_id      uuid not null references paper_portfolios(id) on delete cascade,
  org_id            uuid not null references organizations(id) on delete cascade,
  market_id         uuid references prediction_markets(id) on delete set null,
  outcome_id        uuid references prediction_market_outcomes(id) on delete set null,
  -- Denormalised display copy, so a closed position stays legible after the
  -- underlying market is aged out.
  outcome_name      text not null,
  entry_probability numeric(7, 6) not null
                      check (entry_probability >= 0 and entry_probability <= 1),
  size              numeric(30, 10) not null check (size > 0),
  opened_at         timestamptz not null default now(),
  closed_at         timestamptz,
  exit_probability  numeric(7, 6)
                      check (exit_probability is null
                             or (exit_probability >= 0 and exit_probability <= 1)),
  result            text check (result is null
                                or result in ('won', 'lost', 'void', 'closed_early')),
  pnl               numeric(30, 10),
  created_at        timestamptz not null default now(),
  constraint paper_positions_close_order check (
    closed_at is null or closed_at >= opened_at
  ),
  -- An open position must not carry settlement fields; a closed one must say
  -- how it ended.
  constraint paper_positions_settlement_shape check (
    (closed_at is null and exit_probability is null and result is null and pnl is null)
    or (closed_at is not null and result is not null)
  )
);

create index paper_positions_portfolio_idx on paper_positions (portfolio_id, opened_at desc);
create index paper_positions_org_idx on paper_positions (org_id);
create index paper_positions_open_idx on paper_positions (portfolio_id)
  where closed_at is null;

comment on column paper_positions.org_id is
  'Denormalised from the parent portfolio so the RLS policy is a column comparison rather than a subquery — same deliberate pattern as watchlist_items (0006).';
comment on column paper_positions.pnl is
  'Realised paper profit/loss in portfolio currency, written once at close. NULL while open — an unrealised number belongs to the UI, computed live, never persisted as if it had happened.';

-- =============================================================================
-- RLS  (same mechanism as 0007: the absence of a policy is the access control)
-- =============================================================================

-- 0007 set default privileges, but state the grants explicitly anyway — this
-- migration must not depend on which role happened to run the previous one.
grant select, insert, update, delete on
  prediction_market_providers, prediction_markets, prediction_market_outcomes,
  prediction_market_prices, prediction_market_orderbooks, market_links,
  opportunities, traders, trader_accounts, trader_trades, trader_positions,
  trader_metrics, trader_specializations, paper_portfolios, paper_positions
to authenticated;

grant select on
  prediction_market_providers, prediction_markets, prediction_market_outcomes,
  prediction_market_prices, prediction_market_orderbooks, market_links,
  opportunities, traders, trader_accounts, trader_trades, trader_positions,
  trader_metrics, trader_specializations, paper_portfolios, paper_positions
to anon;

grant all on
  prediction_market_providers, prediction_markets, prediction_market_outcomes,
  prediction_market_prices, prediction_market_orderbooks, market_links,
  opportunities, traders, trader_accounts, trader_trades, trader_positions,
  trader_metrics, trader_specializations, paper_portfolios, paper_positions
to service_role;

-- Market / reference data + the platform-generated opportunity feed + trader
-- intelligence: RLS on, SELECT for authenticated, and nothing else. Writes are
-- impossible for every role except service_role (BYPASSRLS).
do $$
declare
  t text;
  read_only_tables text[] := array[
    'prediction_market_providers', 'prediction_markets',
    'prediction_market_outcomes', 'prediction_market_prices',
    'prediction_market_orderbooks', 'market_links', 'opportunities',
    'traders', 'trader_accounts', 'trader_trades', 'trader_positions',
    'trader_metrics', 'trader_specializations'
  ];
begin
  foreach t in array read_only_tables loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for select to authenticated using (true)',
      t || '_read_authenticated', t
    );
    -- NO insert / update / delete policy. The omission is the access control,
    -- exactly as in 0007.
  end loop;
end
$$;

comment on policy opportunities_read_authenticated on opportunities is
  'The opportunity feed is generated by the platform scanner (service_role) and read-only to every signed-in user. There is deliberately no write policy: a client that could write here could publish its own "opportunities".';

-- --- paper_portfolios / paper_positions --------------------------------------
-- Org-scoped, full CRUD within the org, exactly like watchlists in 0007.
alter table paper_portfolios enable row level security;

create policy paper_portfolios_select on paper_portfolios
  for select to authenticated using (org_id in (select current_org_ids()));
create policy paper_portfolios_insert on paper_portfolios
  for insert to authenticated with check (org_id in (select current_org_ids()));
create policy paper_portfolios_update on paper_portfolios
  for update to authenticated
  using (org_id in (select current_org_ids()))
  with check (org_id in (select current_org_ids()));
create policy paper_portfolios_delete on paper_portfolios
  for delete to authenticated using (org_id in (select current_org_ids()));

alter table paper_positions enable row level security;

create policy paper_positions_select on paper_positions
  for select to authenticated using (org_id in (select current_org_ids()));
create policy paper_positions_insert on paper_positions
  for insert to authenticated with check (org_id in (select current_org_ids()));
create policy paper_positions_update on paper_positions
  for update to authenticated
  using (org_id in (select current_org_ids()))
  with check (org_id in (select current_org_ids()));
create policy paper_positions_delete on paper_positions
  for delete to authenticated using (org_id in (select current_org_ids()));
