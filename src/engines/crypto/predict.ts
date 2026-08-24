/**
 * The crypto prediction pipeline: features → 7-model pool → skill-weighted
 * log-odds ensemble → isotonic calibration → confidence → scenarios →
 * VixeraPrediction.
 *
 * Pure and injectable throughout: the clock, the id factory and the
 * calibrator all arrive as parameters, so the same call replayed with the
 * same inputs yields the same prediction — the precondition for point-in-time
 * backtesting (plan §16).
 */

import type { Clock } from '@/core/clock'
import {
  applyIsotonic,
  isCalibratorUsable,
  type IsotonicCalibrator,
} from '@/core/metrics/calibration'
import { buildPrediction } from '@/core/prediction/builder'
import { computeConfidence } from '@/core/prediction/confidence'
import { combineModels, weightsFromSkill } from '@/core/prediction/ensemble'
import { clampProbability } from '@/core/prediction/probability'
import {
  ALL_CRYPTO_TIMEFRAMES,
  type ModelOutput,
  type PredictionFactor,
  type Scenario,
  type SourceRef,
  type Timeframe,
  type VixeraPrediction,
  type VolatilityForecast,
} from '@/core/prediction/types'
import { computeDataQuality, type DatasetQuality } from '@/core/quality/data-quality'
import type { ModelContext } from '@/engines/model'
import type {
  Candle,
  CandleInterval,
  DerivativesData,
  MarketData,
  OrderBook,
} from '@/providers/types'
import {
  buildCryptoFeatures,
  cryptoFeatureCompleteness,
  TIMEFRAME_SPECS,
  type CryptoFeatures,
} from './features'
import { CRYPTO_MODELS } from './models'

export const CRYPTO_ENSEMBLE_VERSION = 'crypto-ensemble-1.0.0'

/** Capabilities a full-quality crypto prediction expects to have seen. */
export const CRYPTO_EXPECTED_CAPABILITIES: readonly string[] = [
  'crypto.candles',
  'crypto.orderbook',
  'crypto.market',
  'crypto.derivatives',
]

/** Prior weight for a model with no recorded skill history (see ensemble.ts). */
const PRIOR_WEIGHT = 0.25

export interface ModelSkill {
  readonly modelId: string
  readonly brierSkill: number | null
}

// ---------------------------------------------------------------------------
// Normal distribution helpers (erf-based)
// ---------------------------------------------------------------------------

/**
 * Error function via the Abramowitz & Stegun 7.1.26 rational approximation.
 * Absolute error ≤ 1.5e-7, which is far inside the tolerance of anything a
 * probability model here needs (our probabilities are not meaningful past the
 * third decimal).
 */
export function erf(x: number): number {
  if (x === 0) return 0 // exact — the approximation carries ~1e-9 residue at 0
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}

/** Standard normal CDF: Φ(z) = (1 + erf(z/√2)) / 2. */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/**
 * Standard normal quantile Φ⁻¹(p), Acklam's rational approximation
 * (relative error < 1.15e-9). Input is clamped away from 0 and 1 so the
 * result stays finite; a probability that extreme carries no additional
 * information for a scenario drift anyway.
 */
export function normalQuantile(p: number): number {
  const q = clampProbability(p, 1e-12)

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ] as const
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ] as const
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ] as const
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ] as const

  const pLow = 0.02425
  const pHigh = 1 - pLow

  if (q < pLow) {
    const r = Math.sqrt(-2 * Math.log(q))
    return (
      (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) /
      ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1)
    )
  }
  if (q <= pHigh) {
    const r = q - 0.5
    const s = r * r
    return (
      ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) /
      (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1)
    )
  }
  const r = Math.sqrt(-2 * Math.log(1 - q))
  return -(
    (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) /
    ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1)
  )
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Band edges in sigma units: base = within ±0.5σ of spot (in log space). */
const BAND_EDGE_SIGMA = 0.5
/** Outer target-range edge (≈ 90% two-sided band, matching volatility.ts). */
const OUTER_EDGE_SIGMA = 1.645

