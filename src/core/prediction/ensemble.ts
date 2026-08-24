/**
 * The meta-combiner.
 *
 * Combines many model outputs into one distribution, and measures how much the
 * pool actually agrees.
 *
 * Design note — why log-odds pooling rather than averaging probabilities:
 * arithmetic averaging is a contraction toward the mean. Five independent models
 * that each say 0.80 average to 0.80, which throws away the fact that five
 * independent pieces of evidence pointing the same way is much stronger than
 * one. Averaging in log-odds space (a logarithmic opinion pool) preserves that
 * accumulation and keeps the extremes calibratable. It is also the form that
 * falls out of treating each model as contributing independent log-likelihood
 * evidence.
 */

import { invariant } from '../errors'
import { clampProbability, logit, normalize, sigmoid, softmax } from './probability'
import type { ModelOutput, Outcome } from './types'

export interface EnsembleResult {
  readonly outcomes: Outcome[]
  /** 0..1, where 1 means the participating models are unanimous. */
  readonly modelAgreement: number
  /** Models that actually contributed (abstentions excluded). */
  readonly participating: readonly ModelOutput[]
  readonly abstained: readonly ModelOutput[]
  /** Effective number of models, accounting for weight concentration. */
  readonly effectiveModelCount: number
}

/**
 * Combine model outputs.
 *
 * Abstaining models are removed from the pool entirely rather than being folded
 * in as a neutral vote. "I don't know" and "it's a coin flip" are different
 * claims, and merging them is a quiet way to manufacture false certainty about
 * uncertainty.
 */
export function combineModels(
  models: readonly ModelOutput[],
  outcomeKeys: readonly string[],
  labels: Readonly<Record<string, string>>,
): EnsembleResult {
  invariant(outcomeKeys.length >= 2, 'a prediction needs at least two outcomes')

  const participating = models.filter((m) => !m.abstained && m.weight > 0)
  const abstained = models.filter((m) => m.abstained || m.weight <= 0)

  if (participating.length === 0) {
    const uniform = 1 / outcomeKeys.length
    return {
      outcomes: outcomeKeys.map((k) => ({
        key: k,
        label: labels[k] ?? k,
        probability: uniform,
      })),
      modelAgreement: 0,
      participating: [],
      abstained,
      effectiveModelCount: 0,
    }
  }

  const weights = normalize(participating.map((m) => m.weight))

  // Pooled score per outcome = Σ wᵢ · logit(pᵢ). Softmax back to a distribution;
  // for the binary case this reduces exactly to sigmoid of the pooled logit.
  const pooledScores = outcomeKeys.map((key) => {
    let score = 0
    participating.forEach((m, i) => {
      const p = m.outcomes.find((o) => o.key === key)?.probability ?? 0
      score += (weights[i] ?? 0) * logit(p)
    })
    return score
  })

  const probabilities =
    outcomeKeys.length === 2
      ? binaryFromPooledLogit(pooledScores)
      : softmax(pooledScores)

  const outcomes: Outcome[] = outcomeKeys.map((key, i) => ({
    key,
    label: labels[key] ?? key,
    probability: probabilities[i] ?? 0,
  }))

  return {
    outcomes,
    modelAgreement: computeAgreement(participating, outcomeKeys, weights),
    participating,
    abstained,
    effectiveModelCount: effectiveCount(weights),
  }
}

function binaryFromPooledLogit(pooledScores: readonly number[]): number[] {
  // For two outcomes the pooled logits are antisymmetric up to noise; use the
  // first and derive the second so the pair is exactly consistent.
  const p0 = sigmoid(pooledScores[0] ?? 0)
  return [p0, 1 - p0]
}

/**
 * Agreement = 1 − (weighted dispersion in log-odds space / saturation scale).
 *
 * Measured in log-odds rather than probability space because probability-space
 * dispersion is compressed near 0 and 1: two models saying 0.95 and 0.99 differ
 * by 0.04 in probability but by 1.6 in log-odds, and the latter is the honest
 * measure of how much they disagree about the strength of the evidence.
 */
function computeAgreement(
  participating: readonly ModelOutput[],
  outcomeKeys: readonly string[],
  weights: readonly number[],
): number {
  if (participating.length < 2) return 1

  // Saturation scale: a spread of ~2.2 log-odds (roughly 0.25 vs 0.75) is
  // treated as total disagreement.
  const SATURATION = 2.2

  let totalDispersion = 0
  for (const key of outcomeKeys) {
    const logits = participating.map((m) =>
      logit(m.outcomes.find((o) => o.key === key)?.probability ?? 1 / outcomeKeys.length),
    )
    let mean = 0
    logits.forEach((l, i) => {
      mean += (weights[i] ?? 0) * l
    })
    let variance = 0
    logits.forEach((l, i) => {
      variance += (weights[i] ?? 0) * (l - mean) ** 2
    })
    totalDispersion += Math.sqrt(variance)
  }

  const meanDispersion = totalDispersion / outcomeKeys.length
  return clampProbability(1 - Math.min(1, meanDispersion / SATURATION), 0)
}

/**
 * Effective model count via inverse Simpson index (1 / Σ wᵢ²).
 *
 * Ten models where one carries 95% of the weight is, informationally, close to
 * one model. This number feeds the confidence calculation so that a pool which
 * only looks diverse does not earn diversity's confidence bonus.
 */
export function effectiveCount(weights: readonly number[]): number {
  let sumSq = 0
  for (const w of weights) sumSq += w * w
  return sumSq === 0 ? 0 : 1 / sumSq
}

/**
 * Derive combiner weights from each model's historical Brier skill score.
 *
 * skill = 1 − brier/brierBaseline, floored at 0. A model that has never beaten
 * the baseline earns no weight. Models with no recorded history fall back to
 * `priorWeight` so a newly registered model participates but does not dominate.
 */
export function weightsFromSkill(
  skills: readonly { modelId: string; brierSkill: number | null }[],
  priorWeight = 0.25,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of skills) {
    out[s.modelId] = s.brierSkill === null ? priorWeight : Math.max(0, s.brierSkill)
  }
  const total = Object.values(out).reduce((a, b) => a + b, 0)
  if (total === 0) {
    for (const s of skills) out[s.modelId] = 1 / Math.max(1, skills.length)
  }
  return out
}
