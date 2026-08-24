/**
 * Risk level.
 *
 * Risk is not the inverse of confidence. Confidence is about the quality of our
 * estimate; risk is about the dispersion of real-world outcomes. A high-
 * confidence forecast of a highly volatile asset is confident AND risky, and the
 * product must be able to say both things at once.
 */

import type { Outcome, RiskLevel } from './types'

export interface RiskInputs {
  readonly outcomes: readonly Outcome[]
  readonly confidence: number
  /** Expected move as a fraction of price, when applicable. */
  readonly expectedVolatility: number | null
  /** 0..1 — how contested the outcome is by external signals (news, injuries). */
  readonly externalUncertainty: number
}

export function computeRiskLevel(inputs: RiskInputs): RiskLevel {
  // Normalised entropy of the outcome distribution: 0 = certain, 1 = uniform.
  const entropy = normalizedEntropy(inputs.outcomes)

  let score = 0
  score += entropy * 0.35
  score += (1 - inputs.confidence) * 0.30
  score += Math.min(1, inputs.externalUncertainty) * 0.15

  if (inputs.expectedVolatility !== null) {
    // 8% expected move over the horizon is treated as fully saturated risk.
    score += Math.min(1, inputs.expectedVolatility / 0.08) * 0.20
  } else {
    // No volatility estimate: redistribute that weight to entropy rather than
    // silently treating the missing input as zero risk.
    score += entropy * 0.20
  }

  if (score < 0.30) return 'low'
  if (score < 0.52) return 'medium'
  if (score < 0.74) return 'high'
  return 'extreme'
}

export function normalizedEntropy(outcomes: readonly Outcome[]): number {
  if (outcomes.length < 2) return 0
  let h = 0
  for (const o of outcomes) {
    if (o.probability > 0) h -= o.probability * Math.log(o.probability)
  }
  return h / Math.log(outcomes.length)
}
