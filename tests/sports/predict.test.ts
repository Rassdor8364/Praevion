import { describe, expect, it } from 'vitest'

import { fixedClock } from '@/core/clock'
import { assertValidPrediction } from '@/core/prediction/builder'
import type { ModelContext } from '@/engines/model'
import { computeAbsenceImpact, MIN_SUBSET_GAMES } from '@/engines/sports/absence'
import { predictMatch } from '@/engines/sports/predict'
import { computeFormScore } from '@/engines/sports/form'
import { computeTeamStrength } from '@/engines/sports/strength'
import { FOOTBALL_CONFIG } from '@/engines/sports/config/football'
import {
  NOW_MS,
  flatOpponentRatings,
  makeFeatures,
  makeInjury,
  makeSourceRef,
  statsFromResults,
} from './fixtures'

const ctx: ModelContext = { nowMs: NOW_MS, runId: 'test-run' }
const clock = fixedClock(NOW_MS)
const sources = [makeSourceRef()]

describe('predictMatch', () => {
  it('produces a structurally valid VixeraPrediction', () => {
    const prediction = predictMatch(makeFeatures(), ctx, clock, sources)

    // buildPrediction asserts internally; assert again explicitly since this
    // is the contract under test.
    expect(() => assertValidPrediction(prediction)).not.toThrow()
    expect(prediction.domain).toBe('sports')
    expect(prediction.timeframe).toBe('event')
    expect(prediction.subject).toBe('game:pl-2026-0142')
    expect(prediction.outcomes.map((o) => o.key)).toEqual(['home', 'draw', 'away'])
    expect(prediction.modelOutputs).toHaveLength(2)
    expect(prediction.dataMode).toBe('live')
    expect(prediction.supportingFactors.length + prediction.opposingFactors.length).toBeGreaterThan(0)
  })

  it('falls back to uniform outcomes with near-zero confidence when both models abstain', () => {
    const features = makeFeatures({
      homeStats: statsFromResults(['W', 'L']),
      awayStats: statsFromResults(['D', 'W']),
      homeElo: null,
      awayElo: null,
      h2h: null,
    })
    const prediction = predictMatch(features, ctx, clock, sources)

    expect(() => assertValidPrediction(prediction)).not.toThrow()
    expect(prediction.modelOutputs.every((m) => m.abstained)).toBe(true)
    for (const outcome of prediction.outcomes) {
      expect(outcome.probability).toBeCloseTo(1 / 3, 9)
    }
    expect(prediction.confidence).toBeLessThan(0.15)
    expect(prediction.modelAgreement).toBe(0)
  })

  it('favours the clearly stronger home team', () => {
    const features = makeFeatures({
      homeStats: statsFromResults(Array.from({ length: 10 }, () => 'W' as const), { scored: 3, conceded: 0 }),
      awayStats: statsFromResults(Array.from({ length: 10 }, () => 'L' as const), { scored: 0, conceded: 3 }),
      homeElo: { rating: 1680, gamesPlayed: 25 },
      awayElo: { rating: 1380, gamesPlayed: 25 },
    })
    const prediction = predictMatch(features, ctx, clock, sources)

    const home = prediction.outcomes.find((o) => o.key === 'home')?.probability ?? 0
    const away = prediction.outcomes.find((o) => o.key === 'away')?.probability ?? 0
    expect(home).toBeGreaterThan(away)
    expect(home).toBeGreaterThan(0.5)
  })

  it('reports higher confidence for deep unanimous evidence than for thin evidence', () => {
    const rich = predictMatch(makeFeatures(), ctx, clock, sources)
    const thin = predictMatch(
      makeFeatures({
        homeStats: statsFromResults(['W', 'D', 'L', 'W', 'D']),
        awayStats: statsFromResults(['L', 'D', 'W', 'L', 'D']),
        homeElo: null,
        awayElo: null,
        h2h: null,
      }),
      ctx,
      clock,
      sources,
    )
    expect(rich.confidence).toBeGreaterThan(thin.confidence)
  })

  it('shrinks head-to-head hard — a lopsided H2H nudges rather than dominates', () => {
    const base = makeFeatures({ h2h: null })
    const withH2h = makeFeatures({ h2h: { homeWins: 5, draws: 0, awayWins: 0 } })

    const without = predictMatch(base, ctx, clock, sources)
    const withPrediction = predictMatch(withH2h, ctx, clock, sources)

    const factor = [...withPrediction.supportingFactors, ...withPrediction.opposingFactors].find(
      (f) => f.id === 'head-to-head',
    )
    expect(factor).toBeDefined()
    // Five straight H2H wins is a >0.6 raw edge over the prior; after the
    // priorWeight-8 shrink the residual factor must stay small (§7: do NOT
    // overweight H2H).
    expect(Math.abs(factor?.contribution ?? 1)).toBeLessThan(0.25)
    // And the H2H factor is explanatory only — the pooled outcome
    // probabilities do not change.
    expect(withPrediction.outcomes).toEqual(without.outcomes)
  })

  it('propagates demo provenance into dataMode', () => {
    const prediction = predictMatch(makeFeatures(), ctx, clock, [makeSourceRef({ isDemo: true })])
    expect(prediction.dataMode).toBe('demo')
  })
})

