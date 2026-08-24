/**
 * Walk-forward validation harness tests. The fixed predictors make every
 * aggregate metric hand-computable.
 */

import { describe, expect, it } from 'vitest'

import { walkForwardValidate, type ChronologicalSample } from '@/core/learning/walk-forward'

interface S extends ChronologicalSample {
  readonly id: number
}

function samples(labels: readonly number[]): S[] {
  return labels.map((label, i) => ({ id: i, timestamp: 1000 + i, label }))
}

describe('walkForwardValidate', () => {
  it('never trains on the future: every training slice precedes its validation window', () => {
    const seen: { trainMax: number; validationMin: number }[] = []
    walkForwardValidate(samples([0, 1, 0, 1, 0, 1, 0, 1]), { minTrainSize: 3, validationSize: 2 }, (train) => {
      const trainMax = Math.max(...train.map((s) => s.timestamp))
      return (sample) => {
        seen.push({ trainMax, validationMin: sample.timestamp })
        return [0.5, 0.5]
      }
    })
    expect(seen.length).toBeGreaterThan(0)
    for (const { trainMax, validationMin } of seen) {
      expect(validationMin).toBeGreaterThan(trainMax)
    }
  })

  it('rolls the training window forward across folds', () => {
    const trainSizes: number[] = []
    walkForwardValidate(
      samples(Array.from({ length: 10 }, (_, i) => i % 2)),
      { minTrainSize: 4, validationSize: 2 },
      (train) => {
        trainSizes.push(train.length)
        return () => [0.5, 0.5]
      },
    )
    expect(trainSizes).toEqual([4, 6, 8])
  })

  it('computes hand-checked metrics for a constant coin-flip predictor', () => {
    // Binary labels, predictor always [0.5, 0.5]:
    //   per-sample Brier = 0.25 + 0.25 = 0.5; log loss = ln 2; accuracy —
    //   argmax ties resolve to index 0 (strict > comparison), so accuracy is
    //   the fraction of label-0 samples in the validated window.
    const r = walkForwardValidate(
      samples([0, 0, 0, 0, 1, 0, 1, 0]),
      { minTrainSize: 4, validationSize: 4 },
      () => () => [0.5, 0.5],
    )
    expect(r.totalValidated).toBe(4)
    expect(r.brier).toBeCloseTo(0.5, 12)
    expect(r.logLoss).toBeCloseTo(Math.log(2), 12)
    expect(r.accuracy).toBeCloseTo(0.5, 12) // labels [1,0,1,0] → argmax 0 hits twice
  })

  it('a perfect predictor scores zero Brier and full accuracy', () => {
    const r = walkForwardValidate(
      samples([0, 1, 0, 1, 0, 1]),
      { minTrainSize: 2, validationSize: 2 },
      () => (s) => (s.label === 0 ? [1 - 1e-9, 1e-9] : [1e-9, 1 - 1e-9]),
    )
    expect(r.brier).toBeCloseTo(0, 6)
    expect(r.accuracy).toBe(1)
  })

  it('maxFolds keeps the MOST RECENT folds and reweights the aggregates', () => {
    const labels = Array.from({ length: 12 }, (_, i) => (i < 8 ? 0 : 1))
    // Predictor always says class 0 → early folds score perfectly, the last
    // fold (labels 1) scores zero. Keeping only the last 2 folds must drag
    // accuracy down to what those folds actually contain.
    const all = walkForwardValidate(samples(labels), { minTrainSize: 4, validationSize: 2 }, () => () => [
      0.9, 0.1,
    ])
    const capped = walkForwardValidate(
      samples(labels),
      { minTrainSize: 4, validationSize: 2, maxFolds: 2 },
      () => () => [0.9, 0.1],
    )
    expect(all.folds.length).toBe(4)
    expect(capped.folds.length).toBe(2)
    expect(capped.folds[0]?.from).toBeGreaterThan(all.folds[0]?.from ?? 0)
    expect(capped.accuracy).toBe(0) // the kept folds are all label 1
    expect(capped.totalValidated).toBe(4)
  })

  it('rejects a predictor that does not return a distribution', () => {
    expect(() =>
      walkForwardValidate(samples([0, 1, 0, 1]), { minTrainSize: 2, validationSize: 1 }, () => () => [
        0.7, 0.7,
      ]),
    ).toThrow(/sum to 1/)
  })
})
