import { describe, expect, it } from 'vitest'

import { FOOTBALL_CONFIG } from '@/engines/sports/config/football'
import {
  DEFAULT_FORM_SCORE_CONFIG,
  computeFormScore,
  formRawComposite,
  formScore,
  squashToLeague,
  type FormScoreConfig,
} from '@/engines/sports/form'
import { flatOpponentRatings, makeStats, statsFromResults } from './fixtures'

describe('computeFormScore', () => {
  it('weights recent games more — a W-heavy head beats the same results reversed', () => {
    // Same multiset of results; only the ordering differs. Windows are
    // most-recent-first, so wins at the head are wins NOW.
    const winsRecent = statsFromResults(['W', 'W', 'W', 'L', 'L', 'L'])
    const winsLongAgo = statsFromResults(['L', 'L', 'L', 'W', 'W', 'W'])
    const ratings = flatOpponentRatings(6, 50)

    const recent = computeFormScore(winsRecent, ratings, FOOTBALL_CONFIG)
    const stale = computeFormScore(winsLongAgo, ratings, FOOTBALL_CONFIG)
    expect(recent.score).toBeGreaterThan(stale.score)
  })

  it('credits schedule difficulty — same results against a strong schedule score higher', () => {
    const games = statsFromResults(['W', 'D', 'W', 'D', 'W', 'L'])
    const vsStrong = computeFormScore(games, flatOpponentRatings(6, 80), FOOTBALL_CONFIG)
    const vsWeak = computeFormScore(games, flatOpponentRatings(6, 20), FOOTBALL_CONFIG)
    expect(vsStrong.score).toBeGreaterThan(vsWeak.score)
  })

  it('centres the league-relative squash at ~50 for a median team', () => {
    // All draws with matching xG, against median opposition: every component
    // sits at exactly 0.5, so the raw composite is the configured league
    // median and the logistic must return 50.
    const games = statsFromResults(['D', 'D', 'D', 'D', 'D', 'D'], {
      expectedGoalsFor: 1.2,
      expectedGoalsAgainst: 1.2,
    })
    const form = computeFormScore(games, flatOpponentRatings(6, 50), FOOTBALL_CONFIG)
    expect(form.score).toBeCloseTo(50, 6)
    expect(form.xgAvailable).toBe(true)
  })

  it('redistributes the xG weight when xG is null, keeps the score finite, and flags it', () => {
    // football-data.org free tier: no xG at all.
    const games = statsFromResults(['W', 'W', 'D', 'W', 'L', 'W'])
    const form = computeFormScore(games, flatOpponentRatings(6, 50), FOOTBALL_CONFIG)

    expect(Number.isFinite(form.score)).toBe(true)
    expect(form.xgAvailable).toBe(false)
    expect(form.components.performanceVsExpected).toBeNull()
    // A W-heavy window must still read above median without xG.
    expect(form.score).toBeGreaterThan(50)
  })

  it('flags xgAvailable false when even one game in the window lacks xG', () => {
    const games = [
      makeStats({ gameId: 'g0', result: 'W', scored: 2, conceded: 0, expectedGoalsFor: 1.8, expectedGoalsAgainst: 0.6 }),
      makeStats({ gameId: 'g1', result: 'D', scored: 1, conceded: 1, expectedGoalsFor: null, expectedGoalsAgainst: null }),
    ]
    const form = computeFormScore(games, { g0: 50, g1: 50 }, FOOTBALL_CONFIG)
    expect(form.xgAvailable).toBe(false)
    // But the games that DO have xG still contribute to the component report.
    expect(form.components.performanceVsExpected).not.toBeNull()
  })

  it('punishes fortunate results — winning against the run of xG scores below winning with it', () => {
    // Same 1-0 wins; one team dominated the xG, the other was outshot badly.
    const dominant = statsFromResults(['W', 'W', 'W', 'W'], {
      scored: 1,
      conceded: 0,
      expectedGoalsFor: 2.1,
      expectedGoalsAgainst: 0.4,
    })
    const fortunate = statsFromResults(['W', 'W', 'W', 'W'], {
      scored: 1,
      conceded: 0,
      expectedGoalsFor: 0.4,
      expectedGoalsAgainst: 2.1,
    })
    const ratings = flatOpponentRatings(4, 50)
    const strong = computeFormScore(dominant, ratings, FOOTBALL_CONFIG)
    const lucky = computeFormScore(fortunate, ratings, FOOTBALL_CONFIG)
    expect(strong.score).toBeGreaterThan(lucky.score)
  })

  it('returns the neutral median for an empty window, with sampleSize 0', () => {
    const form = computeFormScore([], {}, FOOTBALL_CONFIG)
    expect(form.score).toBe(50)
    expect(form.sampleSize).toBe(0)
    expect(form.xgAvailable).toBe(false)
  })

  it('treats a missing opponent rating as league-median 50', () => {
    const games = statsFromResults(['W', 'W', 'W'])
    const withRatings = computeFormScore(games, flatOpponentRatings(3, 50), FOOTBALL_CONFIG)
    const withoutRatings = computeFormScore(games, {}, FOOTBALL_CONFIG)
    expect(withoutRatings.score).toBeCloseTo(withRatings.score, 9)
  })

  it('stays within the 0–100 bounds at the extremes', () => {
    const rout = statsFromResults(Array.from({ length: 10 }, () => 'W' as const), { scored: 5, conceded: 0 })
    const collapse = statsFromResults(Array.from({ length: 10 }, () => 'L' as const), { scored: 0, conceded: 5 })
    const high = computeFormScore(rout, flatOpponentRatings(10, 90), FOOTBALL_CONFIG)
    const low = computeFormScore(collapse, flatOpponentRatings(10, 10), FOOTBALL_CONFIG)
    expect(high.score).toBeLessThanOrEqual(100)
    expect(high.score).toBeGreaterThan(85)
    expect(low.score).toBeGreaterThanOrEqual(0)
    expect(low.score).toBeLessThan(15)
  })
})

