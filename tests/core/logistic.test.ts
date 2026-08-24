/**
 * Multinomial logistic regression tests.
 *
 * Gradient descent does not yield closed-form coefficients to hand-check, so
 * these tests pin down the properties that MATTER: the optimum it converges
 * to on problems whose optimum is known analytically (base rates, separable
 * data), determinism, and the regularization direction.
 */

import { describe, expect, it } from 'vitest'

import {
  predictProbabilities,
  trainMultinomialLogistic,
  type TrainingSample,
} from '@/core/learning/logistic'

function constantFeatureSamples(labels: readonly number[]): TrainingSample[] {
  return labels.map((label) => ({ features: [0], label }))
}

describe('trainMultinomialLogistic', () => {
  it('learns class base rates when features carry no information', () => {
    // With a zero feature the optimum is the empirical distribution: the
    // intercepts alone carry it. 60/20/20 over 100 samples.
    const labels = [
      ...Array.from({ length: 60 }, () => 0),
      ...Array.from({ length: 20 }, () => 1),
      ...Array.from({ length: 20 }, () => 2),
    ]
    const model = trainMultinomialLogistic(constantFeatureSamples(labels), {
      classCount: 3,
      iterations: 2000,
      learningRate: 0.5,
      l2: 0,
    })
    const probs = predictProbabilities(model, [0])
    expect(probs[0]).toBeCloseTo(0.6, 2)
    expect(probs[1]).toBeCloseTo(0.2, 2)
    expect(probs[2]).toBeCloseTo(0.2, 2)
  })

  it('separates linearly separable classes', () => {
    const samples: TrainingSample[] = [
      ...Array.from({ length: 40 }, () => ({ features: [1], label: 0 })),
      ...Array.from({ length: 40 }, () => ({ features: [-1], label: 1 })),
    ]
    const model = trainMultinomialLogistic(samples, { classCount: 2 })
    expect(predictProbabilities(model, [1])[0]).toBeGreaterThan(0.85)
    expect(predictProbabilities(model, [-1])[1]).toBeGreaterThan(0.85)
  })

  it('is deterministic: identical inputs produce identical coefficients', () => {
    const samples: TrainingSample[] = Array.from({ length: 30 }, (_, i) => ({
      features: [Math.sin(i), Math.cos(i)],
      label: i % 3,
    }))
    const a = trainMultinomialLogistic(samples, { classCount: 3 })
    const b = trainMultinomialLogistic(samples, { classCount: 3 })
    expect(a.weights).toEqual(b.weights)
    expect(a.finalLoss).toBe(b.finalLoss)
  })

  it('stronger L2 shrinks feature coefficients toward zero', () => {
    const samples: TrainingSample[] = [
      ...Array.from({ length: 40 }, () => ({ features: [1], label: 0 })),
      ...Array.from({ length: 40 }, () => ({ features: [-1], label: 1 })),
    ]
    const weak = trainMultinomialLogistic(samples, { classCount: 2, l2: 0.001 })
    const strong = trainMultinomialLogistic(samples, { classCount: 2, l2: 1 })
    const magnitude = (m: typeof weak): number => Math.abs(m.weights[0]?.[0] ?? 0)
    expect(magnitude(strong)).toBeLessThan(magnitude(weak))
  })

  it('rejects malformed training data loudly', () => {
    expect(() => trainMultinomialLogistic([], { classCount: 2 })).toThrow()
    expect(() =>
      trainMultinomialLogistic([{ features: [1], label: 5 }], { classCount: 2 }),
    ).toThrow(/label/)
    expect(() =>
      trainMultinomialLogistic(
        [
          { features: [1], label: 0 },
          { features: [1, 2], label: 1 },
        ],
        { classCount: 2 },
      ),
    ).toThrow(/feature count/)
    expect(() =>
      trainMultinomialLogistic([{ features: [Number.NaN], label: 0 }], { classCount: 2 }),
    ).toThrow(/finite/)
  })
})

describe('predictProbabilities', () => {
  it('always returns a distribution that sums to 1', () => {
    const samples: TrainingSample[] = Array.from({ length: 20 }, (_, i) => ({
      features: [i / 10 - 1],
      label: i % 3,
    }))
    const model = trainMultinomialLogistic(samples, { classCount: 3 })
    for (const x of [-2, -0.5, 0, 0.5, 2]) {
      const probs = predictProbabilities(model, [x])
      expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
      for (const p of probs) expect(p).toBeGreaterThan(0)
    }
  })

  it('rejects a feature vector of the wrong arity or with NaNs', () => {
    const model = trainMultinomialLogistic([{ features: [1], label: 0 }], { classCount: 2 })
    expect(() => predictProbabilities(model, [1, 2])).toThrow(/expected 1 features/)
    expect(() => predictProbabilities(model, [Number.NaN])).toThrow(/finite/)
  })
})
