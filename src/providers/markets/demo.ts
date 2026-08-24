/**
 * ============================================================================
 * DEMO PREDICTION-MARKET PROVIDER — SYNTHETIC MARKETS. NOT REAL VENUES.
 * ============================================================================
 *
 * Ten plausible-but-fictional markets across every MarketCategory, so the
 * scanner, liquidity grader and opportunity builder can be exercised end to
 * end without touching Kalshi or Polymarket.
 *
 * The questions are invented on purpose (fictional institutions, a fictional
 * index, the demo football league's clubs). Real questions with fabricated
 * prices would produce screenshots that look like genuine market beliefs
 * about genuine events — exactly the confusion this project must never create.
 *
 * Every payload is stamped `isDemo: true`, which propagates to
 * `dataMode: 'demo'` on anything built from it and EXCLUDES it from all
 * accuracy statistics. The registry only registers this provider when
 * VIXERA_ALLOW_DEMO is set — see demoAllowed() in registry.ts.
 *
 * Generation is DETERMINISTIC (seeded mulberry32, never Math.random): the same
 * prices, books and tapes on every machine and every run, so demo output works
 * in snapshot tests and is reproducible in bug reports. Close times are
 * anchored to the week boundary, not to `now`, so they hold still for seven
 * days at a time instead of sliding on every read.
 * ============================================================================
 */

import { ProviderError } from '@/core/errors'
import { err, ok } from '@/core/result'
import type {
  MarketCategory,
  MarketOrderBook,
  MarketOrderBookLevel,
  MarketTrade,
  PredictionMarket,
} from '@/core/markets/types'
import type { Capability, ProviderHealth, ProviderResult, Sourced } from '../types'
import type { PredictionMarketProvider } from './types'

const PROVIDER_ID = 'demo-markets'
const WEEK_MS = 7 * 86_400_000

interface DemoSpec {
  readonly externalId: string
  readonly title: string
  readonly category: MarketCategory
  /** Anchor YES probability; jittered deterministically per week. */
  readonly baseProb: number
  /** Scales volume/liquidity so the set spans liquid → thin. */
  readonly volumeScale: number
  /** Weeks from the week anchor until close. */
  readonly weeksToClose: number
  readonly rules: string
}

/**
 * Spread across all nine categories and across liquidity tiers, with
 * probabilities from near-certain to toss-up so downstream scoring has real
 * variance to chew on rather than ten copies of 50/50.
 */
const SPECS: readonly DemoSpec[] = [
  { externalId: 'DEMO-ELECT-UNITY', title: 'Aurelia general election: Unity Party wins a majority?', category: 'politics', baseProb: 0.62, volumeScale: 1.0, weeksToClose: 8, rules: 'Resolves YES if the Unity Party holds more than half the seats in the Aurelian Assembly after the general election.' },
  { externalId: 'DEMO-ELECT-TURNOUT', title: 'Aurelia general election turnout above 70%?', category: 'politics', baseProb: 0.34, volumeScale: 0.3, weeksToClose: 8, rules: 'Resolves YES if the Aurelian Electoral Commission certifies turnout above 70%.' },
  { externalId: 'DEMO-CB-CUT', title: 'Central Bank of Aurelia cuts rates at the next meeting?', category: 'economics', baseProb: 0.71, volumeScale: 0.9, weeksToClose: 3, rules: 'Resolves YES if the policy rate is lower after the next scheduled meeting than before it.' },
  { externalId: 'DEMO-CPI-3PCT', title: 'Aurelian CPI prints below 3% this quarter?', category: 'economics', baseProb: 0.45, volumeScale: 0.5, weeksToClose: 5, rules: 'Resolves YES if the official quarterly CPI release shows year-on-year inflation below 3%.' },
  { externalId: 'DEMO-VIX-COIN', title: 'VixCoin trades above 1,000 credits by quarter end?', category: 'crypto', baseProb: 0.28, volumeScale: 0.7, weeksToClose: 6, rules: 'Resolves YES if the reference VixCoin index closes above 1,000 credits on any day before quarter end.' },
  { externalId: 'DEMO-VL-TITLE', title: 'Northgate United win the Vixera Demo League?', category: 'sports', baseProb: 0.55, volumeScale: 0.8, weeksToClose: 4, rules: 'Resolves YES if Northgate United finish top of the Vixera Demo League table.' },
  { externalId: 'DEMO-VL-RELEG', title: 'Elmswood Town relegated from the Vixera Demo League?', category: 'sports', baseProb: 0.66, volumeScale: 0.2, weeksToClose: 4, rules: 'Resolves YES if Elmswood Town finish bottom of the Vixera Demo League table.' },
  { externalId: 'DEMO-WX-RAIN', title: 'Measurable rain in Demoland City on closing day?', category: 'weather', baseProb: 0.4, volumeScale: 0.15, weeksToClose: 1, rules: 'Resolves YES if the Demoland Met Office records at least 0.2mm of rain at the City station on the closing date.' },
  { externalId: 'DEMO-ENT-AWARD', title: '"Signals" wins Best Picture at the Aurelian Film Awards?', category: 'entertainment', baseProb: 0.22, volumeScale: 0.4, weeksToClose: 10, rules: 'Resolves YES if "Signals" is announced as Best Picture at the Aurelian Film Awards ceremony.' },
  { externalId: 'DEMO-SCI-LAUNCH', title: 'Aurelia Space Agency orbital launch succeeds this quarter?', category: 'science', baseProb: 0.83, volumeScale: 0.35, weeksToClose: 7, rules: 'Resolves YES if the ASA-4 mission reaches its target orbit before quarter end.' },
] as const