// ---------------------------------------------------------------------------
// Pure-engine API: formScore / squashToLeague
// ---------------------------------------------------------------------------

/** The tanh goal-difference squash used by the composite, mirrored for hand
 *  computation so the expected values below are independent arithmetic. */
const sd = (diff: number): number => 0.5 * (1 + Math.tanh(diff / 3))

const flatStrength = (value: number) => (_gameId: string): number => value

describe('squashToLeague', () => {
  it('maps the league median to exactly 50 and the quartiles to 25/75', () => {
    // Sorted raws [0.2, 0.4, 0.6, 0.8]: median 0.5, Q1 0.35, Q3 0.65.
    const raws = [0.8, 0.2, 0.6, 0.4]
    expect(squashToLeague(0.5, raws)).toBeCloseTo(50, 9)
    expect(squashToLeague(0.35, raws)).toBeCloseTo(25, 9)
    expect(squashToLeague(0.65, raws)).toBeCloseTo(75, 9)
  })

  it('is monotone in the raw composite', () => {
    const raws = [0.3, 0.45, 0.55, 0.7]
    expect(squashToLeague(0.6, raws)).toBeGreaterThan(squashToLeague(0.5, raws))
  })

  it('falls back to a fixed neutral centre when the league is too small', () => {
    expect(squashToLeague(0.5, [])).toBeCloseTo(50, 9)
    expect(squashToLeague(0.5, [0.4, 0.6])).toBeCloseTo(50, 9)
    expect(squashToLeague(0.7, [])).toBeGreaterThan(50)
  })

  it('survives a degenerate zero-IQR league', () => {
    const identical = [0.5, 0.5, 0.5, 0.5]
    expect(squashToLeague(0.5, identical)).toBeCloseTo(50, 9)
    expect(squashToLeague(0.6, identical)).toBeGreaterThan(50)
    expect(Number.isFinite(squashToLeague(0.6, identical))).toBe(true)
  })
})

