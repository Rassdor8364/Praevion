# VIXERA INTELLIGENCE — IMPLEMENTATION PLAN

**Version:** 1.0
**Date:** 2026-08-12
**Status:** Approved for Phase 1–3 execution

---

## 0. Scoping decisions made before writing this plan

Three facts shape everything below:

1. **Vixera Intelligence is a standalone application**, not a module bolted into the existing Vixera app. The existing Vixera codebase was not made available to this session, and you confirmed it is a different product. Therefore section 1 below is an assessment of a **greenfield** codebase, and sections 2–3 ("files reused / files modified") describe the *integration seams* that will let Vixera Intelligence be folded into the wider Vixera ecosystem later, rather than files that exist today.
2. **No data-provider API keys exist yet.** The system is therefore built provider-first: every engine consumes a narrow interface, and each interface has at least one **keyless real implementation** (Binance public REST, CoinGecko public, RSS/GDELT) plus a **clearly-labelled demo implementation**. Nothing anywhere in the system invents a number and presents it as live. See §7 and §19.
3. **Prediction math is pure and testable.** No engine touches the network, the database, React, or `Date.now()` implicitly. Every model is a pure function `(features, config) → ModelOutput`. This is what makes backtesting (§17), calibration (§14) and unit testing (§16) possible at all. It is the single most important architectural constraint in this document.

---

## 1. Current architecture assessment

| Area | Current state | Decision |
|---|---|---|
| Framework | None (greenfield) | Next.js 15 App Router, React 19, TypeScript strict |
| Language config | — | `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride`, ESLint rule banning `any` |
| Styling | — | Tailwind v4 + a Vixera token layer (`src/ui/theme`), no component library. Intelligence-terminal aesthetic, not a UI kit look |
| Database | — | Supabase Postgres. Plain `.sql` migrations, up **and** down, checked into `src/db/migrations` |
| Auth | — | Supabase Auth + RLS. Org-scoped from day one so Enterprise tier is not a rewrite |
| Hosting | — | Vercel. Route handlers for the API, Vercel Cron for ingestion, SSE for live updates |
| Quantitative runtime | — | TypeScript for everything in Phase 1–3. Python service deferred until a model needs it (see §12 and §18-R4) |
| AI | — | LLM used **only** for language tasks. Never for numeric probability. Enforced by type system (§12) |

**Why not Python now.** Every model in Phases 2–3 (Elo, Poisson/Dixon-Coles, EWMA volatility, logistic blending, isotonic calibration) is a few hundred lines of arithmetic. Running them in-process in TypeScript removes an entire network hop, a second deployment target, and a serialization boundary from the hot path. The moment a model needs gradient boosting or a trained neural net, a Python service is introduced behind the *same* `PredictionModel` interface — the orchestrator will not know the difference.

---

## 2. Integration seams with the wider Vixera ecosystem (the "reuse" surface)

These are the four places Vixera Intelligence touches the rest of Vixera. Each is isolated behind a single file so that swapping the standalone implementation for the ecosystem one is a one-file change.

| Seam | Standalone implementation (now) | Ecosystem implementation (later) |
|---|---|---|
| `src/lib/auth/session.ts` | Supabase Auth session | Vixera SSO / shared Supabase project |
| `src/lib/tiers/entitlements.ts` | Local `tier` column + feature flags | Vixera subscription service |
| `src/ui/theme/tokens.css` | Vixera/Nocturno tokens, copied | Imported from the Vixera design package |
| `src/lib/telemetry/logger.ts` | Structured console + Supabase `audit_logs` | Vixera observability sink |

**Rule:** no other file in the codebase may import a Vixera-ecosystem concept directly.

---

## 3. Files that will need modification when integrating

Only the four seam files in §2, plus `next.config.ts` (asset prefix / basePath if mounted as a sub-app) and the `middleware.ts` auth matcher. Nothing else. This is deliberate.

---

## 4. New folder structure