/**
 * Bull/base/bear scenarios as quantile bands of the forecast return
 * distribution — NOT three hand-written numbers (plan §10).
 *
 * CONSTRUCTION. Model the horizon log return as R ~ N(μ, σ²) where σ is the
 * volatility forecast over the horizon and μ is derived from the ensemble's
 * directional probability: choosing μ = σ·Φ⁻¹(p_up) makes
 *
 *     P(R > 0) = P(Z > −μ/σ) = Φ(μ/σ) = p_up
 *
 * EXACTLY — so the scenario distribution is internally consistent with the
 * directional probability BY DESIGN, not by coincidence. The drift is a small
 * log-odds tilt, not an extrapolation of recent returns: a 60% up-probability
 * with a 4% horizon sigma implies μ ≈ 1% of drift, which is the honest size
 * of what a 60/40 view actually claims.
 *
 * BANDS. bear = R < −0.5σ, base = |R| ≤ 0.5σ, bull = R > 0.5σ. The three
 * probabilities are CDF differences of the same distribution, so they sum to
 * exactly 1 by construction (base is computed as the complement). Target
 * price ranges are spot·exp(band edges) — exponentiated because R is a log
 * return — with the open tails cut at ±1.645σ, the same 90% edge the
 * volatility forecast reports as its range.
 */
