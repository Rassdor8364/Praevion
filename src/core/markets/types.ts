/**
 * Universal prediction-market objects.
 *
 * Kalshi, Polymarket, sportsbook markets and any future venue all normalise
 * into these shapes. Nothing above the provider layer knows which venue a
 * market came from except through the `provider` field, and every screen,
 * scanner and scoring engine is written once against this contract.
 */

import type { ReliabilityClass } from '@/core/prediction/types'

export type MarketStatus = 'open' | 'closed' | 'settled' | 'suspended' | 'unknown'

export type MarketCategory =
  | 'politics'
  | 'economics'
  | 'crypto'
  | 'sports'
  | 'weather'
  | 'entertainment'
  | 'science'
  | 'companies'
  | 'other'

export interface MarketOutcome {
  /** Stable outcome id within the market (Kalshi: 'yes'/'no'; Polymarket: token id). */
  readonly id: string
  readonly name: string
  /**
   * The market's implied probability for this outcome, 0..1, derived from the
   * venue's last/mid price. This is what the market BELIEVES — never to be
   * confused with what Vixera estimates.
   */
  readonly marketProbability: number
  /** Best bid/ask expressed as probabilities (0..1), when the venue reports them. */
  readonly bid: number | null
  readonly ask: number | null
}

export interface PredictionMarket {
  /** Canonical Vixera id: `${provider}:${externalId}`. */
  readonly id: string
  readonly provider: string
  readonly externalId: string
  /** Venue ticker where one exists (Kalshi ticker, Polymarket slug). */
  readonly ticker: string | null
  readonly title: string
  readonly description: string | null
  readonly category: MarketCategory
  readonly outcomes: readonly MarketOutcome[]
  /** Lifetime traded volume in venue units (USD notional where available). */
  readonly volume: number
  readonly volume24h: number | null
  readonly liquidity: number | null
  readonly openInterest: number | null
  /** Bid/ask spread of the primary outcome, in probability points (0..1). */
  readonly spread: number | null
  /** ISO time trading closes. */
  readonly closeTime: string | null
  /** ISO time the event resolves (may differ from close). */
  readonly resolutionTime: string | null
  readonly resolutionRules: string | null
  readonly status: MarketStatus
  readonly url: string | null
  readonly updatedAt: string
  /**
   * Structured underlying data for markets whose event is a numeric threshold
   * on a tradable asset (venue-reported, never parsed from prose).
   *
   * Semantics: floor only = an "above" market (event true when the underlying
   * finishes ABOVE floorStrike); cap only = a "below" market (event true when
   * the underlying finishes BELOW capStrike); both = a range market, whose
   * probability is P(above floor) − P(above cap). Absent/null when the venue
   * reports no structured strikes (e.g. Polymarket, where only the title
   * carries the threshold).
   */
  readonly derived?: {
    readonly underlyingSymbol: string | null // 'BTC', 'ETH', ...
    readonly floorStrike: number | null // event true when underlying > floor
    readonly capStrike: number | null // event true when underlying < cap
  } | null
}

export interface MarketOrderBookLevel {
  /** Price expressed as probability, 0..1. */
  readonly price: number
  /** Size in venue units (contracts / shares). */
  readonly size: number
}

export interface MarketOrderBook {
  readonly marketId: string
  readonly outcomeId: string
  readonly bids: readonly MarketOrderBookLevel[]
  readonly asks: readonly MarketOrderBookLevel[]
  readonly timestamp: number
}

export interface MarketTrade {
  readonly marketId: string
  readonly outcomeId: string
  readonly price: number
  readonly size: number
  readonly side: 'buy' | 'sell' | 'unknown'
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Opportunity
// ---------------------------------------------------------------------------

export type LiquidityGrade = 'excellent' | 'good' | 'fair' | 'poor' | 'illiquid'

export interface LiquidityAssessment {
  /** 0..100 */
  readonly score: number
  readonly grade: LiquidityGrade
  readonly spreadPp: number | null
  readonly depthScore: number | null
  readonly volumeScore: number
  readonly notes: readonly string[]
}

export type ResolutionRiskLevel = 'low' | 'medium' | 'high'

export interface ResolutionRisk {
  readonly level: ResolutionRiskLevel
  readonly reasons: readonly string[]
}

/**
 * The product's primary output: a scored divergence between what a market
 * believes and what Vixera estimates.
 *
 * Three numbers here are related but deliberately distinct, and the UI never
 * merges them:
 *  - `edgePp`    — probability edge in percentage points (belief divergence)
 *  - `expectedValue` — expected return per unit staked at the quoted price
 *  - `confidence` — how much to trust Vixera's own estimate
 */
export interface VixeraOpportunity {
  readonly id: string
  readonly market: PredictionMarket
  /** The outcome the edge refers to. */
  readonly outcomeId: string
  readonly outcomeName: string
  readonly vixeraProbability: number
  readonly marketProbability: number
  /** vixera − market, in probability points (−1..1). */
  readonly edgePp: number
  /**
   * Expected value per unit staked at the executable price (the ask, not the
   * mid — you cannot trade the mid), net of nothing else. Null when there is no
   * executable quote.
   */
  readonly expectedValue: number | null
  readonly confidence: number
  readonly dataQuality: number
  readonly modelAgreement: number
  readonly liquidity: LiquidityAssessment
  readonly resolutionRisk: ResolutionRisk
  /** 0..1 — how heavily news flow is currently moving this market's inputs. */
  readonly newsRisk: number
  /** Hours until scheduled resolution; null when the venue does not say. */
  readonly hoursToResolution: number | null
  /** 0..100 — the ranked headline number. */
  readonly opportunityScore: number
  /**
   * Explicit no-action flag. Vixera must be allowed to say "nothing here":
   * a market can be fairly priced, too thin, or too uncertain to be worth
   * attention, and pretending otherwise is how analytics products decay into
   * tip sheets.
   */
  readonly action: 'opportunity' | 'no_action'
  readonly noActionReasons: readonly string[]
  readonly scoreBreakdown: Readonly<Record<string, number>>
  readonly predictionId: string | null
  readonly generatedAt: string
  readonly dataMode: 'live' | 'partial' | 'demo'
}

// ---------------------------------------------------------------------------
// Cross-market comparison
// ---------------------------------------------------------------------------

export interface LinkedMarketQuote {
  readonly provider: string
  readonly marketId: string
  readonly title: string
  readonly outcomeName: string
  readonly marketProbability: number
  readonly liquidity: number | null
}

/**
 * The same real-world event traded on multiple venues. Disagreement between
 * venues is itself a signal (market dislocation), and the largest Vixera edge
 * across venues tells you WHERE the mispricing lives.
 */
export interface MarketDislocation {
  readonly eventKey: string
  readonly eventTitle: string
  readonly quotes: readonly LinkedMarketQuote[]
  /** Max pairwise venue disagreement, in probability points. */
  readonly crossMarketSpreadPp: number
  readonly vixeraProbability: number | null
  readonly largestEdge: { provider: string; edgePp: number } | null
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface PredictionMarketProviderInfo {
  readonly id: string
  readonly displayName: string
  readonly reliability: ReliabilityClass
  readonly isDemo: boolean
}

export type OpportunitySort =
  | 'score'
  | 'edge'
  | 'confidence'
  | 'liquidity'
  | 'risk'
  | 'ending_soon'
  | 'newest'
  | 'probability_change'
