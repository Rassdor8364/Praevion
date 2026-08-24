import { describe, expect, it } from 'vitest'

import type { OpportunitySort } from '@/core/markets/types'
import { evaluateOpportunity, rankOpportunities } from '@/engines/markets/opportunity'

import {
  CLEAN_RULES,
  DAY_MS,
  NASTY_RULES,
  NOW_MS,
  makeMarket,
  makeOutcome,
  makeParams,
} from './fixtures'

describe('evaluateOpportunity — edge and expected value', () => {
  it('computes EV at the ask: p=0.6, ask=0.5 → EV = 0.10 exactly', () => {
    const opp = evaluateOpportunity(
      makeParams({
        market: makeMarket({ outcomes: [makeOutcome({ marketProbability: 0.48, bid: 0.46, ask: 0.5 })] }),
        vixeraProbability: 0.6,
      }),
    )
    expect(opp.expectedValue).toBeCloseTo(0.1, 10)
  })

  it('computes the edge at the MID, not the ask', () => {
    const opp = evaluateOpportunity(
      makeParams({
        market: makeMarket({ outcomes: [makeOutcome({ marketProbability: 0.55, bid: 0.53, ask: 0.57 })] }),
        vixeraProbability: 0.6,
      }),
    )
    // Edge uses the mid (0.55): +5pp. EV uses the ask (0.57): 0.03.
    expect(opp.edgePp).toBeCloseTo(0.05, 10)
    expect(opp.expectedValue).toBeCloseTo(0.03, 10)
  })

  it('edge sign convention: vixera below market → negative edge', () => {
    const opp = evaluateOpportunity(
      makeParams({
        market: makeMarket({ outcomes: [makeOutcome({ marketProbability: 0.55 })] }),
        vixeraProbability: 0.4,
      }),
    )
    expect(opp.edgePp).toBeCloseTo(-0.15, 10)
  })

  it('returns null EV when no ask exists — there is no executable price', () => {
    const opp = evaluateOpportunity(
      makeParams({
        market: makeMarket({ outcomes: [makeOutcome({ ask: null })] }),
      }),
    )
    expect(opp.expectedValue).toBeNull()
  })
})

describe('evaluateOpportunity — score monotonicity', () => {
  it('score strictly increases with edge, other things fixed', () => {
    const scores = [0.55, 0.58, 0.62].map(
      (p) => evaluateOpportunity(makeParams({ vixeraProbability: p })).opportunityScore,
    )
    expect(scores[0]).toBeLessThan(scores[1] as number)
    expect(scores[1]).toBeLessThan(scores[2] as number)
  })

  it('score strictly decreases with spread', () => {
    const tight = evaluateOpportunity(makeParams({ market: makeMarket({ spread: 0.01 }) }))
    const wide = evaluateOpportunity(makeParams({ market: makeMarket({ spread: 0.03 }) }))
    expect(wide.opportunityScore).toBeLessThan(tight.opportunityScore)
  })

  it('score strictly decreases as resolution risk climbs low → medium → high', () => {
    const low = evaluateOpportunity(makeParams({ market: makeMarket({ resolutionRules: CLEAN_RULES }) }))
    const medium = evaluateOpportunity(makeParams({ market: makeMarket({ resolutionRules: null }) }))
    const high = evaluateOpportunity(makeParams({ market: makeMarket({ resolutionRules: NASTY_RULES }) }))
    expect(low.resolutionRisk.level).toBe('low')
    expect(medium.resolutionRisk.level).toBe('medium')
    expect(high.resolutionRisk.level).toBe('high')
    expect(medium.opportunityScore).toBeLessThan(low.opportunityScore)
    expect(high.opportunityScore).toBeLessThan(medium.opportunityScore)
  })

  it('spread ≥ |edge| forces no_action and caps the score at 35', () => {
    const opp = evaluateOpportunity(
      makeParams({ vixeraProbability: 0.55, market: makeMarket({ spread: 0.06 }) }),
    )
    expect(opp.action).toBe('no_action')
    expect(opp.opportunityScore).toBeLessThanOrEqual(35)
    expect(opp.noActionReasons.some((r) => r.includes('consumes the entire edge'))).toBe(true)
    expect(opp.scoreBreakdown['spreadCapApplied']).toBe(1)
  })
})

