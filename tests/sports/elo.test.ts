import { describe, expect, it } from 'vitest'

import { InvariantError } from '@/core/errors'
import { FOOTBALL_CONFIG } from '@/engines/sports/config/football'
import {
  DEFAULT_ELO_CONFIG,
  INITIAL_ELO,
  eloExpectedGoalDiff,
  eloExpectedScore,
  eloWinDrawLoss,
  eloWinProbability,
  fitElo,
  getEloEntry,
  goalDiffMultiplier,
  kFactor,
  movMultiplier,
  runEloHistory,
  updateElo,
  type FinishedGame,
} from '@/engines/sports/elo'
import { NOW_MS, makeGame, seededRandom } from './fixtures'

const DAY = 86_400_000

describe('eloWinProbability', () => {
  it('is 0.5 for equal ratings with no home advantage', () => {
    expect(eloWinProbability(1500, 1500, 0)).toBeCloseTo(0.5, 12)
  })

  it('gives the higher-rated side the higher probability, monotonically', () => {
    let previous = 0
    for (const gap of [0, 50, 100, 200, 400]) {
      const p = eloWinProbability(1500 + gap, 1500, 0)
      expect(p).toBeGreaterThanOrEqual(previous)
      previous = p
    }
    expect(eloWinProbability(1700, 1500, 0)).toBeGreaterThan(0.7)
  })

  it('shifts toward the home side with the home advantage offset', () => {
    expect(eloWinProbability(1500, 1500, FOOTBALL_CONFIG.eloHomeAdvantage)).toBeGreaterThan(0.5)
  })
})

describe('eloExpectedGoalDiff', () => {
  it('is linear in the rating gap and zero for equal neutral-venue sides', () => {
    expect(eloExpectedGoalDiff(1500, 1500, 0, 175)).toBe(0)
    expect(eloExpectedGoalDiff(1675, 1500, 0, 175)).toBeCloseTo(1, 12)
    expect(eloExpectedGoalDiff(1500, 1675, 0, 175)).toBeCloseTo(-1, 12)
  })
})

describe('movMultiplier', () => {
  it('treats draws and one-goal margins as the baseline 1.0', () => {
    expect(movMultiplier(0)).toBeCloseTo(1, 12)
    expect(movMultiplier(1)).toBeCloseTo(1, 12)
    expect(movMultiplier(-1)).toBeCloseTo(1, 12)
  })

  it('is monotone increasing in margin', () => {
    for (let m = 1; m < 8; m++) {
      expect(movMultiplier(m + 1)).toBeGreaterThan(movMultiplier(m))
    }
  })

  it('is sub-linear — each extra goal is worth less than the last', () => {
    // Increments must shrink: mov(m+1) − mov(m) strictly decreasing.
    for (let m = 1; m < 8; m++) {
      const stepHere = movMultiplier(m + 1) - movMultiplier(m)
      const stepNext = movMultiplier(m + 2) - movMultiplier(m + 1)
      expect(stepNext).toBeLessThan(stepHere)
    }
    // And a 6-0 is nowhere near six times a 1-0.
    expect(movMultiplier(6)).toBeLessThan(3)
  })
})

