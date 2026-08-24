/**
 * The Dixon–Coles match model (Dixon & Coles, 1997).
 *
 * A football scoreline is modelled as two Poisson counts — home goals with
 * mean λ_home, away goals with mean λ_away — with a low-score dependence
 * correction. The output is a full score-probability matrix, from which 1X2,
 * over/under and both-teams-to-score are all read off the SAME joint
 * distribution. One coherent model, three consistent markets — rather than
 * three independent guesses that can quietly contradict each other.
 *
 * -----------------------------------------------------------------------------
 * Why the correction exists
 * -----------------------------------------------------------------------------
 * Independent Poisson systematically underestimates the low-scoring draws:
 * real 0-0 and 1-1 frequencies exceed what independence predicts, because the
 * two teams' scoring is not independent (game state feeds back — a level game
 * late stays cagey). And the draw is where football probability lives: it is
 * ~25% of outcomes and the hardest cell to price. Dixon–Coles fixes exactly
 * these cells with a factor τ on the four low-score outcomes:
 *
 *   τ(0,0) = 1 − λhλaρ     τ(0,1) = 1 + λhρ
 *   τ(1,0) = 1 + λaρ       τ(1,1) = 1 − ρ
 *
 * With football's empirical ρ ≈ −0.13, probability moves INTO 0-0 and 1-1 and
 * out of 1-0/0-1 — raising the draw. The construction is mass-preserving: the
 * four adjustments cancel exactly (each is ±λhλaρ·e^{−λh−λa}), so the full
 * distribution still sums to 1 and only its shape changes.
 */

import { invariant } from '@/core/errors'
import { shrinkToPrior } from '@/core/prediction/probability'
import type { TeamGameStats } from '@/providers/types'
import type { LeagueGoalMeans } from './config/football'

/** matrix[homeGoals][awayGoals] = P(that exact scoreline). */
export type ScoreMatrix = readonly (readonly number[])[]

export interface TeamRates {
  readonly lambdaHome: number
  readonly lambdaAway: number
}

/** Floor/ceiling for a side's expected goals — beyond these, inputs are broken. */
const LAMBDA_MIN = 0.05
const LAMBDA_MAX = 6

/**
 * Estimate expected goals for each side via the multiplicative attack/defence
 * model: λ = base · attackStrength(scorer) · defenceWeakness(opponent), where
 * strengths are the team's per-game rates relative to the league's per-team
 * mean, SHRUNK toward 1.0 (league average) by sample size.
 *
 * The shrinkage is what keeps early-season output sane: three games at 3.0
 * goals per game is mostly variance, and shrinkToPrior with the config's
 * priorWeight refuses to be impressed by it. At zero games the estimate IS the
 * league mean — the correct maximally-ignorant answer.
 *
 * Home advantage enters as a symmetric split of the goal margin: half added to
 * the home base rate, half removed from the away base rate, so the league's
 * total-goals environment is preserved while the margin shifts.
 */
export function estimateTeamRates(
  homeStats: readonly TeamGameStats[],
  awayStats: readonly TeamGameStats[],
  leagueMeans: LeagueGoalMeans,
  homeAdvantage: number,
  priorWeight = 6,
): TeamRates {
  const perTeamMean = (leagueMeans.homeGoals + leagueMeans.awayGoals) / 2
  invariant(perTeamMean > 0, 'league goal means must be positive')

  const homeAttack = shrunkRatio(homeStats.map((g) => g.scored), perTeamMean, priorWeight)
  const homeDefence = shrunkRatio(homeStats.map((g) => g.conceded), perTeamMean, priorWeight)
  const awayAttack = shrunkRatio(awayStats.map((g) => g.scored), perTeamMean, priorWeight)
  const awayDefence = shrunkRatio(awayStats.map((g) => g.conceded), perTeamMean, priorWeight)

  const homeBase = perTeamMean + homeAdvantage / 2
  const awayBase = perTeamMean - homeAdvantage / 2

  return {
    lambdaHome: clampLambda(homeBase * homeAttack * awayDefence),
    lambdaAway: clampLambda(awayBase * awayAttack * homeDefence),
  }
}

/** Per-game rate relative to the league mean, shrunk toward 1.0 by sample size. */
function shrunkRatio(goals: readonly number[], perTeamMean: number, priorWeight: number): number {
  const n = goals.length
  const rate = n === 0 ? 0 : goals.reduce((a, b) => a + b, 0) / n
  return shrinkToPrior(rate / perTeamMean, n, 1, priorWeight)
}

function clampLambda(lambda: number): number {
  return Math.min(LAMBDA_MAX, Math.max(LAMBDA_MIN, lambda))
}

/**
 * Build the Dixon–Coles score matrix, truncated at `maxGoals` per side.
 *
 * ρ is clamped into its admissible range — the range where every τ cell stays
 * non-negative: ρ ∈ [max(−1/λh, −1/λa), min(1, 1/(λhλa))]. Football's
 * empirical ρ ≈ −0.13 is comfortably inside this for realistic λs; the clamp
 * only bites on degenerate inputs and keeps the matrix a valid distribution.
 *
 * Cells are NOT renormalised: each cell is the exact model probability of that
 * scoreline, and the small truncation tail (P(a side scores > maxGoals),
 * ~1e-5 at football λs with maxGoals 10) is left missing rather than smeared
 * across the matrix. The aggregators below normalise by the matrix mass. An
 * invariant checks the matrix total equals the analytically-expected truncated
 * mass — since τ is mass-preserving, that is exactly the product of the two
 * truncated Poisson totals — so any implementation drift fails loudly.
 */