```
src/
  app/
    (auth)/login
    (app)/                    # authenticated shell: nav + command bar
      page.tsx                # Command Center
      sports/ crypto/ news/ predictions/ signals/
      watchlist/ analyst/ alerts/ history/ performance/ settings/
    api/                      # thin route handlers ONLY — no logic
  core/                       # domain-agnostic primitives
    prediction/               # VixeraPrediction, probability math, ensemble, confidence, risk
    metrics/                  # brier, log loss, calibration, accuracy buckets
    quality/                  # data quality score, freshness
    explain/                  # factor extraction + contribution normalisation
    result.ts errors.ts logger.ts clock.ts
  providers/                  # external world. Interfaces + adapters + registry
    crypto/ sports/ news/
  engines/                    # ALL prediction logic. Pure. No I/O.
    sports/ crypto/ news/ signals/
    orchestrator.ts           # VixeraIntelligence
  db/                         # schema, migrations, repositories
  ui/                         # design system + composite components
  lib/                        # seams, utils, feature flags
tests/                        # vitest — unit (math) + integration (pipelines)
```

**Hard dependency rule, enforced by an ESLint boundary rule:**

```
app → lib, ui, core
app/api → orchestrator → engines → core
orchestrator → providers, db
engines → core            (engines may NOT import providers, db, or ui)
providers → core
```

An engine that cannot import a provider cannot accidentally make a network call inside a probability calculation. This is the rule that keeps backtesting honest.

---

## 5. New database tables

Grouped by migration. All tables carry `created_at timestamptz not null default now()`. All user-owned tables carry `org_id uuid not null references organizations(id)`.

**`0001_foundation`** — `organizations`, `org_members`, `user_profiles`, `subscriptions`, `feature_flags`, `audit_logs`, `data_providers`, `data_ingestion_jobs`, `data_quality_snapshots`

**`0002_prediction_core`** — `models`, `model_versions`, `model_features`, `training_runs`, `prediction_runs`, `predictions`, `prediction_outcomes`, `prediction_factors`, `prediction_model_outputs`, `prediction_history` (probability time-series), `model_metrics`, `calibration_bins`

**`0003_sports`** — `sports`, `leagues`, `seasons`, `teams`, `players`, `games`, `team_season_stats`, `team_game_stats`, `player_game_stats`, `injuries`, `lineups`, `h2h_cache`, `team_ratings` (Elo/strength time-series)

**`0004_crypto`** — `assets`, `crypto_assets`, `crypto_prices`, `crypto_candles` (partitioned), `crypto_indicators`, `crypto_orderbook_snapshots`, `crypto_onchain_metrics`, `crypto_derivatives` (funding/OI/liquidations)

**`0005_news`** — `news_sources`, `news_articles`, `news_events` (clusters), `news_event_articles`, `news_entities`, `news_article_entities`, `news_entity_sentiment`, `entity_graph_nodes`, `entity_graph_edges`

**`0006_user_surface`** — `watchlists`, `watchlist_items`, `alerts`, `alert_triggers`, `signals`, `signal_evidence`, `notifications`

**`0007_macro`** *(architecture only in Phase 1–3)* — `macro_indicators`, `macro_releases`, `economic_calendar`, `correlations`

### Key indexing / partitioning decisions

- `crypto_candles` — **declaratively partitioned by month** on `open_time`, PK `(asset_id, interval, open_time)`. This table dominates row count; monthly partitions keep index depth flat and make retention a `DROP PARTITION`.
- `crypto_prices` — hypertable-shaped: `(asset_id, ts DESC)` BRIN index. Ticks are append-only and time-ordered, so BRIN costs ~nothing and prunes well.
- `news_articles` — `tsvector` GIN on `title || summary` for search; `btree (published_at DESC)`; `unique (source_id, external_id)` for idempotent ingestion; `unique (url_hash)` as a second dedup guard.
- `predictions` — `(domain, subject, generated_at DESC)`, plus a **partial index** `where outcome_id is null` so the outcome-settlement job scans only unsettled rows.
- `news_article_entities` and `entity_graph_edges` — composite PKs, no surrogate ids.

### Migration policy

Every migration ships as a pair: `NNNN_name.up.sql` / `NNNN_name.down.sql`. Down migrations are tested in CI by running up→down→up on a scratch database. No migration is allowed to drop a column containing prediction history — deprecated columns are renamed `_deprecated_*` and removed only after a full retention cycle (§39 of the brief: *never delete failed predictions*).

---

## 6. Data-provider abstraction

