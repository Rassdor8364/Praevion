import { describe, expect, it } from 'vitest'

import { InsufficientDataError, InvariantError } from '@/core/errors'
import type { FinishedGame } from '@/engines/sports/elo'
import {
  DEFAULT_RHO,
  expectedGoals,
  fitAttackDefence,
  matrixToOutcomes,
  poissonPmf,
  scoreMatrix,
} from '@/engines/sports/poisson'
import { NOW_MS } from './fixtures'

const DAY = 86_400_000

function fg(
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number,
  awayScore: number,
  kickoff: number,
): FinishedGame {
  return { homeTeamId, awayTeamId, homeScore, awayScore, kickoff }
}

describe('poissonPmf', () => {
  it('matches hand-computed values', () => {
    // P(X=2 | λ=1.4) = e^−1.4 · 1.4² / 2! = e^−1.4 · 0.98 ≈ 0.241665.
    expect(poissonPmf(2, 1.4)).toBeCloseTo((Math.exp(-1.4) * 1.4 ** 2) / 2, 12)
    expect(poissonPmf(2, 1.4)).toBeCloseTo(0.2416650245, 8)
    // P(X=0 | λ) = e^−λ; P(X=1 | λ) = λ·e^−λ.
    expect(poissonPmf(0, 2.3)).toBeCloseTo(Math.exp(-2.3), 12)
    expect(poissonPmf(1, 0.7)).toBeCloseTo(0.7 * Math.exp(-0.7), 12)
    // P(X=5 | λ=2.5) = e^−2.5 · 2.5⁵ / 120.
    expect(poissonPmf(5, 2.5)).toBeCloseTo((Math.exp(-2.5) * 2.5 ** 5) / 120, 12)
  })

  it('sums to 1 over its support', () => {
    let total = 0
    for (let k = 0; k <= 40; k++) total += poissonPmf(k, 2.5)
    expect(total).toBeCloseTo(1, 9)
  })

  it('rejects non-integer k and non-positive λ', () => {
    expect(() => poissonPmf(1.5, 1)).toThrow(InvariantError)
    expect(() => poissonPmf(-1, 1)).toThrow(InvariantError)
    expect(() => poissonPmf(2, 0)).toThrow(InvariantError)
  })
})

describe('scoreMatrix', () => {
  it('sums to exactly 1 with non-negative cells', () => {
    const matrix = scoreMatrix(1.6, 1.1)
    let total = 0
    for (const row of matrix) {
      for (const p of row) {
        expect(p).toBeGreaterThanOrEqual(0)
        total += p
      }
    }
    expect(total).toBeCloseTo(1, 12)
  })

  it('raises P(0,0) and P(1,1) for negative rho — and still sums to 1', () => {
    const independent = scoreMatrix(1.4, 1.2, 0)
    const corrected = scoreMatrix(1.4, 1.2, -0.11)

    // The τ correction moves mass INTO the low-score draws...
    expect(corrected[0]?.[0] ?? 0).toBeGreaterThan(independent[0]?.[0] ?? 1)
    expect(corrected[1]?.[1] ?? 0).toBeGreaterThan(independent[1]?.[1] ?? 1)
    // ...and OUT of the narrow one-goal wins.
    expect(corrected[1]?.[0] ?? 1).toBeLessThan(independent[1]?.[0] ?? 0)
    expect(corrected[0]?.[1] ?? 1).toBeLessThan(independent[0]?.[1] ?? 0)
    // High-score cells are untouched by τ (identical after renormalisation
    // to ~mass-preservation precision).
    expect(corrected[3]?.[2] ?? 0).toBeCloseTo(independent[3]?.[2] ?? 1, 9)

    const total = corrected.reduce((acc, row) => acc + row.reduce((a, p) => a + p, 0), 0)
    expect(total).toBeCloseTo(1, 12)
  })

  it('raises the total draw probability for negative rho', () => {
    const drawMass = (m: readonly (readonly number[])[]): number =>
      m.reduce((acc, row, h) => acc + (row[h] ?? 0), 0)
    expect(drawMass(scoreMatrix(1.3, 1.15, DEFAULT_RHO))).toBeGreaterThan(
      drawMass(scoreMatrix(1.3, 1.15, 0)),
    )
  })

  it('clamps rho into the admissible range instead of emitting negative cells', () => {
    // A wildly out-of-range rho must still yield a valid distribution.
    const matrix = scoreMatrix(2.5, 2.0, -5)
    for (const row of matrix) for (const p of row) expect(p).toBeGreaterThanOrEqual(0)
    const total = matrix.reduce((acc, row) => acc + row.reduce((a, p) => a + p, 0), 0)
    expect(total).toBeCloseTo(1, 12)
  })

  it('rejects degenerate inputs', () => {
    expect(() => scoreMatrix(0, 1)).toThrow(InvariantError)
    expect(() => scoreMatrix(1, 1, -0.11, 1)).toThrow(InvariantError)
  })
})

