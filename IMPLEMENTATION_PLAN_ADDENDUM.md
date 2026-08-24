# ADDENDUM — Prediction Markets, Betting & Futures Refocus

**Date:** 2026-08-12 · Supersedes the phasing in IMPLEMENTATION_PLAN.md §17; everything else in the base plan stands.

## What changed

Mid-build, the product brief was expanded: Vixera Intelligence's primary surface is now **prediction-market intelligence** — Kalshi, Polymarket, sports betting markets, and futures — ranked by **Vixera Edge** and **Opportunity Score**, with Smart Money, Consensus and Trader Intelligence as later phases. The original sports/crypto engines are unchanged in role: they are the *fair-probability sources* the market layer compares against venue prices.

## Revised phasing vs. what shipped this session

| Phase (new brief) | Contents | Status |
|---|---|---|
| 1 — Core architecture | Schema (79 live tables on Supabase `hneutwmmqvhtsijentee`), provider registry, universal prediction + market objects, edge/confidence/risk/opportunity engines, orchestrator | ✅ Shipped |
| 2 — Kalshi | Adapter (live, keyless), structured-strike coverage via `floor_strike`/`cap_strike` + curated crypto series, scanner, ranked opportunities | ✅ Shipped |
| 3 — Polymarket | Adapter (live, keyless: Gamma + CLOB), title-parse coverage, cross-market types + dislocation engine | ✅ Shipped (dislocation UI later) |
| 4 — News + economic | RSS provider shipped; clustering/sentiment/importance engines | Next |
| 5 — Sports | Engine shipped (Form Score, Elo, Dixon–Coles, 47 tests); needs a live data key + market linkage + UI | Partial |
| 6 — Crypto futures | 7-model ensemble, multi-timeframe, scenarios, volatility — live-verified end to end | ✅ Shipped |
| 7–10 — Smart Money, Consensus, AI Analyst, Backtesting | Consensus/herding math + trader schema shipped; ingestion, UI and the analyst are future phases | Architecture only |

## Design decisions made under the new brief

1. **Coverage honesty is structural.** The scanner computes an edge **only** where a Vixera model actually covers the event. Uncovered markets are counted and shown (`no-coverage` is on the Command Center), never assigned an invented probability. Current coverage: crypto threshold/range markets via a driftless-lognormal digital model (EWMA vol from live daily candles). Live result at build time: 350 scanned, 300 covered, and — correctly — **every opportunity ranked `no_action`**, because a 1-day crypto ladder is efficiently priced and the model's honest edges (±4pp with modest confidence) fall below the action thresholds. The system saying "nothing worth acting on today" on its first live scan is the anti-tip-sheet principle (§41, §78) working as designed.
2. **Kalshi strikes are read structurally** (`floor_strike`/`cap_strike` + series ticker), not parsed from titles; Polymarket falls back to a conservative title parser that rejects anything ambiguous. A wrong parse is worse than no parse.
3. **Edge ≠ EV ≠ confidence.** Edge is measured at the mid, EV at the executable ask, confidence separately — and the spread-eats-the-edge case forces `no_action` with a capped score.
4. **Execution boundary (§52):** analytics only. No order placement of any kind exists in the codebase; the trader/paper-portfolio tables are read-model schema for later read-only integrations.
5. **Barrier-style series excluded deliberately** (e.g. "BTC max this month"): a terminal-price model would systematically misprice path-dependent events, so those series are out of coverage until a barrier model exists.

## Key acquisition order (updated)

1. None needed for Kalshi/Polymarket market data (live now, keyless).
2. `FOOTBALL_DATA_API_KEY` (free) — unlocks live sports fair lines.
3. FRED key (free) — macro model for Kalshi economics markets (CPI/Fed markets are the venue's deepest category; this is the highest-value next model).
4. The Odds API (paid) — sportsbook consensus + no-vig lines.
5. Kalshi API key — only needed for authenticated endpoints (portfolio, higher rate limits); market data works without it.