```ts
interface Provider {
  readonly id: string
  readonly reliability: ReliabilityClass
  health(): Promise<ProviderHealth>
}

interface CryptoProvider extends Provider {
  getPrice(symbol: string): Promise<Result<PriceTick, ProviderError>>
  getCandles(symbol: string, interval: Interval, limit: number): Promise<Result<Candle[], ProviderError>>
  getOrderBook(symbol: string, depth: number): Promise<Result<OrderBook, ProviderError>>
  getMarketData(symbol: string): Promise<Result<MarketData, ProviderError>>
}
// SportsProvider, NewsProvider, OnChainProvider, MacroProvider follow the same shape
```

Three properties make this more than an interface:

1. **`Result<T, E>`, not exceptions.** A provider failure is a value the orchestrator must handle, not a throw that unwinds into a 500. A failed provider degrades the *data quality score*; it does not produce a fake number.
2. **A registry with an ordered fallback chain per capability.** `registry.crypto.candles = [binance, coingecko, demo]`. The registry records which provider actually answered, and that provenance travels all the way into `VixeraPrediction.sources[]` and onto the screen.
3. **Every returned record carries `fetchedAt` and `sourceId`.** Freshness is not inferred later; it is measured at the boundary.

---

## 7. Recommended first production data providers

| Domain | Provider | Key? | Free tier | Why it is first choice |
|---|---|---|---|---|
| Crypto OHLCV / order book / derivatives | **Binance public REST + WS** | No | Generous, IP-rate-limited | Deepest book, exchange-native candles, funding + open interest + liquidations in one place. Keyless for market data |
| Crypto price / market cap / global | **CoinGecko** | Optional (Demo key raises limits) | 30 calls/min | Broad asset coverage, market cap and dominance, good cross-check against Binance |
| Crypto redundancy | **Coinbase Exchange public** | No | Yes | Independent venue — disagreement between Binance and Coinbase is itself a data-quality signal |
| On-chain | **Blockchair / Mempool.space** (BTC), **Etherscan** (ETH) | Etherscan yes (free) | Yes | Cheapest honest start. Glassnode/Nansen later for MVRV/SOPR — those are genuinely paid-only |
| Football/soccer | **football-data.org** | Yes (free tier) | 10 calls/min, top-10 leagues | Free tier is enough to build and validate the whole sports engine on one league |
| Sports (scale-up) | **API-Football (API-Sports)** | Yes (paid) | 100/day free | Lineups, injuries, xG, 1000+ leagues. The upgrade path once the engine is proven |
| US sports | **SportsDataIO** or **balldontlie** (NBA, free) | Mixed | Yes | Phase 8 |
| News | **RSS (Reuters, AP, Bloomberg, CNBC, WSJ, CoinDesk, The Block)** | No | Yes | Legal, keyless, publisher-sanctioned. Enough for clustering + sentiment + importance |
| News (scale-up) | **GDELT 2.0** (free) then **NewsAPI.ai / Marketaux** | Mixed | Yes | GDELT gives global event coverage and tone at zero cost |
| Macro | **FRED** | Yes (free) | Unlimited-ish | CPI, rates, DXY, yields, employment — authoritative and free |
| Economic calendar | **Trading Economics** / FRED release calendar | Mixed | Limited | Calendar first, consensus figures later |

**Explicitly excluded:** scraping Twitter/X, scraping paywalled outlets, scraping sportsbooks. Sentiment starts from RSS + Reddit's official API + GDELT tone. Bookmaker odds are only ingested if you obtain a licensed feed (The Odds API is the usual legal route); the *Vixera Edge* calculation is written and unit-tested now but stays dark until such a feed exists.

**Recommended order to acquire keys:** football-data.org (free, unblocks Phase 2 live data) → FRED (free, unblocks macro model) → Etherscan (free) → API-Football (paid, when one league is proven) → The Odds API (paid, only if you want Edge).

---

## 8. Prediction architecture

### 8.1 The universal object

Every domain returns the same `VixeraPrediction`. This is what makes the Command Center, the AI Analyst, the alert evaluator and the performance dashboard domain-agnostic — each one is written once.

