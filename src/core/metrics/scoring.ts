/**
 * Proper scoring rules.
 *
 * These are what make the model performance dashboard meaningful rather than
 * decorative. Accuracy alone is nearly useless for a probabilistic system — a
 * model that says 55% and is right 55% of the time is excellent and will look
 * mediocre on an accuracy chart. Brier score and log loss reward being both
 * right AND honestly calibrated, and they are the metrics the ensemble weights
 * itself from.
 */

import { clampProbability } from '../prediction/probability'

export interface ScoredPrediction {
  /** Probability assigned to each outcome key. */
  readonly probabilities: Readonly<Record<string, number>>
  /** The outcome key that actually occurred. */
  readonly actual: string
}

/**
 * Multi-class Brier score: mean squared error over the full probability vector.
 * Range 0 (perfect) to 2 (maximally wrong). Lower is better.
 */
export function brierScore(predictions: readonly ScoredPrediction[]): number {
  if (predictions.length === 0) return Number.NaN
  let total = 0
  for (const p of predictions) {
    for (const [key, prob] of Object.entries(p.probabilities)) {
      const actual = key === p.actual ? 1 : 0
      total += (prob - actual) ** 2
    }
  }
  return total / predictions.length
}

/** Binary Brier score — the familiar (p − y)² form. */
export function binaryBrierScore(
  predictions: readonly { probability: number; occurred: boolean }[],
): number {
  if (predictions.length === 0) return Number.NaN
  let total = 0
  for (const p of predictions) total += (p.probability - (p.occurred ? 1 : 0)) ** 2
  return total / predictions.length
}

/**
 * Brier skill score against a baseline. 0 = no better than baseline,
 * 1 = perfect, negative = worse than baseline.
 *
 * The baseline should be the climatological base rate, not 0.5 — beating a coin
 * flip on a market that goes up 53% of the time is not a skill.
 */
export function brierSkillScore(modelBrier: number, baselineBrier: number): number {
  if (!Number.isFinite(modelBrier) || !Number.isFinite(baselineBrier) || baselineBrier === 0) {
    return Number.NaN
  }
  return 1 - modelBrier / baselineBrier
}

/** Brier score of always predicting the base rate. */
export function baselineBrier(baseRate: number, n: number): number {
  if (n === 0) return Number.NaN
  const p = clampProbability(baseRate, 0)
  // E[(p - y)²] where y ~ Bernoulli(baseRate) = p² (1-baseRate) + (1-p)² baseRate
  return p * p * (1 - baseRate) + (1 - p) ** 2 * baseRate
}

/** Multi-class log loss (cross-entropy). Lower is better; unbounded above. */
export function logLoss(predictions: readonly ScoredPrediction[]): number {
  if (predictions.length === 0) return Number.NaN
  let total = 0
  for (const p of predictions) {
    const prob = clampProbability(p.probabilities[p.actual] ?? 0)
    total -= Math.log(prob)
  }
  return total / predictions.length
}

/**
 * Directional accuracy: fraction where the highest-probability outcome
 * occurred. Reported alongside the proper scores, never instead of them.
 */
export function directionalAccuracy(predictions: readonly ScoredPrediction[]): number {
  if (predictions.length === 0) return Number.NaN
  let correct = 0
  for (const p of predictions) {
    let bestKey: string | null = null
    let bestProb = -Infinity
    for (const [key, prob] of Object.entries(p.probabilities)) {
      if (prob > bestProb) {
        bestProb = prob
        bestKey = key
      }
    }
    if (bestKey === p.actual) correct++
  }
  return correct / predictions.length
}

export interface ConfidenceBucketMetrics {
  readonly lower: number
  readonly upper: number
  readonly count: number
  readonly accuracy: number
  readonly meanConfidence: number
}

/**
 * Accuracy by confidence band. If the system is behaving, accuracy should rise
 * monotonically across bands — that is the check that confidence means anything.
 */
export function accuracyByConfidence(
  predictions: readonly (ScoredPrediction & { confidence: number })[],
  bounds: readonly number[] = [0, 0.3, 0.5, 0.65, 0.8, 0.9, 1.0001],
): ConfidenceBucketMetrics[] {
  const out: ConfidenceBucketMetrics[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const lower = bounds[i] ?? 0
    const upper = bounds[i + 1] ?? 1
    const inBucket = predictions.filter((p) => p.confidence >= lower && p.confidence < upper)
    out.push({
      lower,
      upper,
      count: inBucket.length,
      accuracy: inBucket.length === 0 ? Number.NaN : directionalAccuracy(inBucket),
      meanConfidence:
        inBucket.length === 0
          ? Number.NaN
          : inBucket.reduce((a, p) => a + p.confidence, 0) / inBucket.length,
    })
  }
  return out
}

/**
 * Minimum sample size before a metric is displayed rather than suppressed.
 *
 * Below this the performance dashboard shows "Insufficient data". Publishing an
 * accuracy figure from 12 predictions would be a fabricated statistic in
 * everything but the literal sense.
 */
export const MIN_SAMPLE_FOR_DISPLAY = 100

export function isReportable(n: number): boolean {
  return n >= MIN_SAMPLE_FOR_DISPLAY
}
