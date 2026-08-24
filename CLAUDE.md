# PRAEVION (by Vixera AI) — Project Context for Claude Code

Predictive-intelligence web platform: prediction markets, crypto, sports, news,
and a deterministic analyst briefing. Working name in code: `vixera-intelligence`;
product name: **Praevion** ("See before it happens").

- **Live production:** https://vixera-intelligence.vercel.app
- **Full spec:** `IMPLEMENTATION_PLAN.md` (20 sections — read it before architectural changes)
- **Stack:** Next.js 15 (App Router) · React 19 · TypeScript strict + `noUncheckedIndexedAccess` · Tailwind v4 · Supabase Postgres · Vitest · deployed on Vercel

## Current state (as of 2026-08-13)

| Phase | Status |
|---|---|
| 1 — Foundation (core prediction objects, providers, registry, DB schema, UI shell) | ✅ deployed |
| Rebrand — Praevion identity, SVG logo system, PWA manifest/icons | ✅ deployed |
| 2 — Sports MVP (football: Elo, Dixon–Coles, Form Score, Team Strength, 7 leagues) | ✅ deployed |
| 3 — Crypto MVP + prediction-market edge scanner (Kalshi/Polymarket) | ✅ deployed |
| 4 — News engine (15 RSS feeds, clustering, entity sentiment, importance) + deterministic AI Analyst | ✅ deployed |
| 5 — Knowledge graph / news→market linkage | ⬜ next |
| 6 — Conversational AI Analyst (needs LLM API key; deterministic seam is marked in `src/engines/news/seam.ts` and `src/engines/analyst/`) | ⬜ |
| 7 — Backtesting + calibration dashboard (metrics code exists in `src/core/metrics/`; needs accumulated resolved predictions) | ⬜ |

Last verified locally: **608 tests green (26 files), `tsc --noEmit` clean, production build clean.**
Deployed bundle version: v4 (`package.json` version 0.4.0).

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
                  markets: kalshi, polymarket (keyless public APIs)
                  sports: espn (keyless, 7 soccer leagues), football-data.org (needs free key)
                  news: rss (15 probed feeds — Reuters/AP via Google News syndication,
                        WSJ feeds.a.dj.com, CNBC search mirror, BBC, CoinDesk, The Block, …)
src/engines/      crypto/ (indicators, structure, 9-model ensemble, scenarios, volatility)
                  sports/ (elo, poisson [Dixon–Coles], form, strength, match-prediction)
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
- `NEXT_PUBLIC_SUPABASE_URL` / anon key — for when auth/persistence is wired
- Provider keys are server-only; never `NEXT_PUBLIC_*`.

## Verification loop (follow it for every change)

`npx tsc --noEmit` → `npx vitest run` (full suite stays green; new math gets
hand-computed-value tests) → `npm run build` → run the server, curl the touched API routes
for REAL data → Playwright-screenshot touched screens at 1280×800 and 390×844
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` in the cloud sandbox; locally `npx playwright install`)
and actually look at them.

## Known limitations / next work (in rough priority order)

1. **Prediction persistence:** predictions are computed on demand but not yet written to
   the `predictions` tables — wire orchestrators to the repositories so history/accuracy
   accumulate. This unblocks Phase 7 (Brier, calibration, model performance — code exists
   in `src/core/metrics/`, dashboard shows "Insufficient data" until real history exists).
2. **Phase 5:** entity graph already links news entities → `relatedAssets`; build the
   news→prediction-change linkage and the per-asset "What changed?" (briefing-level diff
   exists in `src/engines/analyst/briefing.ts#whatChanged`).
3. **Phase 6:** conversational analyst — add an LLM key, implement the seam as tool-calls
   over the existing orchestrators; the LLM must never output probabilities.
4. **Sports depth:** injuries/lineups provider (API-Football, paid) lights up the Depth/
   Health strength components and lifts `dataMode` from 'partial'; more sports after.
5. **Auth + tiers:** Supabase Auth + RLS schema is in migrations; site is currently public.
6. Early-season note: football confidence is honestly low (~0.23) until 2026-27 results
   accumulate; Coventry-style promoted teams abstain to uniform — this is correct behavior,
   not a bug.

## Safety posture (product requirement, not boilerplate)

Analytical language only: probabilities, confidence, edge — never staking advice,
never "guaranteed"/"lock"/"can't lose". The Analyst's banned-language property test
(`tests/analyst/briefing.test.ts`) enforces this; keep the disclaimer footer everywhere.