```ts
interface VixeraPrediction {
  id: string
  domain: 'sports' | 'crypto' | 'stocks' | 'forex' | 'events'
  subject: string                 // 'BTC-USD' | 'game:12345'
  timeframe?: Timeframe           // '15m' | '1h' | '4h' | '24h' | '7d' | '30d' | 'event'
  outcomes: Outcome[]             // probabilities sum to 1 ± 1e-9, invariant-checked
  confidence: number              // 0..1
  dataQuality: number             // 0..100
  modelAgreement: number          // 0..1
  riskLevel: 'low' | 'medium' | 'high' | 'extreme'
  supportingFactors: PredictionFactor[]
  opposingFactors: PredictionFactor[]
  modelOutputs: ModelOutput[]
  scenarios?: Scenario[]
  volatility?: VolatilityForecast
  sources: SourceRef[]            // provenance, per dataset, with fetchedAt
  dataMode: 'live' | 'partial' | 'demo'   // NEVER inferred — set at the boundary
  generatedAt: string
  dataTimestamp: string           // oldest input timestamp, not newest
  modelVersion: string
}
```

Two details that matter more than they look:

- **`dataTimestamp` is the *oldest* contributing input**, not the newest. A prediction is exactly as fresh as its stalest ingredient. Taking the newest would let one live tick disguise an hour-old order book.
- **`dataMode` is a discriminated field carried from the provider registry.** A prediction built on any demo provider is `'demo'` and the UI renders it with a DEMO banner it cannot suppress. There is no code path that produces `'live'` without a live provider having actually answered.

### 8.2 The ensemble

```
        ┌─ Technical model ────┐
        ├─ Momentum model ─────┤
Features├─ Structure model ────┤→ Meta-combiner → calibrator → VixeraPrediction
        ├─ Order-flow model ───┤   (log-odds       (isotonic /
        ├─ On-chain model ─────┤    pooling)        Platt)
        ├─ Sentiment model ────┤
        ├─ News model ─────────┤
        └─ Macro model ────────┘
```

- Each model implements `PredictionModel<F>`: `run(features: F, ctx): ModelOutput`. Pure, synchronous, deterministic.
- A model may **abstain** (`{ abstained: true, reason }`) when its inputs are missing. Abstention is not a 50% vote — it removes the model from the pool and lowers confidence. This is the difference between "no information" and "neutral information", and conflating the two is one of the most common ways ensembles silently lie.
- **Combination is by weighted log-odds pooling**, not probability averaging. Averaging probabilities systematically pulls toward 0.5 and destroys calibration at the extremes; pooling in log-odds space preserves the strength of agreeing evidence. Weights come from each model's own historical Brier skill score, stored in `model_metrics`, not from hand-tuning.
- **Model agreement** = `1 − normalized dispersion of the pool in log-odds space`. High disagreement mechanically reduces confidence (§66 of the brief).

### 8.3 Confidence

Confidence is a separate scalar from probability, computed as a product of penalty terms:

```
confidence = base
  × f(dataQuality)          // stale or missing data → down
  × f(modelAgreement)       // disagreement → down
  × f(effectiveSampleSize)  // thin history → down
  × f(featureCompleteness)  // abstentions → down
  × f(regimeStability)      // recent volatility-regime break → down
```

Each term is bounded and documented in `core/prediction/confidence.ts` with a unit test per term. Confidence never exceeds a ceiling set by the *worst* input.

### 8.4 Explainability

Contributions are computed, never written by an LLM. For the linear/log-odds layer the contribution of model *i* is `w_i · (logit(p_i) − logit(p_prior))`, normalised to percentage points of the final probability. For tree/nonlinear models added later, SHAP values from the Python service fill the same field. **If a model cannot produce a contribution, the field is `null` and the UI omits it** rather than showing a plausible-looking fabricated percentage (§45 of the brief).

The LLM's only role in explanation is turning the computed factor list into a sentence.

---

## 9. Sports architecture

**Phase 2 ships one sport — football/soccer — end to end.**

```
Ingestion → team_game_stats ─┬→ Elo/Glicko rating (team_ratings, time-series)
                             ├→ Vixera Form Score (0–100)
                             ├→ Team Strength (7 components)
                             ├→ Availability model (injuries/lineups)
                             └→ H2H features (capped influence)
                                        ↓
                    Dixon–Coles bivariate Poisson  ─┐
                    Elo-logistic                    ─┼→ meta-combiner → 1X2 + scenarios
                    Market-structure/rest/travel     ─┘
```

