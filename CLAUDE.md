# PRAEVION (by Vixera AI) — Project Context for Claude Code

Predictive-intelligence web platform: prediction markets, crypto, sports, news,
and a deterministic analyst briefing. Working name in code: `vixera-intelligence`;
product name: **Praevion** ("See before it happens").

- **Live production:** https://vixera-intelligence.vercel.app
- **Full spec:** `IMPLEMENTATION_PLAN.md` (20 sections — read it before architectural changes)
- **Stack:** Next.js 15 (App Router) · React 19 · TypeScript strict + `noUncheckedIndexedAccess` · Tailwind v4 · Supabase Postgres · Vitest · deployed on Vercel

## Current state (as of 2026-08-24)

| Phase | Status |
|---|---|
| 1 — Foundation (core prediction objects, providers, registry, DB schema, UI shell) | ✅ deployed |
| Rebrand — Praevion identity, SVG logo system, PWA manifest/icons | ✅ deployed |
| 2 — Sports MVP (football: Elo, Dixon–Coles, Form Score, Team Strength, 7 leagues) | ✅ deployed |
| 3 — Crypto MVP + prediction-market edge scanner (Kalshi/Polymarket) | ✅ deployed |
| 4 — News engine (15 RSS feeds, clustering, entity sentiment, importance) + deterministic AI Analyst | ✅ deployed |
| **8 — Adaptive Intelligence Engine** (learned model, walk-forward validation, full betting-market derivation, prediction persistence + settlement, adaptive ensemble weights, odds provider boundary, Model Lab / Learning / History screens) | ✅ built, in repo (v0.5.0) — needs `SUPABASE_SERVICE_ROLE_KEY` in prod to activate the memory half of the loop |
| 5 — Knowledge graph / news→market linkage | ⬜ next |
| 6 — Conversational AI Analyst (needs LLM API key; deterministic seam is marked in `src/engines/news/seam.ts` and `src/engines/analyst/`) | ⬜ |
| 7 — Backtesting + calibration dashboard (calibration + walk-forward now surfaced in `/sports/model-lab`; the generic backtesting screen still awaits accumulated history) | ◐ |

Last verified locally: **~700 tests green, `tsc --noEmit` clean, production build clean, live
ESPN/Coinbase/RSS data verified through the running server.**
`package.json` version 0.5.0 (the deployed Vercel bundle predates the adaptive engine — see Infrastructure).

## The Adaptive Intelligence Engine (Phase 8)

The self-learning loop and where each stage lives:

```
predict   predictMatch pools 4 models: Dixon–Coles, Elo–Davidson, Form/Venue, and
          football.learned — an L2-regularized multinomial logistic regression
          (core/learning/logistic.ts) trained per request on the league's own
          history via one-pass as-of feature building (engines/sports/learned.ts;
          leakage is structurally impossible and tested).
validate  core/learning/walk-forward.ts replays history chronologically —
          train-before/validate-after, no shuffling. /sports/model-lab shows the
          learned model vs a base-rate benchmark on identical folds, computed live.
derive    engines/sports/bet-markets.ts reads EVERY market off the one DC score
          matrix: 1X2, double chance, DNB, BTTS, totals 0.5–4.5, team totals,
          correct scores, European handicap, Asian handicap with exact
          quarter-line settlement (fullWin/halfWin/push/halfLoss/fullLoss).
persist   orchestrator.maybePersist writes pre-kickoff snapshots (throttled 30min
          per fixture) via the append-only repositories; /api/cron/snapshot runs
          it for all 7 leagues on a schedule.
settle    orchestrator.settleFinishedGames + /api/cron/settle resolve unsettled
          predictions against verified final scores (idempotent; the kickoff lock
          keeps post-kickoff rows out of the accuracy record forever).
score     db/repositories/model-performance.ts computes per-model Brier/log-loss/
          accuracy and calibration observations from settled rows at read time.
adapt     core/learning/adaptive-weights.ts turns measured skill into weight
          multipliers (min 30 samples, shrinkage n/(n+50), clamp [0.4, 1.6]);
          the orchestrator feeds them into predictMatch.config.modelWeights.
compare   engines/sports/odds-edge.ts + providers/odds/the-odds-api.ts compare
          model probability vs de-vigged consensus (power method), with
          quarter-Kelly sizing math (core/staking/kelly.ts, 2% cap) at the best
          price. No key → "Sportsbook odds unavailable", never fake prices.
```

The loop's memory requires `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`;
without them predictions still compute live and every learning surface renders an
honest "not configured" state. Screens: `/sports/model-lab`, `/sports/learning`,
`/sports/history`; jobs: `/api/cron/settle`, `/api/cron/snapshot` (guarded by
`CRON_SECRET` when set).

## Non-negotiable architecture rules

These are enforced by tests/ESLint and by construction — do not weaken them:

1. **Engines are pure.** Nothing in `src/engines/**` (except files named `orchestrator.ts`)
   may touch network, DB, `Date.now()`, or `Math.random()`. Time enters via explicit
   `asOf`/`Clock` params (`src/core/clock.ts`). This is what makes backtesting honest.
2. **`VixeraPrediction` is built ONLY via `buildPrediction()`** (`src/core/prediction/builder.ts`).
   It derives `dataMode` from source provenance — there is deliberately no way to claim
   `'live'` without a live provider having answered. Invariants (probabilities sum to 1,
   ranges) are asserted at construction.
3. **No fake data, ever.** Demo providers are gated by `VIXERA_ALLOW_DEMO` and blocked in
   production (`demoAllowed()` in `src/providers/registry.ts`). Missing data renders
   "Data unavailable" and lowers the data-quality score — never a default or invented value.
   Performance stats below `MIN_SAMPLE_FOR_DISPLAY` show "Insufficient data".
4. **Providers return `Result<T, ProviderError>`,** never throw across the boundary; every
   payload carries `Provenance {sourceId, fetchedAt, dataAsOf, isDemo}`. Registry
   (`src/providers/registry.ts`) resolves ordered fallback chains and records the attempt trail.
5. **Probability comes from quantitative models only.** LLMs (when a key exists) may do
   language tasks via the marked seams; no code path exists from LLM text to a probability
   field — keep it that way.
6. **Confidence ≠ probability.** `computeConfidence()` is a product of bounded penalty
   terms (data quality, model agreement, sample size, feature completeness, regime
   stability). Ensemble combination is weighted **log-odds pooling** (`ensemble.ts`),
   with abstention ≠ neutral vote.
7. Comment style: explain **why**, at the density found in `src/core/prediction/*.ts`.

## Layout

```
src/core/         prediction objects, probability math, ensemble, confidence, risk,
                  metrics (Brier/log-loss/calibration/isotonic), data-quality, clock, Result
src/providers/    types + registry + adapters:
                  crypto: coinbase (primary, keyless), kraken, coingecko, binance (disabled
                          from US infra — returns 451 on Vercel; keep last in chain)
                  odds:   the-odds-api (keyed via ODDS_API_KEY; no demo fallback BY DESIGN)
                  markets: kalshi, polymarket (keyless public APIs)
                  sports: espn (keyless, 7 soccer leagues), football-data.org (needs free key)
                  news: rss (15 probed feeds — Reuters/AP via Google News syndication,
                        WSJ feeds.a.dj.com, CNBC search mirror, BBC, CoinDesk, The Block, …)
src/core/learning logistic (deterministic trainable model), walk-forward validation,
                  adaptive-weights (measured skill → capped ensemble multipliers)
src/core/staking  kelly.ts — Kelly / fractional-Kelly / EV mathematics (analytical only)
src/engines/      crypto/ (indicators, structure, 9-model ensemble, scenarios, volatility)
                  sports/ (elo, poisson [Dixon–Coles], form, strength, match-prediction,
                          learned [Model E + as-of features], bet-markets [full market
                          derivation incl. Asian quarter lines], odds-edge [no-vig +
                          edge + staking], settlement)
                  news/   (normalize, entities [96-entry dict], sentiment [lexicon,
                          per-entity], cluster [TF-IDF cosine], importance, seam.ts [LLM slot])
                  analyst/ (briefing composer + whatChanged diff)
                  */orchestrator.ts = the I/O layer: registry fetch → engine → buildPrediction;
                  in-memory TTL caches with inflight dedup (sports 6h dataset, news/analyst 120s)
src/app/(app)/    screens: command center, prediction markets, crypto, sports (+match/[gameId]),
                  consensus, edge, news, signals, watchlist, analyst, backtesting,
                  model performance, settings
src/app/api/      thin route handlers only — zod-validated, force-dynamic, {error,detail} envelope
src/db/migrations 0001–0007 up/down SQL pairs (applied to Supabase; runtime does not yet
                  persist predictions — see "Next work")
src/ui/           design system (Panel, ProbabilityBar, ConfidenceMeter, RiskBadge,
                  DataFreshness, …) + brand/logo.tsx (SVG LogoMark/Wordmark/LogoLockup)
tests/            608 vitest tests; prediction math is hand-computed-value tested
```

## Brand

Palette: bg `#0B0E14`, panel `#121826`, border `#1E293B`, violet `#7C3AED`,
blue `#3B82FF`, cyan `#00D4FF`, gray `#A1A1AA`. Tokens in `src/ui/theme/tokens.css`.
Brand colors are chrome-only; data semantics (green/red P&L, blue/cyan probability) are
separate — keep it that way. Logo components in `src/ui/brand/logo.tsx`; PWA icons
regenerated by `scripts/render-icons.mjs` (Playwright chromium).

## Infrastructure

- **Vercel:** project `vixera-intelligence` (id `prj_0fVz5E7YiMLnsPOlCZBTCEW1X7Sd`),
  team `team_7f0fAunm92v0GIxL6tsZcpmD`, alias `vixera-intelligence.vercel.app`. No auth
  gating on the site yet (auth/RLS architecture exists; enable when accounts are wanted).
