/**
 * Shared machinery for the crypto model pool.
 *
 * Every directional crypto model has the same skeleton: a set of TERMS, each a
 * signed score in log-odds units derived from one feature (or a small feature
 * group), summed and squashed through a sigmoid into P(up). This file holds
 * that skeleton once so the individual model files contain only what makes
 * each model different — its features, its weights and its reasoning.
 *
 * CONTRIBUTIONS ARE COMPUTED, NEVER INVENTED. For a logistic model
 * p = σ(Σ sᵢ), the tilt (p − 0.5) is allocated across terms in proportion to
 * their signed scores: contributionᵢ = sᵢ · (p − 0.5) / S where S = Σ sᵢ.
 * The factor (p − 0.5)/S is always positive (the sigmoid is monotone through
 * 0.5 at 0), so each contribution carries the sign of its own score, and the
 * contributions sum EXACTLY to the emitted tilt. As S → 0 the factor
 * approaches the sigmoid's slope at the origin, 0.25, which is used directly
 * in that limit — the linearisation, not a made-up number.
 */

import { sigmoid } from '@/core/prediction/probability'
import type { ModelOutput, Outcome, PredictionFactor } from '@/core/prediction/types'
import { abstain, emit } from '@/engines/model'

export const UP_DOWN_KEYS: readonly string[] = ['up', 'down']

/** One feature's contribution to a model's log-odds sum. */
export interface LogisticTerm {
  readonly id: string
  readonly label: string
  /** Signed score in log-odds units; null when the feature is unavailable. */
  readonly score: number | null
  readonly detail: string | null
  /** How much the term's own inputs are trusted, 0..1. */
  readonly evidenceStrength: number
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/** Symmetric squash used to bound raw feature values into sane log-odds. */
export function squash(value: number, scale: number): number {
  return Math.tanh(value / scale)
}

/**
 * Run the standard logistic skeleton.
 *
 * Abstains when fewer than `minDefinedTerms` (default 1) terms have data —
 * per the house rule a model without inputs abstains, it does not vote 50%.
 * Confidence = baseConfidence × (fraction of terms with data): a model running
 * on half its evidence should be believed less, mechanically.
 */
export function runLogisticModel(params: {
  readonly modelId: string
  readonly version: string
  readonly terms: readonly LogisticTerm[]
  readonly baseConfidence: number
  readonly minDefinedTerms?: number
  readonly abstainReason?: string
}): ModelOutput {
  const minDefined = params.minDefinedTerms ?? 1
  const defined = params.terms.filter((t) => t.score !== null)

  if (defined.length < minDefined) {
    return abstain(
      params.modelId,
      params.version,
      UP_DOWN_KEYS,
      params.abstainReason ?? 'required features unavailable',
    )
  }

  let sum = 0
  for (const t of defined) sum += t.score ?? 0

  const pUp = sigmoid(sum)

  // See header: exact allocation of the tilt across terms, with the sigmoid's
  // slope at the origin (0.25) as the S → 0 limit.
  const allocationFactor = Math.abs(sum) < 1e-12 ? 0.25 : (pUp - 0.5) / sum

  const factors: PredictionFactor[] = defined.map((t) => ({
    id: t.id,
    label: t.label,
    contribution: allocationFactor * (t.score ?? 0),
    detail: t.detail,
    evidenceStrength: t.evidenceStrength,
  }))

  const outcomes: Outcome[] = [
    { key: 'up', label: 'Up', probability: pUp },
    { key: 'down', label: 'Down', probability: 1 - pUp },
  ]

  return emit({
    modelId: params.modelId,
    version: params.version,
    outcomes,
    confidence: clamp01(params.baseConfidence * (defined.length / params.terms.length)),
    factors,
  })
}
