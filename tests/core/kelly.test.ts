/**
 * Kelly staking tests — every expected value is hand-computed from
 * f* = (d·p − 1)/(d − 1).
 */

import { describe, expect, it } from 'vitest'

import {
  assessStaking,
  assessStakingAtAsk,
  DEFAULT_CAP_FRACTION,
  kellyFraction,
} from '@/core/staking/kelly'

describe('kellyFraction', () => {
  it('computes the textbook example (hand-computed)', () => {
    // p = 0.55 at evens (d = 2): f* = (2·0.55 − 1)/(2 − 1) = 0.10.
    expect(kellyFraction(0.55, 2)).toBeCloseTo(0.1, 12)
  })

  it('computes an odds-against example (hand-computed)', () => {
    // p = 0.40 at d = 3: f* = (3·0.4 − 1)/2 = 0.2/2 = 0.10.
    expect(kellyFraction(0.4, 3)).toBeCloseTo(0.1, 12)
  })

  it('is exactly zero at break-even', () => {
    // p = 1/d means no edge: d = 2.5, p = 0.4.
    expect(kellyFraction(0.4, 2.5)).toBe(0)
  })

  it('never returns a negative stake for a negative edge', () => {
    expect(kellyFraction(0.3, 2)).toBe(0)
  })

  it('rejects degenerate inputs', () => {
    expect(() => kellyFraction(0, 2)).toThrow()
    expect(() => kellyFraction(1, 2)).toThrow()
    expect(() => kellyFraction(0.5, 1)).toThrow()
    expect(() => kellyFraction(0.5, Number.POSITIVE_INFINITY)).toThrow()
  })
})

describe('assessStaking', () => {
  it('applies quarter Kelly and the absolute cap (hand-computed)', () => {
    // Full Kelly 0.10 → quarter 0.025 → capped at the 0.02 default.
    const a = assessStaking({ probability: 0.55, decimalOdds: 2 })
    expect(a.kellyFraction).toBeCloseTo(0.1, 12)
    expect(a.adjustedFraction).toBe(DEFAULT_CAP_FRACTION)
    expect(a.expectedValuePerUnit).toBeCloseTo(0.1, 12)
    expect(a.breakevenProbability).toBeCloseTo(0.5, 12)
    expect(a.hasPositiveExpectation).toBe(true)
  })

  it('leaves small fractions untouched by the cap (hand-computed)', () => {
    // p = 0.52 at d = 2: f* = 0.04; quarter = 0.01 < cap.
    const a = assessStaking({ probability: 0.52, decimalOdds: 2 })
    expect(a.adjustedFraction).toBeCloseTo(0.01, 12)
  })

  it('reports zero staking with negative expectation honestly', () => {
    const a = assessStaking({ probability: 0.45, decimalOdds: 2 })
    expect(a.kellyFraction).toBe(0)
    expect(a.adjustedFraction).toBe(0)
    expect(a.hasPositiveExpectation).toBe(false)
    expect(a.expectedValuePerUnit).toBeCloseTo(-0.1, 12)
  })

  it('honours a custom multiplier and cap', () => {
    const a = assessStaking({
      probability: 0.55,
      decimalOdds: 2,
      kellyMultiplier: 0.5,
      capFraction: 0.1,
    })
    expect(a.adjustedFraction).toBeCloseTo(0.05, 12)
  })
})

describe('assessStakingAtAsk', () => {
  it('converts a prediction-market ask to decimal odds (hand-computed)', () => {
    // ask 0.40, p 0.50: d = 2.5, f* = (2.5·0.5 − 1)/1.5 = 1/6.
    const a = assessStakingAtAsk(0.5, 0.4)
    expect(a.kellyFraction).toBeCloseTo(1 / 6, 12)
    // EV per unit = d·p − 1 = 0.25, which equals (p − ask)/ask.
    expect(a.expectedValuePerUnit).toBeCloseTo(0.25, 12)
  })

  it('rejects an ask outside (0,1)', () => {
    expect(() => assessStakingAtAsk(0.5, 0)).toThrow()
    expect(() => assessStakingAtAsk(0.5, 1)).toThrow()
  })
})