describe('computeTeamStrength (integration with form)', () => {
  it('returns null depth and redistributes rather than fabricating a 50', () => {
    const games = statsFromResults(['W', 'W', 'D', 'W', 'L', 'W', 'D', 'W'])
    const form = computeFormScore(games, flatOpponentRatings(8, 50), FOOTBALL_CONFIG)
    const strength = computeTeamStrength(
      { games, form, injuries: [], venue: 'home' },
      { homeGoals: 1.52, awayGoals: 1.2 },
      FOOTBALL_CONFIG,
    )
    expect(strength.components.depth).toBeNull()
    expect(strength.computedComponents).not.toContain('depth')
    expect(strength.computedComponents).toEqual(
      expect.arrayContaining(['attack', 'defense', 'form', 'health', 'homeAway', 'momentum']),
    )
    expect(strength.overall).toBeGreaterThan(50) // a winning side reads above median
  })

  it('penalises health for confirmed absences more than for doubts', () => {
    const games = statsFromResults(['D', 'D', 'D', 'D'])
    const base = { games, form: null, injuries: [], venue: 'home' as const }
    const healthy = computeTeamStrength(base, { homeGoals: 1.5, awayGoals: 1.2 }, FOOTBALL_CONFIG)
    const doubts = computeTeamStrength(
      { ...base, injuries: [makeInjury({ playerId: 'p1', status: 'doubtful' })] },
      { homeGoals: 1.5, awayGoals: 1.2 },
      FOOTBALL_CONFIG,
    )
    const out = computeTeamStrength(
      { ...base, injuries: [makeInjury({ playerId: 'p1', status: 'out' })] },
      { homeGoals: 1.5, awayGoals: 1.2 },
      FOOTBALL_CONFIG,
    )
    expect(healthy.components.health).toBe(100)
    expect(doubts.components.health ?? 0).toBeGreaterThan(out.components.health ?? 0)
    expect(out.components.health ?? 100).toBeLessThan(100)
  })
})

describe('computeAbsenceImpact', () => {
  it('reports insufficient data below the subset minimum instead of a number', () => {
    const impact = computeAbsenceImpact({
      withPlayer: statsFromResults(['W', 'W', 'W', 'W', 'W', 'W']),
      withoutPlayer: statsFromResults(['L', 'L', 'L']), // 3 < MIN_SUBSET_GAMES
      minutesShare: 0.9,
    })
    expect(impact.reliable).toBe(false)
    expect(impact.offensiveImpactPct).toBeNull()
    expect(impact.winProbabilityImpactPp).toBeNull()
    expect(impact.sampleSize).toBe(3)
    expect(MIN_SUBSET_GAMES).toBe(4)
  })

  it('measures a positive impact for a player whose presence coincides with wins', () => {
    const impact = computeAbsenceImpact({
      withPlayer: statsFromResults(Array.from({ length: 8 }, () => 'W' as const), { scored: 2 }),
      withoutPlayer: statsFromResults(Array.from({ length: 8 }, () => 'L' as const), { scored: 1 }),
      minutesShare: 0.8,
    })
    expect(impact.reliable).toBe(true)
    expect(impact.offensiveImpactPct ?? 0).toBeGreaterThan(0)
    expect(impact.winProbabilityImpactPp ?? 0).toBeGreaterThan(0)
  })

  it('caps the credited impact by minutes share', () => {
    const subsets = {
      withPlayer: statsFromResults(Array.from({ length: 10 }, () => 'W' as const), { scored: 3 }),
      withoutPlayer: statsFromResults(Array.from({ length: 10 }, () => 'L' as const), { scored: 1 }),
    }
    const fullTime = computeAbsenceImpact({ ...subsets, minutesShare: 1 })
    const bitPart = computeAbsenceImpact({ ...subsets, minutesShare: 0.2 })
    // Identical evidence, but the bit-part player can only own a fifth of it.
    expect(Math.abs(bitPart.offensiveImpactPct ?? 0)).toBeLessThan(
      Math.abs(fullTime.offensiveImpactPct ?? 0),
    )
    expect(Math.abs(bitPart.winProbabilityImpactPp ?? 0)).toBeLessThan(
      Math.abs(fullTime.winProbabilityImpactPp ?? 0),
    )
  })
})