describe('formScore', () => {
  it('matches an exact hand-computed score on a 3-game fixture set', () => {
    // Most-recent-first: a 2-0 win (with xG), a 1-1 draw (with xG), a 0-2
    // loss (no xG — its weight redistributes over the other three terms).
    const games = [
      makeStats({ gameId: 'g0', result: 'W', scored: 2, conceded: 0, expectedGoalsFor: 1.8, expectedGoalsAgainst: 0.6 }),
      makeStats({ gameId: 'g1', result: 'D', scored: 1, conceded: 1, expectedGoalsFor: 1.1, expectedGoalsAgainst: 1.4 }),
      makeStats({ gameId: 'g2', result: 'L', scored: 0, conceded: 2 }),
    ]
    const strengthByGame: Record<string, number> = { g0: 0.7, g1: 0.5, g2: 0.3 }

    const result = formScore(games, (gameId) => strengthByGame[gameId] ?? 0.5)

    // Hand computation, per the plan's composite with λ = 0.18.
    const w = [1, Math.exp(-0.18), Math.exp(-0.36)]
    const c0 = 0.4 * 1 + 0.25 * sd(2) + 0.2 * 0.7 + 0.15 * sd(1.2)
    const c1 = 0.4 * 0.5 + 0.25 * sd(0) + 0.2 * 0.5 + 0.15 * sd(-0.3)
    const c2 = (0.4 * 0 + 0.25 * sd(-2) + 0.2 * 0.3) / 0.85
    const raw = (w[0]! * c0 + w[1]! * c1 + w[2]! * c2) / (w[0]! + w[1]! + w[2]!)
    const expected = 100 / (1 + Math.exp(-(raw - 0.5) / 0.12)) // empty-league fallback squash

    expect(result.raw).toBeCloseTo(raw, 12)
    expect(result.score).toBeCloseTo(expected, 9)
    expect(result.sampleSize).toBe(3)
    expect(result.insufficient).toBe(true) // 3 < 5
    expect(result.xgCoverage).toBeCloseTo(2 / 3, 12)
  })

  it('ranks a recent win above the same win five games ago', () => {
    const recentWin = statsFromResults(['W', 'L', 'L', 'L', 'L'])
    const oldWin = statsFromResults(['L', 'L', 'L', 'L', 'W'])
    const recent = formScore(recentWin, flatStrength(0.5))
    const old = formScore(oldWin, flatStrength(0.5))
    expect(recent.score).toBeGreaterThan(old.score)
    expect(recent.insufficient).toBe(false)
    expect(old.insufficient).toBe(false)
  })

  it('flags insufficient below 5 games and clears the flag at 5', () => {
    expect(formScore(statsFromResults(['W', 'W', 'W', 'W']), flatStrength(0.5)).insufficient).toBe(true)
    expect(formScore(statsFromResults(['W', 'W', 'W', 'W', 'W']), flatStrength(0.5)).insufficient).toBe(false)
  })

  it('redistributes the xG weight so the per-game weights still sum to 1', () => {
    // A single xG-less win: composite must be the three available terms
    // divided by their own weight total (0.85) — i.e. renormalised weights
    // 0.40/0.85 + 0.25/0.85 + 0.20/0.85 = 1 exactly, not a silent zero.
    expect((0.4 + 0.25 + 0.2) / 0.85).toBeCloseTo(1, 12)

    const game = makeStats({ gameId: 'g0', result: 'W', scored: 2, conceded: 0 })
    const { raw, components, xgCoverage } = formRawComposite([game], flatStrength(0.6))
    expect(raw).toBeCloseTo((0.4 * 1 + 0.25 * sd(2) + 0.2 * 0.6) / 0.85, 12)
    expect(components.performanceVsExpected).toBeNull()
    expect(xgCoverage).toBe(0)
  })

  it('scores an all-null-xG window identically to explicit renormalised weights', () => {
    const games = statsFromResults(['W', 'D', 'L', 'W', 'D'])
    const viaRedistribution = formScore(games, flatStrength(0.5))

    // The same composite expressed with pre-renormalised three-term weights
    // and a zero xG weight must agree exactly.
    const renormalised: FormScoreConfig = {
      ...DEFAULT_FORM_SCORE_CONFIG,
      weights: {
        resultPoints: 0.4 / 0.85,
        normalizedGoalDiff: 0.25 / 0.85,
        opponentStrength: 0.2 / 0.85,
        performanceVsExpected: 0,
      },
    }
    const viaExplicitWeights = formScore(games, flatStrength(0.5), renormalised)
    expect(viaRedistribution.score).toBeCloseTo(viaExplicitWeights.score, 9)
  })

  it('uses the league-relative squash when league raws are supplied', () => {
    const games = statsFromResults(['W', 'W', 'W', 'W', 'W'])
    const { raw } = formRawComposite(games, flatStrength(0.5))
    // A league whose median sits exactly at this team's raw → score 50.
    const config: FormScoreConfig = {
      ...DEFAULT_FORM_SCORE_CONFIG,
      leagueRaws: [raw - 0.2, raw - 0.05, raw + 0.05, raw + 0.2],
    }
    expect(formScore(games, flatStrength(0.5), config).score).toBeCloseTo(50, 9)
  })

  it('returns the neutral raw for an empty window without dividing by zero', () => {
    const empty = formScore([], flatStrength(0.5))
    expect(empty.raw).toBeCloseTo(0.5, 12)
    expect(empty.insufficient).toBe(true)
    expect(empty.sampleSize).toBe(0)
    expect(empty.components.performanceVsExpected).toBeNull()
  })
})
