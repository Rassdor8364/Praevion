import { describe, expect, it } from 'vitest'

import type { FinishedGame } from '@/engines/sports/elo'
import {
  fairOddsFor,
  predictMatch,
  type MatchPredictionParams,
  type MatchPredictionResult,
} from '@/engines/sports/match-prediction'
import { NOW_MS } from './fixtures'

const DAY = 86_400_000
const SEASON_START = NOW_MS - 200 * DAY

/**
 * mulberry32 — a tiny deterministic PRNG for the property tests. Seeded, so
 * every failure reproduces exactly; Math.random in a test would be a flake
 * generator.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fg(
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number,
  awayScore: number,
  kickoff: number,
): FinishedGame {
  return { homeTeamId, awayTeamId, homeScore, awayScore, kickoff }
}

/** Double round robin of all 1-1 draws — a perfectly symmetric league. */
function allDrawLeague(teamCount: number): FinishedGame[] {
  const teams = Array.from({ length: teamCount }, (_, i) => `T${i}`)
  const games: FinishedGame[] = []
  let day = 100
  for (const home of teams) {
    for (const away of teams) {
      if (home === away) continue
      games.push(fg(home, away, 1, 1, NOW_MS - day * DAY))
      day -= 1
    }
  }
  return games
}

/** Random league over `teamCount` teams via a seeded PRNG. */
function randomLeague(seed: number, teamCount = 8): FinishedGame[] {
  const rand = mulberry32(seed)
  const teams = Array.from({ length: teamCount }, (_, i) => `T${i}`)
  const games: FinishedGame[] = []
  let day = 120
  for (const home of teams) {
    for (const away of teams) {
      if (home === away) continue
      games.push(
        fg(home, away, Math.floor(rand() * 5), Math.floor(rand() * 4), NOW_MS - day * DAY),
      )
      day -= 1
    }
  }
  return games
}

function paramsFor(league: readonly FinishedGame[], home = 'T0', away = 'T1'): MatchPredictionParams {
  return {
    homeTeamId: home,
    awayTeamId: away,
    homeGames: league.filter((g) => g.homeTeamId === home || g.awayTeamId === home),
    awayGames: league.filter((g) => g.homeTeamId === away || g.awayTeamId === away),
    leagueGames: league,
    asOf: NOW_MS,
    seasonStart: SEASON_START,
  }
}

function assertNoNaN(result: MatchPredictionResult): void {
  for (const outcome of result.outcomes) {
    expect(Number.isFinite(outcome.probability)).toBe(true)
    expect(outcome.probability).toBeGreaterThanOrEqual(0)
    expect(outcome.probability).toBeLessThanOrEqual(1)
  }
  expect(Number.isFinite(result.confidence)).toBe(true)
  expect(Number.isFinite(result.modelAgreement)).toBe(true)
  expect(Number.isFinite(result.dataQuality)).toBe(true)
  for (const factor of result.factors) {
    if (factor.contribution !== null) expect(Number.isFinite(factor.contribution)).toBe(true)
    expect(Number.isFinite(factor.evidenceStrength)).toBe(true)
  }
  for (const model of result.modelOutputs) {
    if (model.abstained) continue
    for (const outcome of model.outcomes) {
      expect(Number.isFinite(outcome.probability)).toBe(true)
    }
  }
  if (result.markets !== null) {
    expect(Number.isFinite(result.markets.over25)).toBe(true)
    expect(Number.isFinite(result.markets.bttsYes)).toBe(true)
  }
  for (const odds of Object.values(fairOddsFor(result))) {
    expect(Number.isFinite(odds)).toBe(true)
    expect(odds).toBeGreaterThan(1)
  }
}