describe('evaluateOpportunity — no-action logic (§41)', () => {
  it('the golden fixture is a genuine opportunity (baseline sanity)', () => {
    const opp = evaluateOpportunity(makeParams())
    expect(opp.action).toBe('opportunity')
    expect(opp.noActionReasons).toHaveLength(0)
    expect(opp.opportunityScore).toBeGreaterThanOrEqual(45)
  })

  it('demo dataMode never yields action=opportunity, however strong the inputs', () => {
    const opp = evaluateOpportunity(makeParams({ dataMode: 'demo' }))
    expect(opp.action).toBe('no_action')
    expect(opp.noActionReasons.some((r) => r.includes('Demo data mode'))).toBe(true)

    // Even absurdly strong inputs cannot get demo data past the gate.
    const maxed = evaluateOpportunity(
      makeParams({ dataMode: 'demo', vixeraProbability: 0.95, confidence: 0.99, dataQuality: 100 }),
    )
    expect(maxed.action).toBe('no_action')
  })

  it('|edge| < 4pp → no_action, naming the 4pp threshold', () => {
    const opp = evaluateOpportunity(makeParams({ vixeraProbability: 0.52 }))
    expect(opp.action).toBe('no_action')
    expect(opp.noActionReasons.some((r) => r.includes('below the 4.0pp minimum'))).toBe(true)
  })

  it('confidence < 0.45 → no_action, naming the 0.45 threshold', () => {
    const opp = evaluateOpportunity(makeParams({ confidence: 0.3 }))
    expect(opp.action).toBe('no_action')
    expect(opp.noActionReasons.some((r) => r.includes('below the 0.45 threshold'))).toBe(true)
  })

  it('liquidity grade poor/illiquid → no_action, naming the minimum grade', () => {
    const opp = evaluateOpportunity(
      makeParams({
        market: makeMarket({ spread: 0.12, volume: 200, volume24h: 10, liquidity: null }),
        book: null,
      }),
    )
    expect(opp.liquidity.grade === 'poor' || opp.liquidity.grade === 'illiquid').toBe(true)
    expect(opp.action).toBe('no_action')
    expect(opp.noActionReasons.some((r) => r.includes("minimum tradeable grade ('fair')"))).toBe(true)
  })

  it('high resolution risk with |edge| < 10pp → no_action, naming the 10pp bar', () => {
    const opp = evaluateOpportunity(
      makeParams({ vixeraProbability: 0.58, market: makeMarket({ resolutionRules: NASTY_RULES }) }),
    )
    expect(opp.resolutionRisk.level).toBe('high')
    expect(opp.action).toBe('no_action')
    expect(opp.noActionReasons.some((r) => r.includes('10.0pp'))).toBe(true)
  })

  it('high resolution risk with |edge| ≥ 10pp does NOT trip the high-risk gate', () => {
    const opp = evaluateOpportunity(
      makeParams({ vixeraProbability: 0.65, market: makeMarket({ resolutionRules: NASTY_RULES }) }),
    )
    expect(opp.noActionReasons.some((r) => r.includes('10.0pp'))).toBe(false)
  })

  it('opportunityScore < 45 → no_action even when every hard gate passes', () => {
    const opp = evaluateOpportunity(
      makeParams({
        confidence: 0.5,
        dataQuality: 30,
        modelAgreement: 0.3,
        newsRisk: 0.9,
        historicalCategoryAccuracy: { brierSkill: null, sampleSize: 0 },
        market: makeMarket({ resolutionRules: null }),
      }),
    )
    expect(opp.opportunityScore).toBeLessThan(45)
    expect(opp.action).toBe('no_action')
    // The ONLY reason should be the score gate — every other gate passed.
    expect(opp.noActionReasons).toHaveLength(1)
    expect(opp.noActionReasons[0]).toContain('below the 45 action threshold')
  })
})

describe('evaluateOpportunity — category skill shrinkage', () => {
  it('a category with no history gets no skill bonus (null and n=0 are neutral)', () => {
    const noHistory = evaluateOpportunity(
      makeParams({ historicalCategoryAccuracy: { brierSkill: null, sampleSize: 0 } }),
    )
    const claimedButUnbacked = evaluateOpportunity(
      makeParams({ historicalCategoryAccuracy: { brierSkill: 0.9, sampleSize: 0 } }),
    )
    expect(noHistory.scoreBreakdown['categorySkill']).toBeCloseTo(0.5, 10)
    expect(claimedButUnbacked.scoreBreakdown['categorySkill']).toBeCloseTo(0.5, 10)
  })

  it('skill earns more with more samples behind it', () => {
    const thin = evaluateOpportunity(
      makeParams({ historicalCategoryAccuracy: { brierSkill: 0.3, sampleSize: 5 } }),
    )
    const deep = evaluateOpportunity(
      makeParams({ historicalCategoryAccuracy: { brierSkill: 0.3, sampleSize: 500 } }),
    )
    expect(deep.opportunityScore).toBeGreaterThan(thin.opportunityScore)
  })
})