export class DemoPredictionMarketProvider implements PredictionMarketProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'Demo Markets (synthetic)'
  readonly reliability = 'UNVERIFIED' as const
  readonly isDemo = true
  readonly capabilities: readonly Capability[] = [
    'markets.list',
    'markets.detail',
    'markets.orderbook',
    'markets.trades',
  ]

  isConfigured(): boolean {
    return true // nothing to configure; generation is local
  }

  async health(): Promise<ProviderHealth> {
    return { healthy: true, latencyMs: 0, message: 'synthetic provider' }
  }

  async getMarkets(params: {
    category?: MarketCategory
    limit: number
    cursor?: string
  }): Promise<ProviderResult<{ markets: PredictionMarket[]; nextCursor: string | null }>> {
    const now = Date.now()
    const all = SPECS.map((s) => buildMarket(s, now)).filter(
      (m) => params.category === undefined || m.category === params.category,
    )
    // Ten markets never need a second page; a null cursor keeps pagination
    // loops honest instead of spinning on synthetic data.
    return ok(sourced({ markets: all.slice(0, Math.max(1, params.limit)), nextCursor: null }, now))
  }

  async getMarket(externalId: string): Promise<ProviderResult<PredictionMarket>> {
    const spec = SPECS.find((s) => s.externalId === externalId)
    if (!spec) return err(unknownMarket(externalId))
    const now = Date.now()
    return ok(sourced(buildMarket(spec, now), now))
  }

  async getOrderBook(
    externalId: string,
    outcomeId: string,
  ): Promise<ProviderResult<MarketOrderBook>> {
    const spec = SPECS.find((s) => s.externalId === externalId)
    if (!spec) return err(unknownMarket(externalId))
    if (outcomeId !== 'yes' && outcomeId !== 'no') return err(unknownMarket(outcomeId))

    const now = Date.now()
    const pYes = weeklyProb(spec, now)
    // Books are quoted around the outcome's own probability so YES and NO
    // books are mirror-consistent, exactly as a real venue's would be.
    const p = outcomeId === 'yes' ? pYes : 1 - pYes
    const rand = mulberry32(hash32(`${spec.externalId}|${outcomeId}|book|${weekAnchor(now)}`))

    const bids: MarketOrderBookLevel[] = []
    const asks: MarketOrderBookLevel[] = []
    for (let i = 0; i < 6; i++) {
      const step = 0.01 * (i + 1)
      const depth = Math.round((40 + rand() * 400) * (0.5 + spec.volumeScale)) // thins with scale
      bids.push({ price: round2(clamp01(p - step)), size: depth })
      asks.push({ price: round2(clamp01(p + step)), size: Math.round(depth * (0.8 + rand() * 0.4)) })
    }

    return ok(
      sourced<MarketOrderBook>(
        { marketId: `${PROVIDER_ID}:${externalId}`, outcomeId, bids, asks, timestamp: now },
        now,
      ),
    )
  }

  async getTrades(externalId: string, limit: number): Promise<ProviderResult<MarketTrade[]>> {
    const spec = SPECS.find((s) => s.externalId === externalId)
    if (!spec) return err(unknownMarket(externalId))

    const now = Date.now()
    const p = weeklyProb(spec, now)
    const n = Math.max(1, Math.min(limit, 50))
    const trades: MarketTrade[] = []
    for (let i = 0; i < n; i++) {
      // Each trade seeds its own stream so trimming `limit` never reshuffles
      // the tape — trade k is identical whether you ask for 5 or 50.
      const rand = mulberry32(hash32(`${spec.externalId}|trade|${i}|${weekAnchor(now)}`))
      trades.push({
        marketId: `${PROVIDER_ID}:${externalId}`,
        outcomeId: 'yes',
        price: round2(clamp01(p + (rand() - 0.5) * 0.04)),
        size: Math.round(5 + rand() * 200 * (0.5 + spec.volumeScale)),
        side: rand() < 0.5 ? 'buy' : 'sell',
        // Newest first, five minutes apart — a plausible tape cadence.
        timestamp: now - i * 5 * 60_000,
      })
    }
    return ok(sourced(trades, now))
  }
}

