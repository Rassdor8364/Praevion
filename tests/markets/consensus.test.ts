import { describe, expect, it } from 'vitest'

import type { ConsensusInput, RawSignal } from '@/engines/markets/consensus'
import { independenceScore, weightedConsensus } from '@/engines/markets/consensus'

const T0 = 1_755_000_000_000

function signal(overrides: Partial<RawSignal>): RawSignal {
  return { traderId: 'w0', ts: T0, side: 'buy', size: 250, ...overrides }
}

/** Ten wallets copying one leader: identical timestamp, identical size, all buys. */
const HERD: RawSignal[] = Array.from({ length: 10 }, (_, i) => signal({ traderId: `w${i}` }))

/** Ten genuinely independent signals: spread over hours, distinct sizes, two-way flow. */
const INDEPENDENT: RawSignal[] = Array.from({ length: 10 }, (_, i) =>
  signal({
    traderId: `t${i}`,
    ts: T0 + i * 3_600_000,
    size: 100 + i * 37,
    side: i % 2 === 0 ? 'buy' : 'sell',
  }),
)

function inputsWith(independence: number, n = 10, probability = 0.7): ConsensusInput[] {
  return Array.from({ length: n }, (_, i) => ({
    source: `s${i}`,
    probability,
    weight: 1,
    independence,
  }))
}

describe('independenceScore', () => {
  it('flags the herd: identical timestamps and sizes score very low', () => {
    expect(independenceScore(HERD)).toBeLessThan(0.25)
  })

  it('leaves independent flow essentially unpenalised', () => {
    expect(independenceScore(INDEPENDENT)).toBeGreaterThan(0.9)
  })

  it('is 1 for fewer than two signals — dependence is undefined for a set of one', () => {
    expect(independenceScore([])).toBe(1)
    expect(independenceScore([signal({})])).toBe(1)
  })

  it('one-sided but otherwise organic flow is dampened, not condemned', () => {
    const oneSided = INDEPENDENT.map((s) => ({ ...s, side: 'buy' }))
    const score = independenceScore(oneSided)
    expect(score).toBeLessThan(1)
    expect(score).toBeGreaterThan(0.7)
  })

  it('stays in [0,1] for garbage signals', () => {
    const garbage: RawSignal[] = [
      signal({ ts: Number.NaN, size: Number.POSITIVE_INFINITY }),
      signal({ ts: Number.NaN, size: Number.NaN, side: 'weird' }),
      signal({ ts: Number.NEGATIVE_INFINITY, size: -5 }),
    ]
    const score = independenceScore(garbage)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })
})

describe('weightedConsensus — herding collapses effectiveN', () => {
  it('ten copy-signals collapse toward effectiveN ≈ 1: ten hats, one head', () => {
    const ind = independenceScore(HERD)
    const result = weightedConsensus(inputsWith(ind))
    expect(result.effectiveN).toBeLessThan(2)
    expect(result.effectiveN).toBeGreaterThanOrEqual(1) // still ONE real signal
    expect(result.herdingDiscount).toBeGreaterThan(0.7)
  })

  it('ten independent signals keep their full effectiveN', () => {
    const ind = independenceScore(INDEPENDENT)
    const result = weightedConsensus(inputsWith(ind))
    expect(result.effectiveN).toBeGreaterThan(8)
    expect(result.herdingDiscount).toBeLessThan(0.1)
  })

  it('effectiveN also shrinks when one source hoards the weight', () => {
    const concentrated = weightedConsensus([
      { source: 'whale', probability: 0.7, weight: 95, independence: 1 },
      { source: 'minnow', probability: 0.6, weight: 5, independence: 1 },
    ])
    expect(concentrated.effectiveN).toBeLessThan(1.5)
  })
})

describe('weightedConsensus — pooling', () => {
  it('a single source passes through its probability', () => {
    const out = weightedConsensus([{ source: 'a', probability: 0.7, weight: 1, independence: 1 }])
    expect(out.probability).toBeCloseTo(0.7, 8)
    expect(out.effectiveN).toBeCloseTo(1, 8)
  })

  it('symmetric disagreement pools to 0.5', () => {
    const out = weightedConsensus([
      { source: 'a', probability: 0.6, weight: 1, independence: 1 },
      { source: 'b', probability: 0.4, weight: 1, independence: 1 },
    ])
    expect(out.probability).toBeCloseTo(0.5, 8)
  })

  it('a heavier weight pulls the pool toward its holder', () => {
    const out = weightedConsensus([
      { source: 'a', probability: 0.8, weight: 3, independence: 1 },
      { source: 'b', probability: 0.4, weight: 1, independence: 1 },
    ])
    expect(out.probability).toBeGreaterThan(0.6)
  })

  it('an empty pool returns the ignorance prior with effectiveN 0', () => {
    expect(weightedConsensus([])).toEqual({ probability: 0.5, effectiveN: 0, herdingDiscount: 0 })
  })

  it('a pool whose weights all sanitise to zero degrades the same way', () => {
    const out = weightedConsensus([
      { source: 'a', probability: 0.9, weight: Number.NaN, independence: 1 },
      { source: 'b', probability: 0.9, weight: -4, independence: 1 },
    ])
    expect(out).toEqual({ probability: 0.5, effectiveN: 0, herdingDiscount: 0 })
  })
})

describe('weightedConsensus — adversarial inputs stay bounded', () => {
  it('survives NaN probabilities, Infinity weights and NaN independence', () => {
    const out = weightedConsensus([
      { source: 'a', probability: Number.NaN, weight: Number.POSITIVE_INFINITY, independence: Number.NaN },
      { source: 'b', probability: 0.8, weight: 1, independence: 0.5 },
      { source: 'c', probability: Number.POSITIVE_INFINITY, weight: 2, independence: -3 },
    ])
    expect(out.probability).toBeGreaterThan(0)
    expect(out.probability).toBeLessThan(1)
    expect(Number.isFinite(out.effectiveN)).toBe(true)
    expect(out.effectiveN).toBeGreaterThanOrEqual(0)
    expect(out.herdingDiscount).toBeGreaterThanOrEqual(0)
    expect(out.herdingDiscount).toBeLessThanOrEqual(1)
  })
})