describe('evaluateOpportunity — adversarial inputs stay bounded', () => {
  it('survives NaN/Infinity/negative inputs with all outputs in range', () => {
    const opp = evaluateOpportunity(
      makeParams({
        vixeraProbability: Number.NaN,
        confidence: Number.POSITIVE_INFINITY,
        dataQuality: -50,
        modelAgreement: 2,
        newsRisk: Number.NaN,
        nowMs: Number.NaN,
        historicalCategoryAccuracy: { brierSkill: Number.POSITIVE_INFINITY, sampleSize: Number.NaN },
        market: makeMarket({
          spread: Number.NaN,
          volume: -100,
          volume24h: Number.POSITIVE_INFINITY,
          liquidity: null,
          outcomes: [makeOutcome({ marketProbability: Number.NaN, bid: null, ask: Number.NaN })],
        }),
        book: null,
      }),
    )
    expect(opp.opportunityScore).toBeGreaterThanOrEqual(0)
    expect(opp.opportunityScore).toBeLessThanOrEqual(100)
    expect(Number.isFinite(opp.edgePp)).toBe(true)
    expect(opp.confidence).toBeGreaterThanOrEqual(0)
    expect(opp.confidence).toBeLessThanOrEqual(1)
    expect(opp.expectedValue).toBeNull()
    expect(opp.liquidity.score).toBeGreaterThanOrEqual(0)
    expect(opp.liquidity.score).toBeLessThanOrEqual(100)
    expect(() => new Date(opp.generatedAt).toISOString()).not.toThrow()
  })

  it('throws only on the genuine programming error: unknown outcomeId', () => {
    expect(() => evaluateOpportunity(makeParams({ outcomeId: 'nope' }))).toThrow(/not found/)
  })
})

describe('rankOpportunities', () => {
  const a = evaluateOpportunity(makeParams({ vixeraProbability: 0.62, nowMs: NOW_MS }))
  const b = evaluateOpportunity(
    makeParams({
      vixeraProbability: 0.72,
      confidence: 0.6,
      nowMs: NOW_MS + 1000,
      market: makeMarket({
        id: 'kalshi:B',
        closeTime: new Date(NOW_MS + 2 * DAY_MS).toISOString(),
        resolutionTime: new Date(NOW_MS + 2 * DAY_MS).toISOString(),
      }),
    }),
  )
  const c = evaluateOpportunity(
    makeParams({
      vixeraProbability: 0.55,
      confidence: 0.9,
      nowMs: NOW_MS + 2000,
      market: makeMarket({ id: 'kalshi:C', closeTime: null, resolutionTime: null }),
    }),
  )
  const list = [a, b, c]

  it('score: descending headline score', () => {
    const ranked = rankOpportunities(list, 'score')
    for (let i = 1; i < ranked.length; i++) {
      expect((ranked[i - 1] as (typeof ranked)[number]).opportunityScore).toBeGreaterThanOrEqual(
        (ranked[i] as (typeof ranked)[number]).opportunityScore,
      )
    }
  })

  it('edge: descending |edge|', () => {
    const ranked = rankOpportunities(list, 'edge')
    expect(ranked[0]?.edgePp).toBeCloseTo(0.22, 10)
    expect(ranked[2]?.edgePp).toBeCloseTo(0.05, 10)
  })

  it('confidence: descending', () => {
    const ranked = rankOpportunities(list, 'confidence')
    expect(ranked[0]?.confidence).toBe(0.9)
    expect(ranked[2]?.confidence).toBe(0.6)
  })

  it('ending_soon: soonest first, unknown horizons last', () => {
    const ranked = rankOpportunities(list, 'ending_soon')
    expect(ranked[0]?.market.id).toBe('kalshi:B')
    expect(ranked[2]?.market.id).toBe('kalshi:C') // null horizon must sort last
  })

  it('newest: most recently generated first', () => {
    const ranked = rankOpportunities(list, 'newest')
    expect(ranked[0]?.generatedAt).toBe(c.generatedAt)
  })

  it('implements every sort in the OpportunitySort union without mutating input', () => {
    const sorts: OpportunitySort[] = [
      'score',
      'edge',
      'confidence',
      'liquidity',
      'risk',
      'ending_soon',
      'newest',
      'probability_change',
    ]
    const snapshot = [...list]
    for (const sort of sorts) {
      const ranked = rankOpportunities(list, sort)
      expect(ranked).toHaveLength(list.length)
      expect(new Set(ranked.map((o) => o.id)).size).toBe(list.length)
    }
    expect(list).toEqual(snapshot)
  })
})