**Vixera Form Score (0–100)** — an opponent-adjusted, recency-weighted composite:

```
raw = Σ_g w(g) · [ 0.40·resultPoints(g)
                 + 0.25·normalizedGoalDiff(g)
                 + 0.20·opponentStrength(g)
                 + 0.15·performanceVsExpected(g) ]      // xG-based when available
w(g) = exp(−λ · gamesAgo)      λ tuned per sport, default 0.18 (half-life ≈ 3.8 games)
then venue-adjusted, schedule-difficulty adjusted, and squashed to 0–100 via a
league-relative logistic so that 50 = median team in that league that season.
```

The `performanceVsExpected` term is what stops the score from being "recent results with extra steps" — a team winning 1–0 on 0.4 xG against 2.1 xG conceded is flagged as fortunate, and Form Score declines even though results are good.

**Team Strength (7 components)**, each 0–100 with sport-specific weights: Attack, Defense, Form, Depth, Health, Home/Away, Momentum. Weights live in `engines/sports/config/<sport>.ts`, are versioned, and are inputs to the model registry — changing a weight produces a new `model_version`.

**Match model.** Dixon–Coles corrects the independent-Poisson underestimate of low-scoring correlated outcomes (0–0, 1–0, 1–1), which is precisely where the draw probability lives. Getting the draw right is most of getting football right. Output is a full score matrix → 1X2, over/under, both-teams-to-score, and a correct-score distribution, all from one coherent joint distribution rather than three independent guesses.

**Head-to-head is deliberately capped** at a small weight with an effective-sample-size shrink toward the prior. Five meetings across four seasons with different squads is weak evidence, and the brief is right to warn against overweighting it.

**Player-absence impact** is measured, not asserted: a team's rating is recomputed on the historical subsets of matches with and without the player, shrunk by minutes played and sample size. If the sample is too thin, the module reports *insufficient data* instead of a number.

---

## 10. Crypto architecture

```
Binance REST/WS ─→ candles, book, funding/OI ─┐
CoinGecko ────────→ market cap, global ───────┤→ FeatureBuilder (pure, from stored data)
Etherscan/Blockchair → on-chain ──────────────┤        ↓
RSS/GDELT ────────→ news + sentiment ─────────┘   9 models → meta → calibrator
FRED ─────────────→ macro ────────────────────┘        ↓
                                   multi-timeframe predictions + scenarios + volatility
```

**Timeframes are never mixed.** Each of 15m/1h/4h/24h/7d/30d is an independent prediction with its own feature window, its own model weights, its own calibration curve and its own accuracy tracking. A 15m and a 7d forecast pointing opposite directions is not a bug — it is information, and the UI shows both.

**Indicators** (SMA, EMA, RSI, MACD, Bollinger, ATR, VWAP, StochRSI, ADX, OBV, Fibonacci, S/R via fractal clustering, volume profile) are implemented as pure, individually unit-tested functions with values verified against reference series. They are **features, not rules** — no `if (rsi < 30) buy`. Each indicator is transformed into a normalised z-score or percentile feature and fed to models that learned their weights from history.

**Volatility is forecast separately from direction** (§24 of the brief), using EWMA/GARCH-style realised volatility plus an ATR-percentile regime classifier. Direction and magnitude are different questions with different accuracy profiles, and a system that fuses them can be right about direction while badly wrong about range.

**Scenarios** (bull/base/bear) are not three hand-written numbers. They are quantile bands of the forecast return distribution — base = interquartile region, bull/bear = the tails — with probabilities that sum to 1 by construction and target ranges that come from the volatility forecast. This makes them internally consistent with the directional probability.

**Order-book intelligence** carries an explicit caveat in code and in UI: resting orders are not commitments, and spoofing is common. The order-flow model therefore weights *executed* flow (trade imbalance, aggressor side) well above *resting* depth.

---

## 11. News architecture

```
RSS/GDELT → normalize → dedup(url_hash, simhash) → embed → cluster(events)
                                                              ↓
                     entity extraction → entity-level sentiment → knowledge graph
                                                              ↓
                              importance score → breaking detector → market linkage
```

