/**
 * Probability primitives. Pure, total, and heavily unit-tested — everything
 * downstream of here inherits its correctness from this file.
 */

import { invariant } from '../errors'
import type { Outcome } from './types'

/** Clamp into the open interval (eps, 1-eps) so logit stays finite. */
export const PROB_EPS = 1e-9

export function clampProbability(p: number, eps: number = PROB_EPS): number {
  if (!Number.isFinite(p)) return 0.5
  if (p < eps) return eps
  if (p > 1 - eps) return 1 - eps
  return p
}

export function logit(p: number): number {
  const c = clampProbability(p)
  return Math.log(c / (1 - c))
}

export function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 - PROB_EPS : PROB_EPS
  // Numerically stable both sides.
  if (x >= 0) {
    const z = Math.exp(-x)
    return 1 / (1 + z)
  }
  const z = Math.exp(x)
  return z / (1 + z)
}

/** Rescale a set of non-negative weights into a probability distribution. */
export function normalize(values: readonly number[]): number[] {
  let sum = 0
  for (const v of values) {
    invariant(Number.isFinite(v) && v >= 0, 'normalize requires finite non-negative values')
    sum += v
  }
  if (sum === 0) {
    const uniform = values.length === 0 ? 0 : 1 / values.length
    return values.map(() => uniform)
  }
  return values.map((v) => v / sum)
}

/** Normalize outcome probabilities in place-safe fashion, preserving keys. */
export function normalizeOutcomes(outcomes: readonly Outcome[]): Outcome[] {
  const normalized = normalize(outcomes.map((o) => Math.max(0, o.probability)))
  return outcomes.map((o, i) => ({ ...o, probability: normalized[i] ?? 0 }))
}

/** Softmax over arbitrary real scores. */
export function softmax(scores: readonly number[], temperature = 1): number[] {
  invariant(temperature > 0, 'softmax temperature must be positive')
  if (scores.length === 0) return []
  let max = -Infinity
  for (const s of scores) if (s > max) max = s
  const exps = scores.map((s) => Math.exp((s - max) / temperature))
  return normalize(exps)
}

// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

/** Mathematically fair decimal odds for a probability (no margin applied). */
export function fairDecimalOdds(probability: number): number {
  const p = clampProbability(probability)
  return 1 / p
}

/** Decimal odds → implied probability (still containing the bookmaker margin). */
export function impliedProbability(decimalOdds: number): number {
  invariant(decimalOdds > 1, 'decimal odds must exceed 1')
  return 1 / decimalOdds
}

/** Convert decimal odds to American odds. */
export function toAmericanOdds(decimalOdds: number): number {
  invariant(decimalOdds > 1, 'decimal odds must exceed 1')
  return decimalOdds >= 2
    ? Math.round((decimalOdds - 1) * 100)
    : Math.round(-100 / (decimalOdds - 1))
}

/**
 * Total overround ("vig") across a market's decimal odds.
 * Returns 0.05 for a market whose implied probabilities sum to 1.05.
 */
export function overround(decimalOddsSet: readonly number[]): number {
  let sum = 0
  for (const o of decimalOddsSet) sum += impliedProbability(o)
  return sum - 1
}

/**
 * Remove the bookmaker margin to recover the market's true implied
 * probabilities.
 *
 * Two methods are supported because they disagree meaningfully on lopsided
 * markets. Multiplicative (proportional) scaling is the simple default. The
 * power method solves for k such that Σ pᵢ^k = 1, which better reflects the
 * empirical fact that favourite-longshot bias makes margin non-uniform — the
 * margin loaded onto a 1.10 favourite is not the same as that on a 15.0
 * outsider.
 */
export function removeVig(
  decimalOddsSet: readonly number[],
  method: 'multiplicative' | 'power' = 'power',
): number[] {
  const raw = decimalOddsSet.map(impliedProbability)
  if (method === 'multiplicative') return normalize(raw)

  // Solve Σ pᵢ^k = 1 for k by bisection. k < 1 for an overround book.
  let lo = 0.5
  let hi = 1.5
  const total = (k: number): number => raw.reduce((acc, p) => acc + Math.pow(p, k), 0)
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (total(mid) > 1) lo = mid
    else hi = mid
  }
  const k = (lo + hi) / 2
  return normalize(raw.map((p) => Math.pow(p, k)))
}

/**
 * Vixera Edge: the gap between our modelled probability and the market's
 * de-vigged probability, in percentage points.
 *
 * This is an analytical comparison of two probability estimates. It is not
 * advice to place a wager, and the UI presents it as a model-versus-market
 * divergence measure.
 */
export interface EdgeAnalysis {
  readonly vixeraProbability: number
  readonly marketProbability: number
  /** Signed difference in probability points (0.08 = +8pp). */
  readonly edge: number
  readonly fairDecimalOdds: number
  readonly marketDecimalOdds: number
  readonly overround: number
}

export function analyseEdge(params: {
  vixeraProbability: number
  marketDecimalOdds: number
  marketOddsSet: readonly number[]
  method?: 'multiplicative' | 'power'
}): EdgeAnalysis {
  const { vixeraProbability, marketDecimalOdds, marketOddsSet } = params
  const idx = marketOddsSet.indexOf(marketDecimalOdds)
  invariant(idx >= 0, 'marketDecimalOdds must be a member of marketOddsSet')
  const devigged = removeVig(marketOddsSet, params.method ?? 'power')
  const marketProbability = devigged[idx] ?? impliedProbability(marketDecimalOdds)
  return {
    vixeraProbability,
    marketProbability,
    edge: vixeraProbability - marketProbability,
    fairDecimalOdds: fairDecimalOdds(vixeraProbability),
    marketDecimalOdds,
    overround: overround(marketOddsSet),
  }
}

// ---------------------------------------------------------------------------
// Shrinkage
// ---------------------------------------------------------------------------

/**
 * Shrink an observed rate toward a prior using an effective sample size.
 *
 * This is how the system refuses to be impressed by small samples. A team that
 * has won 3 of its last 3 meetings does not get a 100% prior; with priorWeight
 * ~5 it lands near 0.66. Used for head-to-head, player-absence impact, and any
 * empirically-estimated rate with thin history.
 */
export function shrinkToPrior(
  observedRate: number,
  sampleSize: number,
  prior: number,
  priorWeight: number,
): number {
  invariant(sampleSize >= 0, 'sampleSize must be non-negative')
  invariant(priorWeight > 0, 'priorWeight must be positive')
  return (observedRate * sampleSize + prior * priorWeight) / (sampleSize + priorWeight)
}

/** Exponential recency weight: weight of an observation `stepsAgo` steps back. */
export function recencyWeight(stepsAgo: number, lambda: number): number {
  invariant(lambda >= 0, 'lambda must be non-negative')
  return Math.exp(-lambda * stepsAgo)
}

/** Half-life (in steps) implied by a decay constant. */
export function halfLife(lambda: number): number {
  invariant(lambda > 0, 'lambda must be positive')
  return Math.LN2 / lambda
}