describe('updateElo', () => {
  it('is symmetric and zero-sum — the rating pool is conserved exactly', () => {
    const before = {
      'team-a': { rating: 1560, gamesPlayed: 10 },
      'team-b': { rating: 1440, gamesPlayed: 4 },
    }
    const after = updateElo(before, makeGame({ externalId: 'g1', homeScore: 3, awayScore: 1 }), FOOTBALL_CONFIG)
    const sumBefore = before['team-a'].rating + before['team-b'].rating
    const sumAfter = (after['team-a']?.rating ?? 0) + (after['team-b']?.rating ?? 0)
    expect(sumAfter).toBeCloseTo(sumBefore, 9)
    expect(after['team-a']?.gamesPlayed).toBe(11)
    expect(after['team-b']?.gamesPlayed).toBe(5)
  })

  it('moves the winner up and the loser down, more for an upset', () => {
    const ratings = {
      'team-a': { rating: 1600, gamesPlayed: 20 },
      'team-b': { rating: 1400, gamesPlayed: 20 },
    }
    const expectedWin = updateElo(ratings, makeGame({ externalId: 'g1', homeScore: 2, awayScore: 0 }), FOOTBALL_CONFIG)
    const upset = updateElo(ratings, makeGame({ externalId: 'g2', homeScore: 0, awayScore: 2 }), FOOTBALL_CONFIG)
    const winGain = (expectedWin['team-a']?.rating ?? 0) - 1600
    const upsetLoss = 1600 - (upset['team-a']?.rating ?? 0)
    expect(winGain).toBeGreaterThan(0)
    // Losing as a heavy favourite must cost more than winning as one earns.
    expect(upsetLoss).toBeGreaterThan(winGain)
  })

  it('does not mutate the input ratings (pure update)', () => {
    const ratings = { 'team-a': { rating: 1500, gamesPlayed: 0 } }
    updateElo(ratings, makeGame({ externalId: 'g1', homeScore: 1, awayScore: 0 }), FOOTBALL_CONFIG)
    expect(ratings['team-a'].rating).toBe(1500)
  })

  it('rejects games without a final score', () => {
    expect(() =>
      updateElo({}, makeGame({ externalId: 'g1', homeScore: null, awayScore: null }), FOOTBALL_CONFIG),
    ).toThrow(InvariantError)
  })
})

describe('kFactor', () => {
  it('decays from base toward the floor as history accumulates', () => {
    expect(kFactor(0, FOOTBALL_CONFIG)).toBeCloseTo(FOOTBALL_CONFIG.eloKBase, 9)
    expect(kFactor(10, FOOTBALL_CONFIG)).toBeLessThan(kFactor(0, FOOTBALL_CONFIG))
    expect(kFactor(500, FOOTBALL_CONFIG)).toBeCloseTo(FOOTBALL_CONFIG.eloKMin, 3)
  })
})

describe('runEloHistory', () => {
  it('folds a season chronologically and initialises unseen teams at 1500', () => {
    const games = [
      makeGame({ externalId: 'g1', kickoff: NOW_MS - 30 * DAY, homeScore: 2, awayScore: 0 }),
      makeGame({ externalId: 'g2', kickoff: NOW_MS - 23 * DAY, homeTeamId: 'team-b', awayTeamId: 'team-a', homeScore: 0, awayScore: 1 }),
      makeGame({ externalId: 'g3', kickoff: NOW_MS - 16 * DAY, homeScore: 3, awayScore: 1 }),
    ]
    const ratings = runEloHistory(games, FOOTBALL_CONFIG)
    // team-a won all three meetings, so it must sit above 1500 and team-b below.
    expect(getEloEntry(ratings, 'team-a').rating).toBeGreaterThan(INITIAL_ELO)
    expect(getEloEntry(ratings, 'team-b').rating).toBeLessThan(INITIAL_ELO)
    expect(getEloEntry(ratings, 'team-a').gamesPlayed).toBe(3)
    expect(getEloEntry(ratings, 'unseen-team').rating).toBe(INITIAL_ELO)
  })

  it('skips fixtures without a final score but keeps them in the ordering check', () => {
    const games = [
      makeGame({ externalId: 'g1', kickoff: NOW_MS - 10 * DAY, homeScore: 1, awayScore: 0 }),
      makeGame({ externalId: 'g2', kickoff: NOW_MS - 5 * DAY, status: 'scheduled', homeScore: null, awayScore: null }),
    ]
    const ratings = runEloHistory(games, FOOTBALL_CONFIG)
    expect(getEloEntry(ratings, 'team-a').gamesPlayed).toBe(1)
  })

  it('throws InvariantError on shuffled (non-chronological) games — the lookahead guard', () => {
    const games = [
      makeGame({ externalId: 'g1', kickoff: NOW_MS - 5 * DAY, homeScore: 1, awayScore: 0 }),
      makeGame({ externalId: 'g2', kickoff: NOW_MS - 10 * DAY, homeScore: 0, awayScore: 2 }),
    ]
    expect(() => runEloHistory(games, FOOTBALL_CONFIG)).toThrow(InvariantError)
  })
})

// ---------------------------------------------------------------------------
// Batch fitter (EloTable) API
// ---------------------------------------------------------------------------

