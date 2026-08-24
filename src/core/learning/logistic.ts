/**
 * Regularized multinomial logistic regression — the trainable statistical
 * model of the Praevion Adaptive Intelligence Engine.
 *
 * Why THIS model and not something fancier: the beta's learned model must be
 * (a) deterministic — identical data must produce identical coefficients, or
 * versioning and backtesting are meaningless; (b) interpretable — every
 * coefficient is a statement about a named feature that the UI can display
 * honestly; (c) trainable in-process — no Python service, no native deps, no
 * nondeterministic BLAS. L2-regularized softmax regression trained by
 * full-batch gradient descent with a fixed iteration budget satisfies all
 * three. Full-batch is the determinism guarantee: there is no minibatch
 * shuffle, so there is no random seed to manage at all.
 *
 * The L2 penalty (excluding the intercept, as is standard — regularizing the
 * intercept would bias the model toward uniform base rates even with
 * abundant data) is what stops a thin season of history producing confident
 * nonsense coefficients: with little data the penalty dominates and the
 * model stays close to base rates, which is the honest behaviour.
 *
 * Pure module: no clock, no I/O, no randomness.
 */

import { invariant } from '../errors'

export interface TrainingSample {
  /** Feature vector WITHOUT the intercept — the trainer appends it. */
  readonly features: readonly number[]
  /** Index into the class list, 0-based. */
  readonly label: number
}

export interface LogisticConfig {
  readonly classCount: number
  /** L2 strength λ (per-sample scale). 0 disables regularization. */
  readonly l2?: number
  readonly learningRate?: number
  readonly iterations?: number
}

export interface LogisticModel {
  /** weights[class][featureIndex]; the LAST column is the intercept. */
  readonly weights: readonly (readonly number[])[]
  readonly classCount: number
  readonly featureCount: number
  /** Mean regularized negative log-likelihood at the final iteration. */
  readonly finalLoss: number
  readonly iterations: number
  readonly sampleCount: number
}

const DEFAULT_L2 = 0.01
const DEFAULT_LEARNING_RATE = 0.5
const DEFAULT_ITERATIONS = 400

/** Numerically-safe softmax over raw scores. */
function softmaxScores(scores: readonly number[]): number[] {
  let max = -Infinity
  for (const s of scores) if (s > max) max = s
  let sum = 0
  const exps = scores.map((s) => {
    const e = Math.exp(s - max)
    sum += e
    return e
  })
  return exps.map((e) => e / sum)
}

function scoreOf(weights: readonly (readonly number[])[], features: readonly number[], k: number): number {
  const w = weights[k]
  invariant(w !== undefined, 'class weight vector missing')
  let s = w[w.length - 1] ?? 0 // intercept
  for (let j = 0; j < features.length; j++) s += (w[j] ?? 0) * (features[j] ?? 0)
  return s
}

/** Class-probability vector for one feature vector under a trained model. */
export function predictProbabilities(
  model: Pick<LogisticModel, 'weights' | 'classCount' | 'featureCount'>,
  features: readonly number[],
): number[] {
  invariant(
    features.length === model.featureCount,
    `expected ${model.featureCount} features, got ${features.length}`,
  )
  invariant(
    features.every((f) => Number.isFinite(f)),
    'features must be finite — an upstream builder leaked a NaN',
  )
  const scores: number[] = []
  for (let k = 0; k < model.classCount; k++) scores.push(scoreOf(model.weights, features, k))
  return softmaxScores(scores)
}

/**
 * Train by full-batch gradient descent.
 *
 * The gradient of the mean cross-entropy w.r.t. class k's weights is
 * mean over samples of (p_k − 1{y=k}) · x, plus λ·w_k for the L2 term
 * (intercept excluded). A fixed iteration budget rather than a convergence
 * test keeps runtime bounded and — more importantly — keeps the output a
 * pure function of the inputs alone.
 */
export function trainMultinomialLogistic(
  samples: readonly TrainingSample[],
  config: LogisticConfig,
): LogisticModel {
  const { classCount } = config
  const l2 = config.l2 ?? DEFAULT_L2
  const learningRate = config.learningRate ?? DEFAULT_LEARNING_RATE
  const iterations = config.iterations ?? DEFAULT_ITERATIONS

  invariant(classCount >= 2, 'trainMultinomialLogistic requires at least two classes')
  invariant(samples.length > 0, 'trainMultinomialLogistic requires samples')
  invariant(l2 >= 0 && Number.isFinite(l2), 'l2 must be a finite non-negative number')
  invariant(learningRate > 0 && iterations > 0, 'learning rate and iterations must be positive')

  const featureCount = samples[0]?.features.length ?? 0
  invariant(featureCount > 0, 'samples must carry at least one feature')
  for (const s of samples) {
    invariant(
      s.features.length === featureCount,
      'all samples must have the same feature count',
    )
    invariant(
      s.features.every((f) => Number.isFinite(f)),
      'training features must be finite',
    )
    invariant(
      Number.isInteger(s.label) && s.label >= 0 && s.label < classCount,
      `label ${s.label} outside [0, ${classCount})`,
    )
  }

  // Deterministic zero init: symmetric start, gradient breaks the symmetry
  // through the data alone.
  const cols = featureCount + 1 // + intercept
  const weights: number[][] = Array.from({ length: classCount }, () => new Array<number>(cols).fill(0))

  const n = samples.length
  let finalLoss = Number.NaN

  for (let iter = 0; iter < iterations; iter++) {
    const grad: number[][] = Array.from({ length: classCount }, () => new Array<number>(cols).fill(0))
    let loss = 0

    for (const s of samples) {
      const scores: number[] = []
      for (let k = 0; k < classCount; k++) scores.push(scoreOf(weights, s.features, k))
      const probs = softmaxScores(scores)
      loss -= Math.log(Math.max(1e-12, probs[s.label] ?? 0))

      for (let k = 0; k < classCount; k++) {
        const delta = (probs[k] ?? 0) - (k === s.label ? 1 : 0)
        const gk = grad[k]
        if (gk === undefined) continue
        for (let j = 0; j < featureCount; j++) gk[j] = (gk[j] ?? 0) + delta * (s.features[j] ?? 0)
        gk[cols - 1] = (gk[cols - 1] ?? 0) + delta // intercept column
      }
    }

    // Mean gradient + L2 (intercept excluded), then the descent step.
    for (let k = 0; k < classCount; k++) {
      const wk = weights[k]
      const gk = grad[k]
      if (wk === undefined || gk === undefined) continue
      for (let j = 0; j < cols; j++) {
        const l2Term = j < featureCount ? l2 * (wk[j] ?? 0) : 0
        wk[j] = (wk[j] ?? 0) - learningRate * ((gk[j] ?? 0) / n + l2Term)
      }
    }

    if (iter === iterations - 1) {
      let penalty = 0
      for (let k = 0; k < classCount; k++) {
        for (let j = 0; j < featureCount; j++) penalty += (weights[k]?.[j] ?? 0) ** 2
      }
      finalLoss = loss / n + (l2 / 2) * penalty
    }
  }

  return { weights, classCount, featureCount, finalLoss, iterations, sampleCount: n }
}
