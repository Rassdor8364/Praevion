/**
 * Betting-market derivation tests.
 *
 * The core fixture is a small HAND-COMPUTED 3×3 matrix: every expected value
 * below was worked out on paper from the cell probabilities, so a regression
 * here means the derivation itself changed, not that a snapshot drifted.
 * Coherence properties are then checked on a real Dixon–Coles matrix.
 */

import { describe, expect, it } from 'vitest'

import {
  ASIAN_LINES,
  asianHandicapSettlement,
  deriveBetMarkets,
  fairAsianOdds,
  matrixToAsianHandicaps,
  matrixToBttsProbs,
  matrixToCorrectScores,
  matrixToDoubleChance,
  matrixToDrawNoBet,
  matrixToEuropeanHandicap,
  matrixToExpectedGoals,
  matrixToOneXTwo,
  matrixToTeamTotal,
  matrixToTotal,
} from '@/engines/sports/bet-markets'
import { scoreMatrix } from '@/engines/sports/poisson'

/**
 * Hand-computed fixture. Margin distribution:
 *   M=-2: 0.02   M=-1: 0.13   M=0: 0.38   M=+1: 0.27   M=+2: 0.20
 * 1X2: home 0.47, draw 0.38, away 0.15.
 */
const M = [
  [0.1, 0.08, 0.02],
  [0.15, 0.2, 0.05],
  [0.2, 0.12, 0.08],
] as const

describe('1X2 / double chance / draw no bet', () => {
  it('reads 1X2 off the matrix (hand-computed)', () => {
    const r = matrixToOneXTwo(M)
    expect(r.home).toBeCloseTo(0.47, 12)
    expect(r.draw).toBeCloseTo(0.38, 12)
    expect(r.away).toBeCloseTo(0.15, 12)
  })

  it('double chance is the pairwise sums', () => {
    const r = matrixToDoubleChance(M)
    expect(r.homeOrDraw).toBeCloseTo(0.85, 12)
    expect(r.homeOrAway).toBeCloseTo(0.62, 12)
    expect(r.drawOrAway).toBeCloseTo(0.53, 12)
  })

  it('draw no bet conditions on a decisive result and reports the push mass', () => {
    const r = matrixToDrawNoBet(M)
    expect(r.home).toBeCloseTo(0.47 / 0.62, 12)
    expect(r.away).toBeCloseTo(0.15 / 0.62, 12)
    expect(r.pushProbability).toBeCloseTo(0.38, 12)
    expect(r.home + r.away).toBeCloseTo(1, 12)
  })
})

describe('BTTS and totals', () => {
  it('BTTS yes = P(h>0 and a>0) (hand-computed)', () => {
    const r = matrixToBttsProbs(M)
    expect(r.yes).toBeCloseTo(0.45, 12)
    expect(r.no).toBeCloseTo(0.55, 12)
  })

  it('half-line total has no push and matches the hand-computed split', () => {
    const r = matrixToTotal(M, 2.5)
    expect(r.over).toBeCloseTo(0.25, 12)
    expect(r.under).toBeCloseTo(0.75, 12)
    expect(r.pushProbability).toBe(0)
  })

  it('integer total excludes the push mass before normalising', () => {
    // goals>2: 0.25; goals<2: 0.33; goals=2: 0.42.
    const r = matrixToTotal(M, 2)
    expect(r.pushProbability).toBeCloseTo(0.42, 12)
    expect(r.over).toBeCloseTo(0.25 / 0.58, 12)
    expect(r.under).toBeCloseTo(0.33 / 0.58, 12)
  })

  it('team totals read one marginal (hand-computed)', () => {
    const home = matrixToTeamTotal(M, 'home', 1.5)
    expect(home.over).toBeCloseTo(0.4, 12) // P(h >= 2)
    expect(home.under).toBeCloseTo(0.6, 12)

    const homeInt = matrixToTeamTotal(M, 'home', 1)
    expect(homeInt.pushProbability).toBeCloseTo(0.4, 12) // P(h = 1)
    expect(homeInt.over).toBeCloseTo(0.4 / 0.6, 12)

    const away = matrixToTeamTotal(M, 'away', 0.5)
    expect(away.over).toBeCloseTo(0.55, 12) // P(a >= 1)
  })
})