export function buildScenarios(params: {
  readonly pUp: number
  /** 1σ of horizon log return, as a fraction (from the volatility forecast). */
  readonly horizonSigma: number
  readonly spot: number
}): Scenario[] | null {
  const { pUp, horizonSigma, spot } = params
  if (!(horizonSigma > 0) || !(spot > 0)) return null

  // The tilt: q = Φ⁻¹(p_up), so μ = σ·q and P(R > 0) = p_up exactly.
  const q = normalQuantile(pUp)

  const pBear = normalCdf(-BAND_EDGE_SIGMA - q)
  const pBull = 1 - normalCdf(BAND_EDGE_SIGMA - q)
  const pBase = Math.max(0, 1 - pBear - pBull) // exact complement → sums to 1

  const edge = (z: number): number => spot * Math.exp(z * horizonSigma)

  return [
    {
      key: 'bull',
      label: 'Bull',
      probability: pBull,
      targetLow: edge(BAND_EDGE_SIGMA),
      targetHigh: edge(OUTER_EDGE_SIGMA),
    },
    {
      key: 'base',
      label: 'Base',
      probability: pBase,
      targetLow: edge(-BAND_EDGE_SIGMA),
      targetHigh: edge(BAND_EDGE_SIGMA),
    },
    {
      key: 'bear',
      label: 'Bear',
      probability: pBear,
      targetLow: edge(-OUTER_EDGE_SIGMA),
      targetHigh: edge(-BAND_EDGE_SIGMA),
    },
  ]
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

export interface PredictCryptoParams {
  readonly symbol: string
  readonly features: CryptoFeatures
  readonly skills: readonly ModelSkill[]
  readonly datasets: readonly DatasetQuality[]
  readonly sources: readonly SourceRef[]
  readonly timeframe: Timeframe
  readonly clock: Clock
  readonly predictionIdFactory: () => string
  readonly calibrator: IsotonicCalibrator | null
}

/** Map the volatility regime to the confidence engine's stability input. */
function regimeStability(features: CryptoFeatures): number {
  switch (features.volRegime) {
    case 'low':
      return 0.9
    case 'normal':
      return 1
    case 'elevated':
      return 0.55
    case 'extreme':
      return 0.2
    case null:
      return 0.6 // unknown regime: neither punished as broken nor credited as stable
  }
}

export function predictCrypto(params: PredictCryptoParams): VixeraPrediction {
  const id = params.predictionIdFactory()
  const ctx: ModelContext = { nowMs: params.clock.now(), runId: id }

  // 1. Run every model; assign combiner weights from historical Brier skill.
  //    Models missing from the skill table get the same prior a null-skill
  //    entry gets, so a newly registered model participates without dominating.
  const skillWeights = weightsFromSkill(params.skills)
  const modelOutputs: ModelOutput[] = CRYPTO_MODELS.map((model) => {
    const out = model.run(params.features, ctx)
    if (out.abstained) return out
    return { ...out, weight: skillWeights[model.id] ?? PRIOR_WEIGHT }
  })

  // 2. Pool in log-odds space.
  const ensemble = combineModels(modelOutputs, ['up', 'down'], { up: 'Up', down: 'Down' })
  const rawUp = ensemble.outcomes.find((o) => o.key === 'up')?.probability ?? 0.5

  // 3. Calibrate when the calibrator has earned trust; otherwise pass the raw
  //    probability through and SAY SO via a note factor.
  const usable = isCalibratorUsable(params.calibrator)
  const pUp = usable ? applyIsotonic(params.calibrator, rawUp) : rawUp

  // 4. Data quality and confidence.
  const dq = computeDataQuality({
    datasets: params.datasets,
    expectedCapabilities: CRYPTO_EXPECTED_CAPABILITIES,
    clock: params.clock,
  })

  const confidenceBreakdown = computeConfidence({
    dataQuality: dq.score,
    modelAgreement: ensemble.modelAgreement,
    sampleSize: params.features.candleCount,
    sampleSizeTarget: 200,
    featureCompleteness: cryptoFeatureCompleteness(params.features),
    effectiveModelCount: ensemble.effectiveModelCount,
    regimeStability: regimeStability(params.features),
  })
  // With zero participating models the outcome is uniform-by-ignorance; cap
  // the confidence explicitly so no combination of good-looking side inputs
  // (fresh data, complete features) can dress up a pool that did not vote.
  const confidence =
    ensemble.participating.length === 0
      ? Math.min(confidenceBreakdown.confidence, 0.05)
      : confidenceBreakdown.confidence

  // 5. Factors: each participating model's REAL computed contributions,
  //    re-signed toward the leading outcome (models compute contributions
  //    toward 'up'; the PredictionFactor contract is signed toward the
  //    leader), plus the uncalibrated note when applicable.
  const leaderSign = pUp >= 0.5 ? 1 : -1
  const factors: PredictionFactor[] = []
  for (const out of ensemble.participating) {
    for (const fc of out.featureContributions) {
      factors.push({
        ...fc,
        id: `${out.modelId}:${fc.id}`,
        contribution: fc.contribution === null ? null : leaderSign * fc.contribution,
      })
    }
  }
  if (!usable) {
    factors.push({
      id: 'uncalibrated',
      label: 'Uncalibrated probability',
      contribution: null,
      detail:
        'No usable calibration curve for this timeframe yet — the raw ensemble probability is shown unadjusted.',
      evidenceStrength: 1,
    })
  }

  // 6. Scenarios and volatility, from the forecast — null when the forecast
  //    honestly does not exist (never defaulted).
  const volatility: VolatilityForecast | null = params.features.volForecast
  const scenarios =
    volatility !== null && params.features.spot !== null
      ? buildScenarios({
          pUp,
          horizonSigma: volatility.expectedMove,
          spot: params.features.spot,
        })
      : null

  return buildPrediction({
    id,
    domain: 'crypto',
    subject: params.symbol,
    subjectLabel: params.symbol,
    timeframe: params.timeframe,
    outcomes: [
      { key: 'up', label: 'Up', probability: pUp },
      { key: 'down', label: 'Down', probability: 1 - pUp },
    ],
    confidence,
    dataQuality: dq.score,
    modelAgreement: ensemble.modelAgreement,
    factors,
    modelOutputs,
    sources: params.sources,
    scenarios,
    volatility,
    modelVersion: CRYPTO_ENSEMBLE_VERSION,
    clock: params.clock,
  })
}

// ---------------------------------------------------------------------------
// All timeframes
// ---------------------------------------------------------------------------

export interface PredictAllTimeframesParams {
  readonly symbol: string
  /** Candle series keyed by interval; a missing interval skips the
   *  timeframes that need it rather than predicting from nothing. */
  readonly candlesByInterval: Partial<Record<CandleInterval, readonly Candle[]>>
  readonly book: OrderBook | null
  readonly derivatives: DerivativesData | null
  readonly market: MarketData | null
  readonly skills: readonly ModelSkill[]
  readonly datasets: readonly DatasetQuality[]
  readonly sources: readonly SourceRef[]
  readonly clock: Clock
  readonly predictionIdFactory: () => string
  /** Per-timeframe calibrators — each timeframe has its own curve (plan §10). */
  readonly calibrators?: Partial<Record<Timeframe, IsotonicCalibrator | null>>
}

/**
 * One prediction per crypto timeframe, each from its own candle interval and
 * horizon (the table in features.ts). Timeframes are never mixed: a 15m and a
 * 7d forecast disagreeing is information, not a bug.
 */
export function predictAllTimeframes(
  params: PredictAllTimeframesParams,
): Partial<Record<Timeframe, VixeraPrediction>> {
  const out: Partial<Record<Timeframe, VixeraPrediction>> = {}

  for (const timeframe of ALL_CRYPTO_TIMEFRAMES) {
    const spec = TIMEFRAME_SPECS[timeframe]
    if (spec === undefined) continue
    const candles = params.candlesByInterval[spec.interval]
    if (candles === undefined) continue

    const features = buildCryptoFeatures({
      candles,
      book: params.book,
      derivatives: params.derivatives,
      market: params.market,
      timeframe,
      nowMs: params.clock.now(),
    })

    out[timeframe] = predictCrypto({
      symbol: params.symbol,
      features,
      skills: params.skills,
      datasets: params.datasets,
      sources: params.sources,
      timeframe,
      clock: params.clock,
      predictionIdFactory: params.predictionIdFactory,
      calibrator: params.calibrators?.[timeframe] ?? null,
    })
  }

  return out
}