describe('matrixToOutcomes', () => {
  it('produces jointly coherent markets from one matrix', () => {
    const out = matrixToOutcomes(scoreMatrix(1.7, 1.0))
    expect(out.home + out.draw + out.away).toBeCloseTo(1, 12)
    expect(out.over25 + out.under25).toBeCloseTo(1, 12)
    expect(out.bttsYes + out.bttsNo).toBeCloseTo(1, 12)
  })

  it('favours the side with the larger λ', () => {
    const out = matrixToOutcomes(scoreMatrix(2.5, 0.8))
    expect(out.home).toBeGreaterThan(out.away)
    expect(out.over25).toBeGreaterThan(0.5) // 3.3 expected goals is over-ish
  })

  it('matches a hand-computed P(0,0) read-off for the independent case', () => {
    const matrix = scoreMatrix(1.0, 1.0, 0)
    // Independent: P(0,0) = e^−1 · e^−1, up to the truncation renormalisation
    // (the ~2.7e-9 tail beyond 10 goals is folded back over the matrix).
    expect(matrix[0]?.[0] ?? 0).toBeCloseTo(Math.exp(-2), 7)
    const out = matrixToOutcomes(matrix)
    // Symmetric λs: home and away must be equal to numerical precision.
    expect(out.home).toBeCloseTo(out.away, 12)
  })
})

describe('expectedGoals', () => {
  it('is the product of base rate, venue and the two strengths', () => {
    expect(expectedGoals(1.2, 1.1, 1.35, 1.25)).toBeCloseTo(1.35 * 1.25 * 1.2 * 1.1, 12)
    expect(expectedGoals(1, 1, 1.35, 1)).toBeCloseTo(1.35, 12)
  })

  it('clamps degenerate products instead of propagating them', () => {
    expect(expectedGoals(0.001, 0.001, 1.35, 1)).toBeCloseTo(0.05, 12)
    expect(expectedGoals(10, 10, 3, 2)).toBeCloseTo(6, 12)
  })
})

