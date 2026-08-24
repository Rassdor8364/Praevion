/**
 * Adaptive-weights tests — hand-computed from
 *   skill = 1 − brier/(2/3),  shrunk = skill·n/(n+50),
 *   weight = clamp(1 + 2.5·shrunk, 0.4, 1.6).
 */

import { describe, expect, it } from 'vitest'

import {
  computeAdaptiveWeights,
  DEFAULT_MAX_WEIGHT,
  DEFAULT_MIN_WEIGHT,
  UNIFORM_1X2_BRIER,
} from '@/core/learning/adaptive-weights'

const record = (modelId: string, sampleSize: number, brier: number) => ({
  modelId,
  sampleSize,
  brier,
  logLoss: 1,
})

describe('computeAdaptiveWeights', () => {
  it('holds a model below the minimum sample at exactly neutral weight', () => {
    // 29 samples of PERFECT forecasting still buys nothing.
    const r = computeAdaptiveWeights([record('m', 29, 0)])
    expect(r.weights['m']).toBe(1)
    expect(r.rationale[0]?.gated).toBe(true)
  })

  it('computes the shrunk weight for a skilled model (hand-computed)', () => {
    // brier 0.5 → skill = 1 − 0.5/(2/3) = 0.25; n = 100 → shrunk = 0.25·(100/150) = 1/6;
    // weight = 1 + 2.5/6 = 1.41666…
    const r = computeAdaptiveWeights([record('m', 100, 0.5)])
    expect(r.weights['m']).toBeCloseTo(1 + 2.5 / 6, 12)
    expect(r.rationale[0]?.skill).toBeCloseTo(0.25, 12)
    expect(r.rationale[0]?.shrunkSkill).toBeCloseTo(1 / 6, 12)
    expect(r.rationale[0]?.gated).toBe(false)
  })

  it('penalises a model worse than the uniform baseline (hand-computed)', () => {
    // brier 0.8 → skill = 1 − 0.8/(2/3) = −0.2; n = 200 → shrunk = −0.2·0.8 = −0.16;
    // weight = 1 − 0.4 = 0.6.
    const r = computeAdaptiveWeights([record('m', 200, 0.8)])
    expect(r.weights['m']).toBeCloseTo(0.6, 12)
  })

  it('caps a long perfect record at the maximum weight', () => {
    const r = computeAdaptiveWeights([record('m', 100_000, 0)])
    expect(r.weights['m']).toBe(DEFAULT_MAX_WEIGHT)
  })

  it('floors a catastrophic record at the minimum weight', () => {
    const r = computeAdaptiveWeights([record('m', 100_000, 2)])
    expect(r.weights['m']).toBe(DEFAULT_MIN_WEIGHT)
  })

  it('treats a non-finite Brier as gated, never as NaN influence', () => {
    const r = computeAdaptiveWeights([record('m', 500, Number.NaN)])
    expect(r.weights['m']).toBe(1)
    expect(r.rationale[0]?.gated).toBe(true)
  })

  it('weights several models independently and audits each', () => {
    const r = computeAdaptiveWeights([
      record('good', 100, 0.5),
      record('thin', 10, 0.1),
      record('bad', 200, 0.8),
    ])
    expect(r.weights['good'] ?? 0).toBeGreaterThan(1)
    expect(r.weights['thin']).toBe(1)
    expect(r.weights['bad'] ?? 1).toBeLessThan(1)
    expect(r.rationale).toHaveLength(3)
  })

  it('exposes the uniform 1X2 baseline as exactly 2/3', () => {
    expect(UNIFORM_1X2_BRIER).toBeCloseTo(2 / 3, 12)
  })
})