/** Shorthand FinishedGame builder for the batch-fitter tests. */
function fg(
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number,
  awayScore: number,
  kickoff: number,
): FinishedGame {
  return { homeTeamId, awayTeamId, homeScore, awayScore, kickoff }
}

describe('eloExpectedScore', () => {
  it('is 0.5 for equal ratings at a neutral venue', () => {
    expect(eloExpectedScore(1500, 1500, 0)).toBeCloseTo(0.5, 12)
  })

  it('home advantage shifts the expectation toward the home side', () => {
    expect(eloExpectedScore(1500, 1500, 60)).toBeGreaterThan(0.5)
    // And the exact logistic value: 1/(1+10^(-60/400)).
    expect(eloExpectedScore(1500, 1500, 60)).toBeCloseTo(1 / (1 + 10 ** (-60 / 400)), 12)
  })

  it('is antisymmetric: E(a,b) + E(b,a) = 1 at a neutral venue', () => {
    expect(eloExpectedScore(1620, 1480, 0) + eloExpectedScore(1480, 1620, 0)).toBeCloseTo(1, 12)
  })
})

describe('goalDiffMultiplier', () => {
  it('treats draws and one-goal margins identically (multiplier 1)', () => {
    expect(goalDiffMultiplier(0)).toBe(1)
    expect(goalDiffMultiplier(1)).toBe(1)
    expect(goalDiffMultiplier(-1)).toBe(1)
  })

  it('orders margins with diminishing returns: 1 < 2 < 3, each step smaller', () => {
    const m1 = goalDiffMultiplier(1)
    const m2 = goalDiffMultiplier(2)
    const m3 = goalDiffMultiplier(3)
    expect(m2).toBeGreaterThan(m1)
    expect(m3).toBeGreaterThan(m2)
    expect(m3 - m2).toBeLessThan(m2 - m1) // concavity — the anti-7-0 property
    expect(m2).toBeCloseTo(Math.SQRT2, 12)
  })

  it('is symmetric in sign', () => {
    expect(goalDiffMultiplier(-4)).toBeCloseTo(goalDiffMultiplier(4), 12)
  })
})