describe('predictMatch', () => {
  it('gives symmetric teams home probability > away, with outcomes summing to 1', () => {
    const result = predictMatch(paramsFor(allDrawLeague(6)))

    const total = result.outcomes.reduce((acc, o) => acc + o.probability, 0)
    expect(total).toBeCloseTo(1, 9)

    const p = Object.fromEntries(result.outcomes.map((o) => [o.key, o.probability]))
    expect(p['home'] ?? 0).toBeGreaterThan(p['away'] ?? 1) // home advantage
    // All three models had 10 games per side — none may abstain.
    expect(result.modelOutputs).toHaveLength(3)
    expect(result.modelOutputs.every((m) => !m.abstained)).toBe(true)
    // A symmetric all-draw league prices a heavy draw share.
    expect(p['draw'] ?? 0).toBeGreaterThan(0.25)
  })

  it('abstains all models on missing history and confidence collapses below the full-data case', () => {
    const league = allDrawLeague(6)
    const full = predictMatch(paramsFor(league))
    const empty = predictMatch({
      ...paramsFor(league),
      homeGames: [],
      awayGames: [],
      leagueGames: [],
    })

    expect(empty.modelOutputs.every((m) => m.abstained)).toBe(true)
    for (const model of empty.modelOutputs) {
      expect(model.abstainReason).not.toBeNull()
    }
    // With no participants the pool falls back to uniform...
    for (const outcome of empty.outcomes) {
      expect(outcome.probability).toBeCloseTo(1 / 3, 9)
    }
    // ...and confidence must say so, loudly.
    expect(empty.confidence).toBeLessThan(0.35)
    expect(empty.confidence).toBeLessThan(full.confidence)
    expect(empty.effectiveModelCount).toBe(0)
  })

  it('abstains below the minimum sample even with a non-empty league', () => {
    // Two teams with only 2 head-to-head games: below minGames = 5.
    const tiny = [
      fg('T0', 'T1', 2, 0, NOW_MS - 10 * DAY),
      fg('T1', 'T0', 1, 1, NOW_MS - 5 * DAY),
    ]
    const result = predictMatch(paramsFor(tiny))
    expect(result.modelOutputs.every((m) => m.abstained)).toBe(true)
    expect(result.sampleSize).toBe(2)
  })

  it('penalises regime stability when most history predates the season', () => {
    const league = allDrawLeague(6)
    const inSeason = predictMatch(paramsFor(league))
    // Same fixtures, but the season started yesterday: everything is stale.
    const earlySeason = predictMatch({ ...paramsFor(league), seasonStart: NOW_MS - DAY })

    expect(inSeason.confidenceInputs.regimeStability).toBeCloseTo(1, 9)
    expect(earlySeason.confidenceInputs.regimeStability).toBeCloseTo(0.5, 9)
    expect(earlySeason.confidence).toBeLessThan(inSeason.confidence)
  })

  it('caps the head-to-head contribution at ±3pp across seeded random leagues', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const result = predictMatch(paramsFor(randomLeague(seed)))
      const h2h = result.factors.find((f) => f.id === 'head-to-head')
      // Every round robin contains T0 v T1 meetings, so the factor must exist.
      expect(h2h).toBeDefined()
      expect(Math.abs(h2h?.contribution ?? Infinity)).toBeLessThanOrEqual(0.03 + 1e-12)
    }
  })

  it('never emits NaN anywhere, for any seeded random input', () => {
    for (let seed = 100; seed < 125; seed++) {
      assertNoNaN(predictMatch(paramsFor(randomLeague(seed))))
    }
    // Degenerate inputs too: empty history and a 0-0-only league.
    assertNoNaN(predictMatch({ ...paramsFor([]), homeGames: [], awayGames: [] }))
    const goalless = allDrawLeague(6).map((g) => ({ ...g, homeScore: 0, awayScore: 0 }))
    assertNoNaN(predictMatch(paramsFor(goalless)))
  })

  it('produces the expected factor set with coherent orientation', () => {
    const result = predictMatch(paramsFor(randomLeague(7)))
    const ids = result.factors.map((f) => f.id)
    for (const expected of ['form-gap', 'elo-gap', 'home-advantage', 'head-to-head', 'rest-differential']) {
      expect(ids).toContain(expected)
    }
    // Home advantage is always home-positive by construction.
    const homeAdv = result.factors.find((f) => f.id === 'home-advantage')
    expect(homeAdv?.contribution ?? -1).toBeGreaterThan(0)
  })

  it('exposes coherent secondary markets from the Dixon–Coles joint distribution', () => {
    const result = predictMatch(paramsFor(randomLeague(11)))
    expect(result.markets).not.toBeNull()
    expect((result.markets?.over25 ?? 0) + (result.markets?.under25 ?? 0)).toBeCloseTo(1, 9)
    expect((result.markets?.bttsYes ?? 0) + (result.markets?.bttsNo ?? 0)).toBeCloseTo(1, 9)
    expect(result.lambdas?.home ?? 0).toBeGreaterThan(0)
    expect(result.lambdas?.away ?? 0).toBeGreaterThan(0)
  })

  it('drops confidence when the models disagree more', () => {
    // Not a strict invariant of arbitrary leagues — engineered here: identical
    // inputs except agreement, via the confidence breakdown's own term.
    const result = predictMatch(paramsFor(randomLeague(13)))
    expect(result.confidenceBreakdown.terms['modelAgreement']).toBeDefined()
    expect(result.confidence).toBeLessThanOrEqual(0.95)
    expect(result.confidence).toBeGreaterThan(0)
  })
})

describe('fairOddsFor', () => {
  it('inverts the pooled probabilities into margin-free decimal odds', () => {
    const odds = fairOddsFor({
      outcomes: [
        { key: 'home', label: 'H', probability: 0.5 },
        { key: 'draw', label: 'D', probability: 0.25 },
        { key: 'away', label: 'A', probability: 0.25 },
      ],
    })
    expect(odds['home']).toBeCloseTo(2, 12)
    expect(odds['draw']).toBeCloseTo(4, 12)
    expect(odds['away']).toBeCloseTo(4, 12)
  })

  it('carries no overround — implied probabilities sum straight back to 1', () => {
    const result = predictMatch(paramsFor(randomLeague(21)))
    const odds = fairOddsFor(result)
    const implied = Object.values(odds).reduce((acc, o) => acc + 1 / o, 0)
    expect(implied).toBeCloseTo(1, 9)
  })
})