- **Supabase:** project ref `hneutwmmqvhtsijentee`. Migrations 0001–0007 applied.
  Storage bucket `deploy-artifacts` (public **read**, write-locked) holds the deploy bundles.
- **Deploy pipeline (bootstrap-tarball workaround):** the Cowork session couldn't pass the
  full file tree to Vercel inline, so production builds fetch source during install:
  `installCommand = curl <supabase public url of vixera-src-vN.tar.gz> | extract && npm install`.
  Ship a new version by: (1) `tar --exclude='src/db/migrations' -czf bundle src public
  package.json tsconfig.json next.config.ts postcss.config.mjs eslint.config.mjs`,
  (2) temporarily re-create the anon-insert storage policy, upload, drop the policy,
  (3) redeploy with the updated installCommand URL.
  **From Claude Code with the repo local, prefer replacing this entirely:** push to GitHub
  and connect the Vercel project to the repo (or use `vercel` CLI) — then delete the
  bucket bundles and the storage policies migration dance.
- **Full source:** the complete repo (including migrations, tests, scripts, this file)
  was delivered as `praevion-repo-full.tar.gz` in the Cowork conversation that built it —
  extract, `npm install`, and you have the working tree this file describes. The
  `deploy-artifacts` bucket holds only the runtime deploy bundles (v1–v4, migrations and
  tests excluded); treat the delivered tarball as the source of truth and put it in git
  first thing.

## Environment variables (all optional today; none set in prod)

- `VIXERA_ALLOW_DEMO` / `VIXERA_ALLOW_DEMO_IN_PROD` — demo-provider gate (leave unset in prod)
- `VIXERA_ENABLE_BINANCE=false` — silence Binance health noise on US infra
- `FOOTBALL_DATA_API_KEY` — activates the football-data.org provider (free tier)
- `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — activates prediction
  persistence, settlement, history and adaptive weights (the learning loop's memory)
- `ODDS_API_KEY` — activates the sportsbook odds provider (the-odds-api.com free tier)
- `CRON_SECRET` — bearer guard for `/api/cron/settle` and `/api/cron/snapshot`
- Provider keys are server-only; never `NEXT_PUBLIC_*`.

## Verification loop (follow it for every change)

`npx tsc --noEmit` → `npx vitest run` (full suite stays green; new math gets
hand-computed-value tests) → `npm run build` → run the server, curl the touched API routes
for REAL data → Playwright-screenshot touched screens at 1280×800 and 390×844
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` in the cloud sandbox; locally `npx playwright install`)
and actually look at them.

## Known limitations / next work (in rough priority order)

1. **Activate the loop in prod:** set `NEXT_PUBLIC_SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY` on Vercel and schedule `/api/cron/snapshot` +
   `/api/cron/settle` (e.g. hourly). Persistence, settlement, history, the leaderboard,
   calibration and adaptive weights all light up from real accumulated outcomes — the
   code paths are wired and tested; only the credentials are missing.
2. **Sportsbook odds:** set `ODDS_API_KEY` (the-odds-api.com free tier) to activate the
   model-vs-market comparison, no-vig edge and staking math on match pages. Historical
   odds snapshots (closing-line comparison) are a follow-up once capture runs on a schedule.
3. **Model versioning depth:** predictions already carry exact `model_version`; the
   `model_versions`/`training_runs` tables await a persisted-artifact promotion flow
   (candidate/shadow/active) once retraining runs on stored coefficients instead of
   per-request training. Drift detection beyond the walk-forward fold trend also lives here.
4. **Phase 5:** entity graph already links news entities → `relatedAssets`; build the
   news→prediction-change linkage and the per-asset "What changed?" (briefing-level diff
   exists in `src/engines/analyst/briefing.ts#whatChanged`).
5. **Phase 6:** conversational analyst — add an LLM key, implement the seam as tool-calls
   over the existing orchestrators; the LLM must never output probabilities.
6. **Sports depth:** injuries/lineups provider (API-Football, paid) lights up the Depth/
   Health strength components and lifts `dataMode` from 'partial'; player props stay
   unexposed until a real player dataset exists. More sports after (architecture is
   league-config driven; a new sport needs a provider + engine config + evaluation).
7. **Auth + tiers:** Supabase Auth + RLS schema is in migrations; site is currently public.
8. Early-season note: football confidence is honestly low (~0.23) until 2026-27 results
   accumulate; Coventry-style promoted teams abstain to uniform — this is correct behavior,
   not a bug. The learned model likewise abstains under 120 training games per league.

## Safety posture (product requirement, not boilerplate)

Analytical language only: probabilities, confidence, edge — never staking advice,
never "guaranteed"/"lock"/"can't lose". The Analyst's banned-language property test
(`tests/analyst/briefing.test.ts`) enforces this; keep the disclaimer footer everywhere.