describe('fitElo', () => {
  it('matches a hand-computed two-game sequence exactly', () => {
    const t0 = NOW_MS - 30 * DAY
    const table = fitElo([
      fg('A', 'B', 2, 0, t0),
      fg('B', 'A', 1, 1, t0 + 7 * DAY),
    ])

    // Game 1: A at home wins 2-0 from 1500 vs 1500.
    const e1 = 1 / (1 + 10 ** (-60 / 400))
    const d1 = 20 * Math.sqrt(2) * (1 - e1)
    const ratingA1 = 1500 + d1
    const ratingB1 = 1500 - d1

    // Game 2: B at home draws 1-1 (margin 0 → multiplier 1).
    const e2 = 1 / (1 + 10 ** (-(ratingB1 + 60 - ratingA1) / 400))
    const d2 = 20 * 1 * (0.5 - e2)

    expect(table.rating('B')).toBeCloseTo(ratingB1 + d2, 9)
    expect(table.rating('A')).toBeCloseTo(ratingA1 - d2, 9)
    expect(table.gamesRated('A')).toBe(2)
    expect(table.gamesRated('B')).toBe(2)
  })

  it('processes games in kickoff order regardless of input order', () => {
    const t0 = NOW_MS - 30 * DAY
    const chronological = [fg('A', 'B', 3, 0, t0), fg('B', 'A', 2, 0, t0 + DAY)]
    const shuffled = [chronological[1]!, chronological[0]!]
    expect(fitElo(shuffled).rating('A')).toBeCloseTo(fitElo(chronological).rating('A'), 12)
  })

  it('leaves symmetric teams with equal ratings', () => {
    // Exact case: equals drawing at a neutral venue never move.
    const neutral = { ...DEFAULT_ELO_CONFIG, homeAdvantage: 0 }
    const drawn = fitElo([fg('A', 'B', 1, 1, NOW_MS - 10 * DAY)], neutral)
    expect(drawn.rating('A')).toBe(1500)
    expect(drawn.rating('B')).toBe(1500)

    // Mirrored home-and-home (each wins at home by the same margin): the
    // sequential updates are path-dependent, so equality is approximate —
    // but must be tight, and the pool exactly conserved.
    const mirrored = fitElo([
      fg('A', 'B', 1, 0, NOW_MS - 10 * DAY),
      fg('B', 'A', 1, 0, NOW_MS - 3 * DAY),
    ])
    expect(Math.abs(mirrored.rating('A') - mirrored.rating('B'))).toBeLessThan(1.5)
    expect(mirrored.rating('A') + mirrored.rating('B')).toBeCloseTo(3000, 9)
  })

  it('conserves rating points exactly (zero-sum) over a long random history', () => {
    const rand = seededRandom(42)
    const teams = ['A', 'B', 'C', 'D']
    const games: FinishedGame[] = []
    for (let i = 0; i < 60; i++) {
      const home = teams[Math.floor(rand() * teams.length)]!
      let away = teams[Math.floor(rand() * teams.length)]!
      if (away === home) away = teams[(teams.indexOf(home) + 1) % teams.length]!
      games.push(
        fg(home, away, Math.floor(rand() * 5), Math.floor(rand() * 4), NOW_MS - (60 - i) * DAY),
      )
    }
    const table = fitElo(games)
    const total = table.teamIds.reduce((acc, id) => acc + table.rating(id), 0)
    expect(total).toBeCloseTo(table.teamIds.length * 1500, 9)
  })

  it('moves ratings further for bigger margins (GD multiplier ordering)', () => {
    const gains = [1, 2, 3, 6].map(
      (margin) => fitElo([fg('A', 'B', margin, 0, NOW_MS - DAY)]).rating('A') - 1500,
    )
    expect(gains[1]).toBeGreaterThan(gains[0]!)
    expect(gains[2]).toBeGreaterThan(gains[1]!)
    expect(gains[3]).toBeGreaterThan(gains[2]!)
  })

  it('flags unknown teams: default rating, zero games, isRated false', () => {
    const table = fitElo([fg('A', 'B', 1, 0, NOW_MS - DAY)])
    expect(table.rating('ghost')).toBe(1500)
    expect(table.gamesRated('ghost')).toBe(0)
    expect(table.isRated('ghost')).toBe(false)
    expect(table.isRated('A')).toBe(true)
  })

  it('produces a JSON-serialisable snapshot that round-trips', () => {
    const table = fitElo([fg('A', 'B', 2, 1, NOW_MS - DAY)])
    const snapshot = table.snapshot()
    const revived = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot
    expect(revived).toEqual(snapshot)
    expect(revived['A']?.rating).toBeCloseTo(table.rating('A'), 12)
    expect(revived['B']?.games).toBe(1)
  })
})

describe('eloWinDrawLoss', () => {
  it('sums to exactly 1 and follows the Davidson formula', () => {
    const p = eloWinDrawLoss(1560, 1470)
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 12)

    const pHomeRaw = eloExpectedScore(1560, 1470, 60)
    const drawMass = 0.85 * Math.sqrt(pHomeRaw * (1 - pHomeRaw))
    expect(p.draw).toBeCloseTo(drawMass / (1 + drawMass), 12)
    expect(p.home).toBeCloseTo(pHomeRaw / (1 + drawMass), 12)
  })

  it('peaks the draw when teams are evenly matched and decays with the gap', () => {
    const neutral = { ...DEFAULT_ELO_CONFIG, homeAdvantage: 0 }
    const even = eloWinDrawLoss(1500, 1500, neutral)
    const mismatch = eloWinDrawLoss(1750, 1500, neutral)
    expect(even.draw).toBeGreaterThan(mismatch.draw)
    // ν = 0.85 puts the even-match draw at ≈ 0.85·0.5/1.425 ≈ 29.8%.
    expect(even.draw).toBeCloseTo((0.85 * 0.5) / 1.425, 9)
  })

  it('home advantage shifts the 1X2 toward the home side', () => {
    const p = eloWinDrawLoss(1500, 1500)
    expect(p.home).toBeGreaterThan(p.away)
    const neutral = eloWinDrawLoss(1500, 1500, { ...DEFAULT_ELO_CONFIG, homeAdvantage: 0 })
    expect(neutral.home).toBeCloseTo(neutral.away, 12)
  })
})
