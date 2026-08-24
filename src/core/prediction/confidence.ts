/**
 * Confidence — deliberately a separate scalar from probability.
 *
 * Probability answers "which outcome?". Confidence answers "how much should you
 * trust that probability?". A 51/49 split computed from complete, fresh,
 * unanimous data is a high-confidence statement of near-uncertainty. A 90/10
 * split computed from one stale source with three abstaining models is a
 * low-confidence statement of apparent certainty. Collapsing the two into one
 * number is the single most common way prediction products mislead.
 *
 * Confidence is a product of bounded penalty terms, so any one bad input caps
 * the result — it cannot be averaged away by other terms looking good.
 */

import { clampProbability } from './probability'

export interface ConfidenceInputs {
  /** 0..100 from the data-quality engine. */
  readonly dataQuality: number
  /** 0..1 from the ensemble. */
  readonly modelAgreement: number
  /** Number of independent observations behind the features. */
  readonly sampleSize: number
  /** Sample size at which the sample-size penalty is essentially removed. */
  readonly sampleSizeTarget: number
  /** Fraction of expected features actually present, 0..1. */
  readonly featureCompleteness: number
  /** Effective number of participating models (inverse Simpson). */
  readonly effectiveModelCount: number
  /** 0..1, where 1 means the current volatility/behaviour regime is stable. */
  readonly regimeStability: number
}

export interface ConfidenceBreakdown {
  readonly confidence: number
  readonly terms: Readonly<Record<string, number>>
  /** The single term that most constrained the result. */
  readonly limitingFactor: string
}

const BASE_CONFIDENCE = 0.95

/**
 * Each term returns a multiplier in (0, 1]. None may return 1 unless the input
 * is genuinely ideal, and none may return 0 — a zero would erase the
 * information that other terms were fine.
 */
export function computeConfidence(inputs: ConfidenceInputs): ConfidenceBreakdown {
  const terms: Record<string, number> = {
    // Quality below 60/100 degrades fast; above 90 it barely matters.
    dataQuality: 0.35 + 0.65 * smoothstep(inputs.dataQuality / 100, 0.4, 0.95),

    // Disagreement is punished hard: it is direct evidence that the signal is
    // ambiguous, not merely that our measurement is noisy.
    modelAgreement: 0.30 + 0.70 * clampProbability(inputs.modelAgreement, 0),

    // Saturating in sample size — the classic 1/(1+n/k) shape.
    sampleSize: saturating(inputs.sampleSize, Math.max(1, inputs.sampleSizeTarget)),

    // Missing features are worse than they look: they usually correlate with
    // exactly the situations that are hard to predict.
    featureCompleteness: 0.40 + 0.60 * Math.pow(clampProbability(inputs.featureCompleteness, 0), 1.5),

    // Diversity bonus, saturating around five genuinely independent models.
    modelDiversity: 0.65 + 0.35 * saturating(inputs.effectiveModelCount, 5),

    // A broken regime means history is a poor guide right now.
    regimeStability: 0.55 + 0.45 * clampProbability(inputs.regimeStability, 0),
  }

  let confidence = BASE_CONFIDENCE
  let limitingFactor = 'none'
  let lowest = Infinity
  for (const [name, value] of Object.entries(terms)) {
    confidence *= value
    if (value < lowest) {
      lowest = value
      limitingFactor = name
    }
  }

  return {
    confidence: clampProbability(confidence, 0.01),
    terms,
    limitingFactor,
  }
}

/** Smooth 0→1 ramp between edges; flat outside. */
function smoothstep(x: number, edge0: number, edge1: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** n/(n+k) — approaches 1 as n grows, equals 0.5 at n = k. */
function saturating(n: number, k: number): number {
  const safe = Math.max(0, n)
  return safe / (safe + k)
}

/**
 * Map a confidence scalar to a label. Thresholds are intentionally
 * conservative: 'high' requires 0.75, not 0.6.
 */
export function confidenceLabel(confidence: number): 'very low' | 'low' | 'medium' | 'high' | 'very high' {
  if (confidence < 0.30) return 'very low'
  if (confidence < 0.50) return 'low'
  if (confidence < 0.75) return 'medium'
  if (confidence < 0.88) return 'high'
  return 'very high'
}
