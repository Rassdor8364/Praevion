/**
 * The universal Vixera prediction object.
 *
 * Every domain — sports, crypto, and later stocks/forex/events — produces this
 * exact shape. That is what lets the Command Center, the alert evaluator, the
 * AI Analyst's tools and the performance dashboard each be written once instead
 * of once per domain.
 */

export type Domain = 'sports' | 'crypto' | 'stocks' | 'forex' | 'events'

export type Timeframe = '15m' | '1h' | '4h' | '24h' | '7d' | '30d' | 'event'

export const ALL_CRYPTO_TIMEFRAMES: readonly Timeframe[] = ['15m', '1h', '4h', '24h', '7d', '30d']

export type RiskLevel = 'low' | 'medium' | 'high' | 'extreme'

export type Direction = 'bullish' | 'bearish' | 'neutral'

/**
 * Whether the underlying data was real.
 *
 * This value ORIGINATES at the provider registry and is propagated upward. It is
 * never inferred, defaulted, or computed from the shape of the data. A
 * prediction is `'live'` only if every contributing provider was a live
 * provider; `'partial'` if some capabilities fell back or were unavailable;
 * `'demo'` if any demo provider contributed. Predictions that are not `'live'`
 * are excluded from all accuracy statistics.
 */
export type DataMode = 'live' | 'partial' | 'demo'

export interface Outcome {
  /** Stable machine key: 'home' | 'draw' | 'away' | 'up' | 'down' | team id, etc. */
  readonly key: string
  /** Human label for display. */
  readonly label: string
  /** 0..1. Across a prediction these sum to 1 (checked by assertValidPrediction). */
  readonly probability: number
}

export interface PredictionFactor {
  readonly id: string
  readonly label: string
  /**
   * Signed contribution in probability points (e.g. +0.12 = +12pp) toward the
   * leading outcome.
   *
   * `null` when the model genuinely cannot attribute a contribution. The UI then
   * shows the factor without a number rather than displaying a fabricated one.
   */
  readonly contribution: number | null
  readonly detail: string | null
  /** How much we trust this factor's own inputs, 0..1. */
  readonly evidenceStrength: number
}

export interface ModelOutput {
  readonly modelId: string
  readonly modelVersion: string
  /** True when the model lacked the inputs to run. Abstention removes the model
   *  from the pool — it is NOT counted as a neutral 50% vote. */
  readonly abstained: boolean
  readonly abstainReason: string | null
  /** Probability distribution over the same outcome keys as the prediction. */
  readonly outcomes: readonly Outcome[]
  /** The model's own confidence in its output, 0..1. */
  readonly confidence: number
  /** Weight applied by the meta-combiner (derived from historical Brier skill). */
  readonly weight: number
  readonly featureContributions: readonly PredictionFactor[]
}

export interface Scenario {
  readonly key: 'bull' | 'base' | 'bear'
  readonly label: string
  readonly probability: number
  readonly targetLow: number
  readonly targetHigh: number
}

export interface VolatilityForecast {
  /** Annualised or horizon-scaled sigma, as a fraction (0.048 = 4.8%). */
  readonly expectedMove: number
  readonly regime: 'low' | 'normal' | 'elevated' | 'extreme'
  /** Symmetric range around spot, as a fraction. */
  readonly rangeLow: number
  readonly rangeHigh: number
  readonly confidence: number
}

export type ReliabilityClass =
  | 'OFFICIAL'
  | 'PRIMARY_SOURCE'
  | 'HIGH_RELIABILITY'
  | 'ESTABLISHED_MEDIA'
  | 'SECONDARY'
  | 'SOCIAL'
  | 'UNVERIFIED'

export interface SourceRef {
  readonly providerId: string
  readonly capability: string
  readonly reliability: ReliabilityClass
  /** ISO timestamp at which this dataset was fetched from the provider. */
  readonly fetchedAt: string
  /** ISO timestamp of the newest datum inside the dataset. */
  readonly dataAsOf: string
  readonly isDemo: boolean
}

export interface VixeraPrediction {
  readonly id: string
  readonly domain: Domain
  /** Canonical subject key, e.g. 'BTCUSDT' or 'game:pl-2026-0142'. */
  readonly subject: string
  readonly subjectLabel: string
  readonly timeframe: Timeframe
  readonly outcomes: readonly Outcome[]
  /** 0..1 */
  readonly confidence: number
  /** 0..100 */
  readonly dataQuality: number
  /** 0..1 — 1 means the model pool is unanimous. */
  readonly modelAgreement: number
  readonly riskLevel: RiskLevel
  readonly supportingFactors: readonly PredictionFactor[]
  readonly opposingFactors: readonly PredictionFactor[]
  readonly modelOutputs: readonly ModelOutput[]
  readonly scenarios: readonly Scenario[] | null
  readonly volatility: VolatilityForecast | null
  readonly sources: readonly SourceRef[]
  readonly dataMode: DataMode
  readonly generatedAt: string
  /**
   * The OLDEST contributing input timestamp — not the newest.
   *
   * A prediction is exactly as fresh as its stalest ingredient. Reporting the
   * newest would let a single live tick disguise an hour-old order book.
   */
  readonly dataTimestamp: string
  readonly modelVersion: string
  readonly disclaimer: string
}

export const PROBABILISTIC_DISCLAIMER =
  'Vixera Intelligence provides probabilistic analytical information and does not guarantee future outcomes.'

/** The leading outcome, or null when there are none. */
export function leadingOutcome(p: Pick<VixeraPrediction, 'outcomes'>): Outcome | null {
  let best: Outcome | null = null
  for (const o of p.outcomes) {
    if (best === null || o.probability > best.probability) best = o
  }
  return best
}

/** Derive a coarse direction for binary up/down style predictions. */
export function directionOf(outcomes: readonly Outcome[], neutralBand = 0.02): Direction {
  const up = outcomes.find((o) => o.key === 'up')
  if (!up) return 'neutral'
  if (up.probability > 0.5 + neutralBand) return 'bullish'
  if (up.probability < 0.5 - neutralBand) return 'bearish'
  return 'neutral'
}