describe('correct scores', () => {
  it('returns top scorelines deterministically ordered with honest remainder', () => {
    const r = matrixToCorrectScores(M, 3)
    // 1-1 and 2-0 tie at 0.20; the tiebreak is home goals ascending.
    expect(r.top[0]).toEqual({ home: 1, away: 1, probability: expect.closeTo(0.2, 12) })
    expect(r.top[1]).toEqual({ home: 2, away: 0, probability: expect.closeTo(0.2, 12) })
    expect(r.top[2]).toEqual({ home: 1, away: 0, probability: expect.closeTo(0.15, 12) })
    expect(r.otherProbability).toBeCloseTo(0.45, 12)
  })
})

describe('expected goals', () => {
  it('is the marginal mean of each side (hand-computed)', () => {
    const r = matrixToExpectedGoals(M)
    expect(r.home).toBeCloseTo(1.2, 12)
    expect(r.away).toBeCloseTo(0.7, 12)
    expect(r.total).toBeCloseTo(1.9, 12)
  })
})

describe('Asian handicap settlement', () => {
  it('level line (0): win/push/loss are the margin masses', () => {
    const s = asianHandicapSettlement(M, 0)
    expect(s.fullWin).toBeCloseTo(0.47, 12)
    expect(s.push).toBeCloseTo(0.38, 12)
    expect(s.fullLoss).toBeCloseTo(0.15, 12)
    expect(s.halfWin).toBe(0)
    expect(s.halfLoss).toBe(0)
  })

  it('half line (-0.5): no push, home must win outright', () => {
    const s = asianHandicapSettlement(M, -0.5)
    expect(s.fullWin).toBeCloseTo(0.47, 12)
    expect(s.fullLoss).toBeCloseTo(0.53, 12)
    expect(s.push).toBe(0)
  })

  it('integer line (-1): a one-goal win pushes', () => {
    const s = asianHandicapSettlement(M, -1)
    expect(s.fullWin).toBeCloseTo(0.2, 12) // M >= 2
    expect(s.push).toBeCloseTo(0.27, 12) // M = 1
    expect(s.fullLoss).toBeCloseTo(0.53, 12) // M <= 0
  })

  it('quarter line (-0.75): half stake at -0.5, half at -1 (hand-computed)', () => {
    const s = asianHandicapSettlement(M, -0.75)
    expect(s.fullWin).toBeCloseTo(0.2, 12) // M >= 2: both halves win
    expect(s.halfWin).toBeCloseTo(0.27, 12) // M = 1: -0.5 wins, -1 pushes
    expect(s.halfLoss).toBeCloseTo(0, 12)
    expect(s.fullLoss).toBeCloseTo(0.53, 12) // M <= 0: both lose
    expect(s.push).toBe(0)
  })

  it('quarter line (+0.25): a draw wins half (hand-computed)', () => {
    const s = asianHandicapSettlement(M, 0.25)
    expect(s.fullWin).toBeCloseTo(0.47, 12)
    expect(s.halfWin).toBeCloseTo(0.38, 12) // M = 0: 0 pushes, +0.5 wins
    expect(s.fullLoss).toBeCloseTo(0.15, 12)
  })

  it('quarter line (-0.25): a draw loses half (hand-computed)', () => {
    const s = asianHandicapSettlement(M, -0.25)
    expect(s.fullWin).toBeCloseTo(0.47, 12)
    expect(s.halfLoss).toBeCloseTo(0.38, 12) // M = 0: 0 pushes, -0.5 loses
    expect(s.fullLoss).toBeCloseTo(0.15, 12)
  })

  it('settlement outcomes always sum to 1 across the whole line ladder', () => {
    for (const line of ASIAN_LINES) {
      const s = asianHandicapSettlement(M, line)
      expect(s.fullWin + s.halfWin + s.push + s.halfLoss + s.fullLoss).toBeCloseTo(1, 12)
    }
  })

  it('away side is the exact mirror of the home side', () => {
    const ladder = matrixToAsianHandicaps(M)
    for (const entry of ladder) {
      expect(entry.away.line).toBeCloseTo(-entry.home.line, 12)
      expect(entry.away.fullWin).toBeCloseTo(entry.home.fullLoss, 12)
      expect(entry.away.halfWin).toBeCloseTo(entry.home.halfLoss, 12)
      expect(entry.away.push).toBeCloseTo(entry.home.push, 12)
    }
  })

  it('fair Asian odds are the EV-zero price (hand-computed for -0.75)', () => {
    const s = asianHandicapSettlement(M, -0.75)
    // winMass = 0.20 + 0.27/2 = 0.335; lossMass = 0.53; d = 1 + 0.53/0.335.
    expect(fairAsianOdds(s)).toBeCloseTo(1 + 0.53 / 0.335, 12)
    // EV at the fair price is zero by construction.
    const d = fairAsianOdds(s)
    const ev =
      s.fullWin * (d - 1) + (s.halfWin * (d - 1)) / 2 - s.halfLoss / 2 - s.fullLoss
    expect(ev).toBeCloseTo(0, 12)
  })

  it('rejects lines that are not multiples of 0.25', () => {
    expect(() => asianHandicapSettlement(M, -0.6)).toThrow(/multiple of 0.25/)
  })
})

