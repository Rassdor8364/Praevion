import { describe, expect, it } from 'vitest'

import {
  dixonColesMatrix,
  estimateTeamRates,
  matrixTo1X2,
  matrixToBtts,
  matrixToOverUnder,
} from '@/engines/sports/dixon-coles'
import { statsFromResults, seededRandom } from './fixtures'

const LEAGUE_MEANS = { homeGoals: 1.52, awayGoals: 1.2 }

function poisson(k: number, lambda: number): number {
  let p = Math.exp(-lambda)
  for (let i = 1; i <= k; i++) p *= lambda / i
  return p
}

function matrixSum(matrix: readonly (readonly number[])[]): number {
  let sum = 0
  for (const row of matrix) for (const cell of row) sum += cell
  return sum
}

describe('dixonColesMatrix', () => {
  it('sums to ~1 across seeded random lambdas (property)', () => {
    const rand = seededRandom(42)
    for (let trial = 0; trial < 50; trial++) {
      const lambdaHome = 0.4 + rand() * 2.4
      const lambdaAway = 0.4 + rand() * 2.4
      const matrix = dixonColesMatrix(lambdaHome, lambdaAway, -0.13, 12)
      // maxGoals=12 leaves only the P(side > 12) tail unaccounted for.
      expect(matrixSum(matrix)).toBeGreaterThan(0.999)
      expect(matrixSum(matrix)).toBeLessThanOrEqual(1 + 1e-9)
      for (const row of matrix) for (const cell of row) expect(cell).toBeGreaterThanOrEqual(0)
    }
  })

  it('reduces exactly to independent Poisson when rho = 0 (cell-by-cell)', () => {
    const lambdaHome = 1.7
    const lambdaAway = 1.1
    const matrix = dixonColesMatrix(lambdaHome, lambdaAway, 0, 8)
    for (let h = 0; h <= 8; h++) {
      for (let a = 0; a <= 8; a++) {
        expect(matrix[h]?.[a]).toBeCloseTo(poisson(h, lambdaHome) * poisson(a, lambdaAway), 12)
      }
    }
  })

  it('raises the draw probability with negative rho vs independent Poisson — THE key property', () => {
    const lambdaHome = 1.4
    const lambdaAway = 1.1
    const independent = matrixTo1X2(dixonColesMatrix(lambdaHome, lambdaAway, 0, 10))
    const corrected = matrixTo1X2(dixonColesMatrix(lambdaHome, lambdaAway, -0.13, 10))
    expect(corrected.draw).toBeGreaterThan(independent.draw)
    // The correction reshapes, it does not break normalisation.
    expect(corrected.home + corrected.draw + corrected.away).toBeCloseTo(1, 12)
  })

  it('matches the hand-computed 3x3 corner for lambdas 1.5/1.0, rho -0.1', () => {
    // Hand computation (maxGoals = 2, so a 3x3 matrix):
    //   pois(k, 1.5): k=0 e^-1.5 = 0.22313016, k=1 0.33469524, k=2 0.25102143
    //   pois(k, 1.0): k=0 e^-1.0 = 0.36787944, k=1 0.36787944, k=2 0.18393972
    //   tau(0,0) = 1 − 1.5·1.0·(−0.1) = 1.15
    //   tau(0,1) = 1 + 1.5·(−0.1)     = 0.85
    //   tau(1,0) = 1 + 1.0·(−0.1)     = 0.90
    //   tau(1,1) = 1 − (−0.1)         = 1.10
    //   P(0,0) = 0.22313016·0.36787944·1.15 = 0.09439775
    //   P(0,1) = 0.22313016·0.36787944·0.85 = 0.06977225
    //   P(0,2) = 0.22313016·0.18393972       = 0.04104250
    //   P(1,0) = 0.33469524·0.36787944·0.90 = 0.11081475
    //   P(1,1) = 0.33469524·0.36787944·1.10 = 0.13544025
    //   P(1,2) = 0.33469524·0.18393972       = 0.06156375
    //   P(2,0) = 0.25102143·0.36787944       = 0.09234562
    //   P(2,1) = 0.25102143·0.36787944       = 0.09234562
    //   P(2,2) = 0.25102143·0.18393972       = 0.04617281
    const matrix = dixonColesMatrix(1.5, 1.0, -0.1, 2)
    expect(matrix[0]?.[0]).toBeCloseTo(0.09439775, 7)
    expect(matrix[0]?.[1]).toBeCloseTo(0.06977225, 7)
    expect(matrix[0]?.[2]).toBeCloseTo(0.0410425, 7)
    expect(matrix[1]?.[0]).toBeCloseTo(0.11081475, 7)
    expect(matrix[1]?.[1]).toBeCloseTo(0.13544025, 7)
    expect(matrix[1]?.[2]).toBeCloseTo(0.06156375, 7)
    expect(matrix[2]?.[0]).toBeCloseTo(0.09234562, 7)
    expect(matrix[2]?.[1]).toBeCloseTo(0.09234562, 7)
    expect(matrix[2]?.[2]).toBeCloseTo(0.04617281, 7)
  })

  it('rejects non-positive lambdas and tiny maxGoals', () => {
    expect(() => dixonColesMatrix(0, 1, -0.1)).toThrow(/positive lambdas/)
    expect(() => dixonColesMatrix(1.5, 1.0, -0.1, 1)).toThrow(/maxGoals/)
  })
})