- **Clustering** is incremental online clustering over embeddings (cosine, threshold + time-decay window). Twelve outlets covering the same Fed decision must collapse into one `news_event` with twelve sources, and the *count of independent sources* becomes a credibility input rather than twelve separate "important events".
- **Sentiment is per-entity, not per-article** (§30). "Regulator fines Exchange X" is bearish for X, mildly bullish for a compliant competitor, and neutral overall. Article-level sentiment would average this into meaningless mush.
- **Importance score (0–100)** = weighted blend of source reliability, independent-source count, entity importance, category prior, novelty (distance from the last 24h of clusters), reporting velocity, and *historically observed* market response for that event category.
- **Breaking detection** fires on velocity — a spike in independent sources per unit time for a new cluster — not on the word "BREAKING" in a headline.
- **Rumour handling:** a cluster whose sources are all `SOCIAL`/`UNVERIFIED` is rendered as **UNVERIFIED REPORT, 0 independent confirmations**, and is excluded from the news model's feature vector entirely until an `ESTABLISHED_MEDIA`+ source appears.
- **News → market linkage** is empirical where possible: the historical response of an asset to that event category, with an explicit "insufficient historical data" state. The system does not assert causation it has not measured.

---

## 12. AI architecture

Two strictly separated roles, enforced at the type level:

| Layer | Job | Never does |
|---|---|---|
| **Quantitative** (`engines/`) | All probabilities, all confidence, all contributions | Free text |
| **LLM** (`lib/ai/`) | Query understanding, entity extraction, summarisation, event classification, phrasing the computed explanation, cross-domain narrative | Produce, adjust, or round a probability |

The AI Analyst is a **tool-calling agent over internal Vixera data only**. Its tools are typed read queries: `getPrediction`, `comparePredictions`, `getSignals`, `searchNews`, `getModelPerformance`, `whatChanged`, `getWatchlist`. It has no free-text database access and no ability to answer a numeric question from model memory — if the tools return nothing, the answer is "I don't have that data", not a guess.

The type system enforces the separation: LLM outputs are parsed into `zod` schemas that contain no probability fields. There is no code path from an LLM string to `VixeraPrediction.outcomes[].probability`.

---

## 13. Background-job architecture

| Job | Cadence | Mechanism |
|---|---|---|
| Crypto ticks/book | seconds | Long-lived WS worker (Railway/Fly) → Supabase; SSE fan-out to clients |
| Candle close | per interval | Vercel Cron + Binance REST reconciliation |
| Indicator/feature recompute | on candle close | Event-driven, triggered by `CANDLE_CLOSED` |
| Crypto predictions | per timeframe close | Event-driven |
| News poll | 60s | Vercel Cron |
| Clustering + scoring | on new article | Event-driven |
| Sports fixtures/stats | hourly / daily | Vercel Cron |
| Lineups/injuries | 15 min, tightening to 2 min near kickoff | Adaptive cron |
| Sports predictions | on `LINEUP_CHANGE`, `INJURY`, `T-minus` schedule | Event-driven |
| Outcome settlement | 10 min | Cron — scans the partial index of unsettled predictions |
| Metrics/calibration recompute | hourly | Cron |
| Alert evaluation | on every new prediction | Event-driven |

**Event bus.** A Postgres `events` table plus `LISTEN/NOTIFY` in Phase 1 (zero new infrastructure), swappable for a real queue later behind `core/events/bus.ts`. Events: `NEW_ARTICLE`, `PRICE_TICK`, `CANDLE_CLOSED`, `LINEUP_CHANGE`, `PLAYER_INJURY`, `GAME_STARTED`, `GAME_FINISHED`, `VOLATILITY_SPIKE`, `PREDICTION_UPDATED`, `MODEL_SIGNAL`.

The cascade from the brief (§53) is implemented literally: `PLAYER_INJURY → recompute team strength → recompute match probability → write prediction_history row → evaluate alerts → push SSE`.

**Idempotency.** Every ingestion job writes through a natural unique key and is safe to re-run. Every job records start/end/rows/errors in `data_ingestion_jobs`, and that table is the data source for the freshness indicators on screen.

---

## 14. Security / RLS plan