export function dixonColesMatrix(
  lambdaHome: number,
  lambdaAway: number,
  rho: number,
  maxGoals = 10,
): ScoreMatrix {
  invariant(lambdaHome > 0 && lambdaAway > 0, 'dixonColesMatrix requires positive lambdas')
  invariant(maxGoals >= 2, 'dixonColesMatrix requires maxGoals >= 2 (the tau region must fit)')

  const rhoLo = Math.max(-1 / lambdaHome, -1 / lambdaAway)
  const rhoHi = Math.min(1, 1 / (lambdaHome * lambdaAway))
  const safeRho = Math.min(rhoHi, Math.max(rhoLo, rho))

  const pmfHome = poissonPmfSeries(lambdaHome, maxGoals)
  const pmfAway = poissonPmfSeries(lambdaAway, maxGoals)

  const matrix: number[][] = []
  let total = 0
  for (let home = 0; home <= maxGoals; home++) {
    const row: number[] = []
    for (let away = 0; away <= maxGoals; away++) {
      const cell = (pmfHome[home] ?? 0) * (pmfAway[away] ?? 0) * tau(home, away, lambdaHome, lambdaAway, safeRho)
      row.push(cell)
      total += cell
    }
    matrix.push(row)
  }

  // τ preserves mass, so the truncated total must equal the product of the two
  // truncated Poisson masses to floating-point precision.
  const expectedMass = sumOf(pmfHome) * sumOf(pmfAway)
  invariant(
    Math.abs(total - expectedMass) < 1e-9 && total <= 1 + 1e-9,
    `Dixon–Coles matrix mass ${total} deviates from expected ${expectedMass}`,
  )

  return matrix
}

/** The Dixon–Coles low-score correction factor. 1 everywhere outside the 2x2 corner. */
function tau(home: number, away: number, lambdaHome: number, lambdaAway: number, rho: number): number {
  if (home === 0 && away === 0) return 1 - lambdaHome * lambdaAway * rho
  if (home === 0 && away === 1) return 1 + lambdaHome * rho
  if (home === 1 && away === 0) return 1 + lambdaAway * rho
  if (home === 1 && away === 1) return 1 - rho
  return 1
}

/**
 * Poisson pmf for k = 0..maxK via the multiplicative recurrence
 * p(k) = p(k−1)·λ/k — no factorials, so no overflow and no precision loss.
 */
function poissonPmfSeries(lambda: number, maxK: number): number[] {
  const pmf: number[] = [Math.exp(-lambda)]
  for (let k = 1; k <= maxK; k++) pmf.push((pmf[k - 1] ?? 0) * (lambda / k))
  return pmf
}

// ---------------------------------------------------------------------------
// Market aggregators — all read the same joint distribution.
// ---------------------------------------------------------------------------

export interface OneXTwo {
  readonly home: number
  readonly draw: number
  readonly away: number
}

/** Sum the matrix into the three 1X2 regions, normalised by matrix mass. */
export function matrixTo1X2(matrix: ScoreMatrix): OneXTwo {
  let home = 0
  let draw = 0
  let away = 0
  let total = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      total += p
      if (h > a) home += p
      else if (h === a) draw += p
      else away += p
    })
  })
  invariant(total > 0, 'matrixTo1X2 requires a non-empty matrix')
  return { home: home / total, draw: draw / total, away: away / total }
}

export interface OverUnder {
  readonly over: number
  readonly under: number
}

/**
 * Over/under a total-goals line. For integer lines the mass at exactly the
 * line is a push (stake returned) and is excluded before normalising — over
 * and under are conditional on the bet resolving, which is how the market
 * quotes them. Half-lines have no push mass and are unaffected.
 */
export function matrixToOverUnder(matrix: ScoreMatrix, line: number): OverUnder {
  invariant(line >= 0, 'over/under line must be non-negative')
  let over = 0
  let under = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      const goals = h + a
      if (goals > line) over += p
      else if (goals < line) under += p
      // goals === line (integer lines only): push, excluded.
    })
  })
  const resolving = over + under
  invariant(resolving > 0, 'over/under line leaves no resolving outcomes')
  return { over: over / resolving, under: under / resolving }
}

export interface Btts {
  readonly yes: number
  readonly no: number
}

/** Both teams to score: P(home ≥ 1 AND away ≥ 1), normalised by matrix mass. */
export function matrixToBtts(matrix: ScoreMatrix): Btts {
  let yes = 0
  let total = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      total += p
      if (h > 0 && a > 0) yes += p
    })
  })
  invariant(total > 0, 'matrixToBtts requires a non-empty matrix')
  return { yes: yes / total, no: 1 - yes / total }
}

function sumOf(values: readonly number[]): number {
  let sum = 0
  for (const v of values) sum += v
  return sum
}