describe('market aggregators', () => {
  const matrix = dixonColesMatrix(1.5, 1.0, -0.13, 10)

  it('matrixTo1X2 returns a normalised distribution favouring the higher-lambda side', () => {
    const p = matrixTo1X2(matrix)
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 12)
    expect(p.home).toBeGreaterThan(p.away)
  })

  it('matrixToOverUnder is consistent across the 2.5 line and normalised', () => {
    const { over, under } = matrixToOverUnder(matrix, 2.5)
    expect(over + under).toBeCloseTo(1, 12)
    // λ total = 2.5, so over/under 2.5 should be roughly balanced with under
    // slightly favoured (Poisson mass concentrates below the mean at low λ).
    expect(under).toBeGreaterThan(0.4)
    expect(over).toBeGreaterThan(0.3)
  })

  it('matrixToOverUnder excludes push mass on integer lines', () => {
    const halfLine = matrixToOverUnder(matrix, 2.5)
    const integerLine = matrixToOverUnder(matrix, 2)
    // Over 2 (goals > 2) equals over 2.5 in raw mass, but the integer line
    // renormalises after removing the push at exactly 2 goals — so the
    // conditional over-probability must be strictly higher.
    expect(integerLine.over).toBeGreaterThan(halfLine.over)
  })

  it('matrixToBtts matches a direct computation from the score matrix', () => {
    const { yes, no } = matrixToBtts(matrix)
    expect(yes + no).toBeCloseTo(1, 12)
    let direct = 0
    let total = 0
    matrix.forEach((row, h) =>
      row.forEach((p, a) => {
        total += p
        if (h > 0 && a > 0) direct += p
      }),
    )
    expect(yes).toBeCloseTo(direct / total, 12)
  })
})

describe('estimateTeamRates', () => {
  it('returns the league-mean environment for teams with no history', () => {
    const { lambdaHome, lambdaAway } = estimateTeamRates([], [], LEAGUE_MEANS, 0.25)
    const perTeamMean = (LEAGUE_MEANS.homeGoals + LEAGUE_MEANS.awayGoals) / 2
    // Zero games → strengths shrink fully to 1.0, leaving base ± half the
    // home advantage.
    expect(lambdaHome).toBeCloseTo(perTeamMean + 0.125, 9)
    expect(lambdaAway).toBeCloseTo(perTeamMean - 0.125, 9)
  })

  it('gives a high-scoring home side a higher lambda than a shot-shy away side', () => {
    const strong = statsFromResults(['W', 'W', 'W', 'W', 'W', 'W', 'W', 'W'], { scored: 3, conceded: 0 })
    const weak = statsFromResults(['L', 'L', 'L', 'L', 'L', 'L', 'L', 'L'], { scored: 0, conceded: 3 })
    const { lambdaHome, lambdaAway } = estimateTeamRates(strong, weak, LEAGUE_MEANS, 0.25)
    expect(lambdaHome).toBeGreaterThan(lambdaAway)
    expect(lambdaHome).toBeGreaterThan((LEAGUE_MEANS.homeGoals + LEAGUE_MEANS.awayGoals) / 2)
  })

  it('shrinks small samples harder than large ones', () => {
    const hot = { scored: 4, conceded: 0 }
    const short = estimateTeamRates(statsFromResults(['W', 'W'], hot), [], LEAGUE_MEANS, 0.25)
    const long = estimateTeamRates(
      statsFromResults(Array.from({ length: 12 }, () => 'W' as const), hot),
      [],
      LEAGUE_MEANS,
      0.25,
    )
    // Same per-game rate, but twelve games of evidence moves the estimate
    // further from the league mean than two games do.
    expect(long.lambdaHome).toBeGreaterThan(short.lambdaHome)
  })
})