// ---------------------------------------------------------------------------
// Deterministic generation
// ---------------------------------------------------------------------------

/** Week boundary anchor — prices hold still for a week, like the demo league. */
function weekAnchor(now: number): number {
  return Math.floor(now / WEEK_MS) * WEEK_MS
}

/** Base probability plus a small per-week deterministic wobble (±0.04). */
function weeklyProb(spec: DemoSpec, now: number): number {
  const rand = mulberry32(hash32(`${spec.externalId}|prob|${weekAnchor(now)}`))
  return clamp01(spec.baseProb + (rand() - 0.5) * 0.08)
}

function buildMarket(spec: DemoSpec, now: number): PredictionMarket {
  const anchor = weekAnchor(now)
  const p = weeklyProb(spec, now)
  const rand = mulberry32(hash32(`${spec.externalId}|market|${anchor}`))

  // Thin markets get wide spreads — 1¢ on the liquid ones, up to ~5¢ on the
  // illiquid tail — so the liquidity grader sees the full range.
  const halfSpread = round2(0.005 + (1 - spec.volumeScale) * 0.02 + rand() * 0.005)
  const bid = round2(clamp01(p - halfSpread))
  const ask = round2(clamp01(p + halfSpread))
  const volume = Math.round(spec.volumeScale * (50_000 + rand() * 150_000))

  return {
    id: `${PROVIDER_ID}:${spec.externalId}`,
    provider: PROVIDER_ID,
    externalId: spec.externalId,
    ticker: spec.externalId,
    title: spec.title,
    description: null,
    category: spec.category,
    outcomes: [
      { id: 'yes', name: 'Yes', marketProbability: round2(p), bid, ask },
      { id: 'no', name: 'No', marketProbability: round2(1 - p), bid: round2(1 - ask), ask: round2(1 - bid) },
    ],
    volume,
    volume24h: Math.round(volume * (0.02 + rand() * 0.1)),
    liquidity: Math.round(volume * 0.2),
    openInterest: Math.round(volume * 0.4),
    spread: round2(ask - bid),
    closeTime: new Date(anchor + spec.weeksToClose * WEEK_MS).toISOString(),
    resolutionTime: new Date(anchor + spec.weeksToClose * WEEK_MS + 86_400_000).toISOString(),
    resolutionRules: spec.rules,
    status: 'open',
    // No URL: a link that 404s is worse than no link, and there is nothing
    // real to link to.
    url: null,
    updatedAt: new Date(anchor).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// PRNG — identical utilities to the other demo providers
// ---------------------------------------------------------------------------

/**
 * mulberry32 — 32-bit PRNG, reproducible from an integer seed. Math.random()
 * would give every reload different prices, making the demo useless for
 * snapshot tests and impossible to describe in a bug report.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a string→u32, so each market seeds its own independent stream. */
function hash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function clamp01(n: number): number {
  return Math.min(0.99, Math.max(0.01, n))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function sourced<T>(data: T, dataAsOf: number): Sourced<T> {
  return {
    data,
    // isDemo: true is the entire contract of this file.
    provenance: { sourceId: PROVIDER_ID, fetchedAt: Date.now(), dataAsOf, isDemo: true },
  }
}

function unknownMarket(id: string): ProviderError {
  return new ProviderError({
    kind: 'not_found',
    providerId: PROVIDER_ID,
    message: `Unknown demo market or outcome "${id}"`,
  })
}