describe('European handicap', () => {
  it('shifts the margin and stays 3-way (hand-computed)', () => {
    const r = matrixToEuropeanHandicap(M, -1)
    expect(r.home).toBeCloseTo(0.2, 12) // M >= 2
    expect(r.draw).toBeCloseTo(0.27, 12) // M = 1
    expect(r.away).toBeCloseTo(0.53, 12)
  })

  it('rejects non-integer lines', () => {
    expect(() => matrixToEuropeanHandicap(M, -0.5)).toThrow(/integer/)
  })
})

describe('coherence on a real Dixon–Coles matrix', () => {
  const dc = scoreMatrix(1.48, 1.1)
  const markets = deriveBetMarkets(dc)

  it('every two-way and three-way market sums to 1', () => {
    const { oneXTwo, btts, drawNoBet } = markets
    expect(oneXTwo.home + oneXTwo.draw + oneXTwo.away).toBeCloseTo(1, 9)
    expect(btts.yes + btts.no).toBeCloseTo(1, 9)
    expect(drawNoBet.home + drawNoBet.away).toBeCloseTo(1, 9)
    for (const t of markets.totals) expect(t.over + t.under).toBeCloseTo(1, 9)
    for (const e of markets.europeanHandicap) {
      expect(e.home + e.draw + e.away).toBeCloseTo(1, 9)
    }
  })

  it('markets are mutually coherent because they share one distribution', () => {
    // Double chance must equal the 1X2 sums exactly.
    expect(markets.doubleChance.homeOrDraw).toBeCloseTo(
      markets.oneXTwo.home + markets.oneXTwo.draw,
      12,
    )
    // AH -0.5 home win probability must equal the 1X2 home win.
    const minusHalf = markets.asianHandicap.find((l) => l.line === -0.5)
    expect(minusHalf?.home.fullWin).toBeCloseTo(markets.oneXTwo.home, 12)
    // AH 0 push probability must equal the draw.
    const level = markets.asianHandicap.find((l) => l.line === 0)
    expect(level?.home.push).toBeCloseTo(markets.oneXTwo.draw, 12)
    // European handicap 0 IS the 1X2.
    const euroLevel = markets.europeanHandicap.find((l) => l.line === 0)
    expect(euroLevel?.home).toBeCloseTo(markets.oneXTwo.home, 12)
  })

  it('over probability decreases monotonically up the total-goals ladder', () => {
    const overs = markets.totals.map((t) => t.over)
    for (let i = 1; i < overs.length; i++) {
      expect(overs[i] ?? 0).toBeLessThan(overs[i - 1] ?? 0)
    }
  })

  it('home cover probability decreases as the handicap gets harsher', () => {
    // Effective win mass (full + half/2) must be non-increasing from +2 down
    // to -2 — giving away more goals can never make covering easier.
    const ladder = [...markets.asianHandicap].sort((a, b) => b.line - a.line)
    let prev = Infinity
    for (const entry of ladder) {
      const winMass = entry.home.fullWin + entry.home.halfWin / 2
      expect(winMass).toBeLessThanOrEqual(prev + 1e-12)
      prev = winMass
    }
  })

  it('expected goals matches the input lambdas closely at maxGoals 10', () => {
    const eg = matrixToExpectedGoals(dc)
    // τ redistributes within the low-score corner and truncation is ~1e-5,
    // so the marginal means sit within a few hundredths of the λs.
    expect(eg.home).toBeCloseTo(1.48, 1)
    expect(eg.away).toBeCloseTo(1.1, 1)
  })

  it('correct-score list plus remainder covers the full distribution', () => {
    const cs = matrixToCorrectScores(dc, 10)
    const covered = cs.top.reduce((acc, c) => acc + c.probability, 0)
    expect(covered + cs.otherProbability).toBeCloseTo(1, 9)
  })
})