- Supabase Auth; every user belongs to ≥1 organization. Every user-owned table has `org_id` and an RLS policy `org_id in (select org_id from org_members where user_id = auth.uid())`.
- Market/reference data (prices, articles, teams) is world-readable to authenticated users; **write access is `service_role` only** — ingestion runs server-side.
- `predictions` are readable per-org; the raw `prediction_model_outputs` are gated by tier (Pro+) via a security-definer view rather than by hiding them in the client.
- **All provider keys are server-only** (`process.env`, never `NEXT_PUBLIC_*`). A CI check fails the build if a provider module is imported from a client component.
- Rate limiting per user and per org at the route-handler edge; separate stricter bucket for `/api/ai/query`.
- Zod validation on every route input **and on every provider response** — an upstream schema change must fail loudly, not silently poison a model.
- `audit_logs` for auth events, tier changes, alert mutations, and every model-version promotion.

---

## 15. UI architecture

Design language: dark, dense, glass panels, restrained glow, monospaced numerics, generous negative space around the numbers that matter. Institutional terminal — deliberately *not* a betting product. Colour is used for *state*, never for excitement: no flashing, no confetti, no green/red maximalism. Probability is shown as a bar with a numeral, never as a slot-machine dial.

Component hierarchy:

- **Primitives** — `Panel`, `Stat`, `ProbabilityBar`, `ConfidenceMeter`, `RiskBadge`, `TrendArrow`, `DataFreshness`, `DataModeBanner`, `SourceList`, `Sparkline`, `Skeleton`, `EmptyState`, `ErrorState`
- **Composites** — `PredictionCard` (the atom of the whole product), `ModelBreakdown`, `FactorList`, `ScenarioBands`, `ComparisonTable`, `SignalRow`, `NewsEventCard`, `CalibrationChart`, `WhatChangedPanel`
- **Screens** — Command Center, Sports, Compare, Crypto, Asset detail, News, Predictions, Signals, Watchlist, Analyst, Alerts, History, Performance, Settings

Every data-bearing component implements four states: `loading`, `empty`, `error`, `stale`. A component that cannot render a value renders *why*, never a placeholder number. `DataModeBanner` is non-dismissible when `dataMode !== 'live'`.

Live updates via SSE (`/api/stream`), with React Server Components for the initial render so the first paint is real data rather than a skeleton.

---

## 16. Testing strategy

| Layer | Tool | What is tested |
|---|---|---|
| Prediction math | Vitest | Every indicator against reference series; Elo convergence; Poisson/Dixon–Coles distributions sum to 1; log-odds pooling identities; Brier/log-loss against hand-computed values; calibration monotonicity; **property tests**: probabilities always sum to 1, confidence always in [0,1], no NaN for any finite input |
| Provider adapters | Vitest + recorded fixtures | Schema validation, error mapping, rate-limit handling, fallback chain order |
| Pipelines | Vitest integration | Ingest → feature → predict → persist, against a seeded scratch DB |
| Invariants | Vitest | `dataMode='live'` is unreachable without a live provider; demo data never enters a persisted prediction |
| Backtest | Custom harness | Point-in-time replay; a leakage guard asserts every feature's timestamp < prediction timestamp |
| E2E | Playwright (Phase 4+) | Critical screens render all four states |

**The leakage guard is the most important test in the suite.** Every feature carries a timestamp; the backtest harness asserts, for every feature of every historical prediction, that the feature predates the prediction. A backtest that cannot prove this is not a backtest — it is a demonstration of hindsight.

---

## 17. Development phases

| Phase | Contents | Status |
|---|---|---|
| **1 — Foundation** | Schema + migrations, RLS, auth, provider layer + registry, `VixeraPrediction`, orchestrator, data-quality engine, event bus, app shell, design system, watchlist/alerts architecture | **This session** |
| **2 — Sports MVP** | Football/soccer only: ingestion, Form Score, Team Strength, Elo, Dixon–Coles, fair odds/edge, explainability, comparison screen, prediction history | **This session** |
| **3 — Crypto MVP** | BTC/ETH/SOL: Binance + CoinGecko, indicators, structure, order flow, 9-model ensemble, multi-timeframe, scenarios, volatility, signals | **This session** |
| 4 — News engine | Ingestion, clustering, entity sentiment, importance, breaking detection | Next |
| 5 — Cross-domain | Knowledge graph, news→market linkage, event-driven prediction updates, What Changed | Next |
| 6 — AI Analyst | Tool-calling agent over internal data | Next |
| 7 — Validation | Backtesting harness, Brier/calibration, model registry UI, performance dashboard | Next |
| 8 — Advanced | Whale tracking, on-chain, derivatives, options, macro, correlation, more sports | Later |