describe('fitAttackDefence', () => {
  /** A double round robin where team A wins every game 3-0 and the rest draw 1-1. */
  function dominantLeague(): FinishedGame[] {
    const teams = ['A', 'B', 'C', 'D']
    const games: FinishedGame[] = []
    let day = 60
    for (const home of teams) {
      for (const away of teams) {
        if (home === away) continue
        const kickoff = NOW_MS - day * DAY
        day -= 1
        if (home === 'A') games.push(fg(home, away, 3, 0, kickoff))
        else if (away === 'A') games.push(fg(home, away, 0, 3, kickoff))
        else games.push(fg(home, away, 1, 1, kickoff))
      }
    }
    return games
  }

  it('converges and gives the dominant team the highest attack strength', () => {
    const fit = fitAttackDefence(dominantLeague(), { asOf: NOW_MS })
    expect(fit.converged).toBe(true)
    for (const other of ['B', 'C', 'D']) {
      expect(fit.attack('A')).toBeGreaterThan(fit.attack(other))
      // Defence is WEAKNESS: the team that never concedes has the lowest.
      expect(fit.defence('A')).toBeLessThan(fit.defence(other))
    }
    expect(fit.gamesFitted('A')).toBe(6)
  })

  it('keeps a 2-game team near 1.0 via shrinkage, despite extreme results', () => {
    // Team E crushes two opponents 5-0 — on raw rates a monster, but two
    // games is mostly variance and the shrink must refuse to be impressed.
    const games = [
      ...dominantLeague(),
      fg('E', 'B', 5, 0, NOW_MS - 8 * DAY),
      fg('C', 'E', 0, 5, NOW_MS - 4 * DAY),
    ]
    const fit = fitAttackDefence(games, { asOf: NOW_MS })
    const shrunk = fit.attack('E')

    // Near league average despite a +10 goal difference in two games...
    expect(shrunk).toBeGreaterThan(1)
    expect(shrunk).toBeLessThan(1.8)

    // ...and materially closer to 1.0 than an (effectively) unshrunk fit of
    // the same data — the direct test that the shrinkage is doing the work.
    const unshrunk = fitAttackDefence(games, { asOf: NOW_MS, shrinkPriorWeight: 1e-6 })
    expect(Math.abs(shrunk - 1)).toBeLessThan(Math.abs(unshrunk.attack('E') - 1))
  })

  it('down-weights stale games — recent wins beat identical old wins', () => {
    // Same four results for team X; only the timestamps differ between fits.
    const recentWins = [
      fg('X', 'Y', 3, 0, NOW_MS - 5 * DAY),
      fg('Y', 'X', 0, 3, NOW_MS - 10 * DAY),
      fg('X', 'Y', 0, 2, NOW_MS - 300 * DAY),
      fg('Y', 'X', 2, 0, NOW_MS - 305 * DAY),
    ]
    const staleWins = [
      fg('X', 'Y', 3, 0, NOW_MS - 300 * DAY),
      fg('Y', 'X', 0, 3, NOW_MS - 305 * DAY),
      fg('X', 'Y', 0, 2, NOW_MS - 5 * DAY),
      fg('Y', 'X', 2, 0, NOW_MS - 10 * DAY),
    ]
    const recent = fitAttackDefence(recentWins, { asOf: NOW_MS })
    const stale = fitAttackDefence(staleWins, { asOf: NOW_MS })
    expect(recent.attack('X')).toBeGreaterThan(stale.attack('X'))
  })

  it('excludes games after asOf — the lookahead guard', () => {
    const past = fg('A', 'B', 1, 1, NOW_MS - 5 * DAY)
    const future = fg('A', 'B', 9, 0, NOW_MS + 5 * DAY)
    const fit = fitAttackDefence([past, future], { asOf: NOW_MS })
    expect(fit.gamesFitted('A')).toBe(1)
    // The 9-0 never happened as far as this fit is concerned.
    expect(fit.attack('A')).toBeCloseTo(fit.attack('B'), 6)
  })

  it('reads unknown teams as exactly league average with zero games', () => {
    const fit = fitAttackDefence(dominantLeague(), { asOf: NOW_MS })
    expect(fit.attack('ghost')).toBe(1)
    expect(fit.defence('ghost')).toBe(1)
    expect(fit.gamesFitted('ghost')).toBe(0)
  })

  it('throws InsufficientDataError when no usable games exist', () => {
    expect(() => fitAttackDefence([], { asOf: NOW_MS })).toThrow(InsufficientDataError)
    expect(() =>
      fitAttackDefence([fg('A', 'B', 1, 0, NOW_MS + DAY)], { asOf: NOW_MS }),
    ).toThrow(InsufficientDataError)
  })

  it('produces a JSON-serialisable snapshot that round-trips', () => {
    const fit = fitAttackDefence(dominantLeague(), { asOf: NOW_MS })
    const snapshot = fit.snapshot()
    const revived = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot
    expect(revived).toEqual(snapshot)
    expect(revived['A']?.attack).toBeCloseTo(fit.attack('A'), 12)
  })
})
