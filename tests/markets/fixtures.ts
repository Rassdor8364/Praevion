import type {
  MarketOrderBook,
  MarketOutcome,
  PredictionMarket,
} from '@/core/markets/types'
import type { evaluateOpportunity } from '@/engines/markets/opportunity'

/** Fixed evaluation instant: 2026-08-12T00:00:00Z. */
export const NOW_MS = Date.parse('2026-08-12T00:00:00Z')

export const DAY_MS = 86_400_000

/** Clean resolution rules: named source (URL + proper noun), no red flags. */
export const CLEAN_RULES =
  'Resolves YES if the Bureau of Labor Statistics reports CPI above 3.0 percent, per https://www.bls.gov/cpi/.'

/** Rules tripping enough heuristics to grade high. */
export const NASTY_RULES =
  'The outcome may be determined in the sole discretion of the committee if it is widely reported as a significant event.'

export function makeOutcome(overrides: Partial<MarketOutcome> = {}): MarketOutcome {
  return {
    id: 'yes',
    name: 'Yes',
    marketProbability: 0.5,
    bid: 0.49,
    ask: 0.51,
    ...overrides,
  }
}

export function makeBook(overrides: Partial<MarketOrderBook> = {}): MarketOrderBook {
  return {
    marketId: 'kalshi:TEST',
    outcomeId: 'yes',
    bids: [
      { price: 0.49, size: 2000 },
      { price: 0.45, size: 3000 },
    ],
    asks: [
      { price: 0.51, size: 2000 },
      { price: 0.55, size: 3000 },
    ],
    timestamp: NOW_MS,
    ...overrides,
  }
}

export function makeMarket(overrides: Partial<PredictionMarket> = {}): PredictionMarket {
  return {
    id: 'kalshi:TEST',
    provider: 'kalshi',
    externalId: 'TEST',
    ticker: 'TEST',
    title: 'Test market?',
    description: null,
    category: 'economics',
    outcomes: [makeOutcome()],
    volume: 500_000,
    volume24h: 50_000,
    liquidity: 100_000,
    openInterest: null,
    spread: 0.02,
    closeTime: new Date(NOW_MS + 30 * DAY_MS).toISOString(),
    resolutionTime: new Date(NOW_MS + 30 * DAY_MS + 3_600_000).toISOString(),
    resolutionRules: CLEAN_RULES,
    status: 'open',
    url: null,
    updatedAt: new Date(NOW_MS).toISOString(),
    ...overrides,
  }
}

type EvaluateParams = Parameters<typeof evaluateOpportunity>[0]

/**
 * A "golden" parameter set that evaluates to a genuine opportunity: 15pp edge,
 * strong confidence, excellent liquidity (book included), clean rules, live
 * data. Individual tests perturb exactly one dimension from here.
 */
export function makeParams(overrides: Partial<EvaluateParams> = {}): EvaluateParams {
  return {
    market: makeMarket(),
    outcomeId: 'yes',
    vixeraProbability: 0.65,
    confidence: 0.8,
    dataQuality: 85,
    modelAgreement: 0.85,
    newsRisk: 0.1,
    historicalCategoryAccuracy: { brierSkill: 0.15, sampleSize: 80 },
    book: makeBook(),
    nowMs: NOW_MS,
    predictionId: 'pred-1',
    dataMode: 'live',
    ...overrides,
  }
}