---

## 18. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Overconfident probabilities.** The classic failure of ensembles — confidently wrong at the extremes | Isotonic calibration from day one; calibration curve on the public performance page; confidence ceiling tied to the worst input |
| R2 | **Data leakage in backtests** producing fantastic historical accuracy that evaporates live | Timestamped features + automated leakage guard test; point-in-time snapshots only |
| R3 | **Provider dependency / rate limits** | Ordered fallback chains; every capability has ≥2 real providers; aggressive caching with per-datatype TTLs; graceful `Data unavailable` |
| R4 | **Model quality plateaus in pure TypeScript** | `PredictionModel` interface is transport-agnostic; a Python service slots in behind it without touching the orchestrator |
| R5 | **Perceived as a gambling product** — app-store, payment-processor and regulatory risk | Analytical language throughout; no bet slips, no bookmaker deep-links, no "lock" language; Edge is dark until a licensed odds feed exists; persistent probabilistic disclaimer |
| R6 | **Cold-start: no accuracy history**, so the performance page is empty | Show **"Insufficient data"** — never a fabricated statistic. Ship with a backtested baseline clearly labelled as backtest, not live record |
| R7 | **Sports data is expensive at scale** | Prove the engine on one free league before paying for 1000 |
| R8 | **Cost blow-up from LLM calls on every article** | Summarise once per *cluster*, not per article; cheap local embeddings for clustering; batch entity extraction |
| R9 | **Sentiment models mistake volume for direction** | Entity-level sentiment; volume and direction tracked as separate features |
| R10 | **Serverless cannot hold WebSockets** | Market WS lives in a small always-on worker; Vercel handles request/response and SSE fan-out only |

---

## 19. The no-fake-data guarantee

This is a design property, not a policy statement:

1. `dataMode` originates in the provider registry and is propagated, never derived.
2. Demo providers are in a separate module tree and are registered **only** when `VIXERA_ALLOW_DEMO=true`; the production build fails if that variable is set in a production environment.
3. Any prediction whose provenance includes a demo provider is stamped `'demo'` and is **excluded from all accuracy statistics**.
4. A missing value renders `Data unavailable` and reduces `dataQuality`. There is no default, no zero-fill, no last-known-value substitution without an explicit staleness label.
5. `Math.random()` is banned outside the demo module tree and outside tests, enforced by an ESLint rule.

---

## 20. Exact implementation order

1. TS strict config, ESLint boundary + no-`any` + no-`Math.random` rules, Vitest setup
2. `core/result.ts`, `core/errors.ts`, `core/clock.ts`, `core/logger.ts`
3. `core/prediction/types.ts` — the universal object and its invariants
4. `core/prediction/probability.ts` — normalisation, log-odds, fair odds, implied probability, vig removal, edge
5. `core/prediction/ensemble.ts`, `confidence.ts`, `risk.ts` + tests
6. `core/metrics/*` — Brier, log loss, calibration, accuracy buckets + tests
7. `core/quality/*` — data-quality score, freshness
8. `providers/types.ts`, `providers/http.ts`, `providers/registry.ts`
9. Migrations `0001`–`0006` (up + down)
10. `db/client.ts`, repositories
11. `engines/orchestrator.ts`
12. Design system primitives + app shell + navigation
13. **Crypto:** Binance + CoinGecko adapters → indicators → structure → 9 models → meta → scenarios → volatility → screens
14. **Sports:** football-data adapter → Form Score → Team Strength → Elo → Dixon–Coles → meta → comparison screen
15. Signals engine, watchlist, alerts
16. Command Center, Predictions, History, Performance screens
17. Test suite green, strict typecheck, production build

---

*Vixera Intelligence provides probabilistic analytical information and does not guarantee future market or sporting outcomes.*
