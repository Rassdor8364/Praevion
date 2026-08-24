# PRAEVION — by Vixera AI

**See before it happens.** A predictive-intelligence platform: adaptive sports betting
intelligence, crypto forecasting, prediction-market edge scanning, a news engine, and a
deterministic AI analyst — built on one honesty rule: **no fabricated data, ever.**
Missing data renders "Data unavailable" and lowers confidence; it is never replaced by
an invented number.

- Working name in code: `vixera-intelligence` · product name **Praevion**
- Stack: Next.js 15 (App Router) · React 19 · TypeScript strict · Tailwind v4 ·
  Supabase Postgres · Vitest
- Full context for agents and contributors: **`CLAUDE.md`** (read it first);
  full spec: `IMPLEMENTATION_PLAN.md`

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000 — works keyless with live public data
```

Verification loop (run all of it for every change):

```bash
npx tsc --noEmit
npx vitest run       # full suite must stay green
npm run build
```

## The Adaptive Intelligence Engine (sports)

Four models are pooled per fixture — Dixon–Coles (fitted attack/defence), Elo–Davidson,
a Form/Venue heuristic, and `football.learned`, a deterministic L2-regularized
multinomial logistic regression trained on the league's own history with strictly
as-of-kickoff features (leakage-tested). The full betting-market set (1X2, double
chance, DNB, BTTS, totals, team totals, correct scores, European and Asian handicaps
with exact quarter-line settlement) derives from one coherent score distribution.

The learning loop: predictions are **persisted pre-kickoff**, **settled** against
verified final scores (`/api/cron/settle`), **scored** per model (Brier / log loss /
calibration), and measured skill feeds **adaptive ensemble weights** (minimum-sample
gated, shrunk, capped). Walk-forward validation — never a random shuffle across time —
is computed live on `/sports/model-lab`; `/sports/learning` shows the loop's real
state; `/sports/history` is the permanent, never-rewritten record.

## Environment

Everything runs keyless with live public data (ESPN, Coinbase, Kraken, CoinGecko,
Kalshi, Polymarket, RSS). Optional keys activate more (see `.env.example`):

| Variable | Activates |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | prediction persistence, settlement, history, adaptive weights |
| `ODDS_API_KEY` | sportsbook comparison: no-vig edge + staking math (the-odds-api.com) |
| `FOOTBALL_DATA_API_KEY` | football-data.org provider (free tier) |
| `CRON_SECRET` | bearer guard for the cron routes |

Database migrations live in `src/db/migrations` (up/down pairs), applied via
`npm run db:migrate` with `DATABASE_URL` set.

## Safety posture

Analytical language only — probabilities, confidence, edge, expected value. Never
staking advice, never "guaranteed". Kelly figures are risk-capped sizing mathematics
presented with the product disclaimer, LLMs can never author a probability, and the
accuracy record is append-only: failed predictions survive intact, forever.
