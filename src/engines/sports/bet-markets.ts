/**
 * Betting-market derivation — every football market read off ONE joint
 * score distribution.
 *
 * The input is the Dixon–Coles score matrix (poisson.ts#scoreMatrix), and
 * every market below is a plain sum over its cells. That is a coherence
 * guarantee, not a convenience: independently-estimated markets can quietly
 * contradict each other (a 55% home win with a 70% under-2.5 and a 65%
 * BTTS-yes is close to impossible as a joint claim), and a consumer combining
 * contradictory quotes inherits the contradiction. Here 1X2, double chance,
 * DNB, totals, team totals, correct scores and every handicap line agree with
 * each other by construction, because they are literally the same cells
 * partitioned differently.
 *
 * Asian handicap settlement is implemented exactly, including quarter lines.
 * A quarter-line stake (−0.75, +0.25, …) is contractually HALF the stake on
 * each adjacent half/integer line, which produces five distinguishable
 * settlement outcomes (full win, half win, push, half loss, full loss). The
 * derivation below enumerates the goal-margin distribution against both
 * component lines rather than approximating — approximations here settle
 * real money wrongly, so this file is tested against hand-computed matrices.
 *
 * This module is PURE. No clock, no I/O, no randomness — identical matrices
 * produce identical market sets, which is what makes the market-level
 * accuracy record (§13 market-specific learning) meaningful.
 */

import { invariant } from '@/core/errors'
import { fairDecimalOdds } from '@/core/prediction/probability'
import type { PoissonScoreMatrix } from './poisson'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface OneXTwoProbs {
  readonly home: number
  readonly draw: number
  readonly away: number
}

export interface DoubleChanceProbs {
  /** 1X — home win or draw. */
  readonly homeOrDraw: number
  /** 12 — either side wins. */
  readonly homeOrAway: number
  /** X2 — draw or away win. */
  readonly drawOrAway: number
}

export interface DrawNoBetProbs {
  /** P(home wins | not a draw) — the draw refunds the stake, so the market
   *  quotes probabilities conditional on the bet resolving. */
  readonly home: number
  readonly away: number
  /** The excluded push mass, kept visible rather than silently dropped. */
  readonly pushProbability: number
}

export interface BttsProbs {
  readonly yes: number
  readonly no: number
}

export interface TotalLineProbs {
  /** Goal line, e.g. 2.5. Integer lines carry push mass. */
  readonly line: number
  readonly over: number
  readonly under: number
  /** Mass at exactly the line (integer lines only; 0 for half lines). */
  readonly pushProbability: number
}

export interface CorrectScoreProb {
  readonly home: number
  readonly away: number
  readonly probability: number
}

export interface CorrectScoresResult {
  /** Highest-probability exact scorelines, descending. */
  readonly top: readonly CorrectScoreProb[]
  /** Mass outside the top list — the honest remainder, never hidden. */
  readonly otherProbability: number
}

/**
 * Settlement distribution for a HOME Asian-handicap stake at `line`.
 * The five outcomes are exhaustive and mutually exclusive; they sum to 1.
 * The AWAY side of the same line is the mirror (line negated, win/loss
 * swapped), exposed separately so the UI never has to derive it.
 */
export interface AsianHandicapSettlement {
  /** Handicap applied to the HOME side's goals (e.g. -0.75, +0.25). */
  readonly line: number
  readonly fullWin: number
  readonly halfWin: number
  readonly push: number
  readonly halfLoss: number
  readonly fullLoss: number
}

export interface AsianHandicapLine {
  readonly line: number
  readonly home: AsianHandicapSettlement
  readonly away: AsianHandicapSettlement
  /** Fair (margin-free) decimal odds for each side — EV-zero prices that
   *  account for pushes and half-stake outcomes, see fairAsianOdds. */
  readonly homeFairOdds: number
  readonly awayFairOdds: number
}

export interface EuropeanHandicapLine {
  /** Integer handicap added to home goals; the market stays 3-way. */
  readonly line: number
  readonly home: number
  readonly draw: number
  readonly away: number
}

export interface ExpectedGoals {
  readonly home: number
  readonly away: number
  readonly total: number
}

/** The full coherent market set derived from one score matrix. */
export interface BetMarkets {
  readonly oneXTwo: OneXTwoProbs
  readonly doubleChance: DoubleChanceProbs
  readonly drawNoBet: DrawNoBetProbs
  readonly btts: BttsProbs
  readonly totals: readonly TotalLineProbs[]
  readonly homeTeamTotals: readonly TotalLineProbs[]
  readonly awayTeamTotals: readonly TotalLineProbs[]
  readonly correctScores: CorrectScoresResult
  readonly asianHandicap: readonly AsianHandicapLine[]
  readonly europeanHandicap: readonly EuropeanHandicapLine[]
  readonly expectedGoals: ExpectedGoals
}

/** Stable market keys for persistence and per-market accuracy tracking. */
export type BetMarketKey =
  | '1x2'
  | 'double_chance'
  | 'draw_no_bet'
  | 'btts'
  | 'totals'
  | 'team_totals'
  | 'correct_score'
  | 'asian_handicap'
  | 'european_handicap'

// ---------------------------------------------------------------------------
// Internals — one pass over the matrix builds a margin/total substrate
// ---------------------------------------------------------------------------

/** Total probability mass of the matrix (callers may pass unnormalised). */
function matrixMass(matrix: PoissonScoreMatrix): number {
  let total = 0
  for (const row of matrix) for (const p of row) total += p
  invariant(total > 0, 'bet-markets requires a matrix with positive mass')
  return total
}

// ---------------------------------------------------------------------------
// Individual market derivations
// ---------------------------------------------------------------------------

export function matrixToOneXTwo(matrix: PoissonScoreMatrix): OneXTwoProbs {
  const mass = matrixMass(matrix)
  let home = 0
  let draw = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      if (h > a) home += p
      else if (h === a) draw += p
    })
  })
  home /= mass
  draw /= mass
  return { home, draw, away: 1 - home - draw }
}

export function matrixToDoubleChance(matrix: PoissonScoreMatrix): DoubleChanceProbs {
  const { home, draw, away } = matrixToOneXTwo(matrix)
  return { homeOrDraw: home + draw, homeOrAway: home + away, drawOrAway: draw + away }
}

/**
 * Draw No Bet: the draw refunds the stake, so quoted probabilities are
 * conditional on a decisive result — this is how the market prices it, and
 * quoting unconditional numbers would misstate fair odds by the draw mass.
 */
export function matrixToDrawNoBet(matrix: PoissonScoreMatrix): DrawNoBetProbs {
  const { home, draw, away } = matrixToOneXTwo(matrix)
  const decisive = home + away
  invariant(decisive > 0, 'draw-no-bet requires some decisive probability mass')
  return { home: home / decisive, away: away / decisive, pushProbability: draw }
}

export function matrixToBttsProbs(matrix: PoissonScoreMatrix): BttsProbs {
  const mass = matrixMass(matrix)
  let yes = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      if (h > 0 && a > 0) yes += p
    })
  })
  yes /= mass
  return { yes, no: 1 - yes }
}

/**
 * Over/under a TOTAL-goals line. Integer lines carry push mass (total exactly
 * on the line); over/under are quoted conditional on the bet resolving, and
 * the push mass is reported alongside instead of vanishing.
 */
export function matrixToTotal(matrix: PoissonScoreMatrix, line: number): TotalLineProbs {
  invariant(line >= 0, 'total-goals line must be non-negative')
  const mass = matrixMass(matrix)
  let over = 0
  let under = 0
  let push = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      const goals = h + a
      if (goals > line) over += p
      else if (goals < line) under += p
      else push += p
    })
  })
  const resolving = over + under
  invariant(resolving > 0, `total line ${line} leaves no resolving outcomes`)
  return { line, over: over / resolving, under: under / resolving, pushProbability: push / mass }
}

/** Over/under a single TEAM's goal line, from that side's marginal. */
export function matrixToTeamTotal(
  matrix: PoissonScoreMatrix,
  side: 'home' | 'away',
  line: number,
): TotalLineProbs {
  invariant(line >= 0, 'team-total line must be non-negative')
  const mass = matrixMass(matrix)
  let over = 0
  let under = 0
  let push = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      const goals = side === 'home' ? h : a
      if (goals > line) over += p
      else if (goals < line) under += p
      else push += p
    })
  })
  const resolving = over + under
  invariant(resolving > 0, `team-total line ${line} leaves no resolving outcomes`)
  return { line, over: over / resolving, under: under / resolving, pushProbability: push / mass }
}

/** Highest-probability exact scorelines plus the honest remainder. */
export function matrixToCorrectScores(
  matrix: PoissonScoreMatrix,
  topN = 8,
): CorrectScoresResult {
  invariant(topN >= 1, 'correct-scores requires topN >= 1')
  const mass = matrixMass(matrix)
  const cells: CorrectScoreProb[] = []
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      cells.push({ home: h, away: a, probability: p / mass })
    })
  })
  // Deterministic ordering: probability desc, then score asc — equal-probability
  // cells must not reorder between runs.
  cells.sort(
    (x, y) => y.probability - x.probability || x.home - y.home || x.away - y.away,
  )
  const top = cells.slice(0, topN)
  const covered = top.reduce((acc, c) => acc + c.probability, 0)
  return { top, otherProbability: Math.max(0, 1 - covered) }
}

/** Expected goals per side — the mean of each marginal distribution. */
export function matrixToExpectedGoals(matrix: PoissonScoreMatrix): ExpectedGoals {
  const mass = matrixMass(matrix)
  let home = 0
  let away = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      home += h * p
      away += a * p
    })
  })
  home /= mass
  away /= mass
  return { home, away, total: home + away }
}

// ---------------------------------------------------------------------------
// Asian handicap — exact settlement, quarter lines included
// ---------------------------------------------------------------------------

/** P(home margin > 0), P(= 0), P(< 0) against an adjusted margin M + line. */
function marginOutcome(
  matrix: PoissonScoreMatrix,
  line: number,
): { win: number; push: number; loss: number } {
  const mass = matrixMass(matrix)
  let win = 0
  let push = 0
  let loss = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      const adjusted = h - a + line
      // Exact-zero comparison is safe: margins are integers and lines are
      // multiples of 0.25, so `adjusted` is always an exact multiple of 0.25
      // in floating point (quarter values are dyadic rationals).
      if (adjusted > 0) win += p
      else if (adjusted === 0) push += p
      else loss += p
    })
  })
  return { win: win / mass, push: push / mass, loss: loss / mass }
}

const QUARTER_EPS = 1e-9

function isQuarterLine(line: number): boolean {
  const frac = Math.abs(line * 4) % 1
  return Math.abs((Math.abs(line) * 100) % 50) > QUARTER_EPS && frac < QUARTER_EPS
}

/**
 * Settlement distribution for a HOME stake at an Asian line.
 *
 * Half and integer lines settle in one piece. A quarter line is HALF the
 * stake on each adjacent line (e.g. −0.75 = ½ at −0.5 and ½ at −1.0), which
 * is where half wins and half losses come from: one component settles, the
 * other pushes. Both components are evaluated exactly against the margin
 * distribution — there is no approximation to test one's luck against.
 */
export function asianHandicapSettlement(
  matrix: PoissonScoreMatrix,
  line: number,
): AsianHandicapSettlement {
  invariant(
    Math.abs(line * 4 - Math.round(line * 4)) < QUARTER_EPS,
    `Asian line must be a multiple of 0.25, got ${line}`,
  )

  if (!isQuarterLine(line)) {
    const { win, push, loss } = marginOutcome(matrix, line)
    return { line, fullWin: win, halfWin: 0, push, halfLoss: 0, fullLoss: loss }
  }

  // Quarter line: enumerate the joint settlement of the two components. The
  // components differ by exactly 0.5, so at most one of them can push on any
  // given margin — a full push is impossible, and the joint table collapses
  // to five outcomes.
  const lower = marginOutcome(matrix, line - 0.25)
  const upper = marginOutcome(matrix, line + 0.25)

  // For each integer margin M the two components agree except where one
  // pushes. Working per-cell keeps this exact:
  const mass = matrixMass(matrix)
  let fullWin = 0
  let halfWin = 0
  let halfLoss = 0
  let fullLoss = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      const lowerAdj = h - a + (line - 0.25)
      const upperAdj = h - a + (line + 0.25)
      const wins = (lowerAdj > 0 ? 1 : 0) + (upperAdj > 0 ? 1 : 0)
      const pushes = (lowerAdj === 0 ? 1 : 0) + (upperAdj === 0 ? 1 : 0)
      if (wins === 2) fullWin += p
      else if (wins === 1 && pushes === 1) halfWin += p
      else if (pushes === 1) halfLoss += p
      else fullLoss += p
    })
  })
  fullWin /= mass
  halfWin /= mass
  halfLoss /= mass
  fullLoss /= mass

  // Cross-check against the component decomposition: the stake-weighted win
  // mass must equal the mean of the two component win masses (each carries
  // half the stake). A drift here is an implementation bug, not noise.
  const componentWinMass = (lower.win + upper.win) / 2
  invariant(
    Math.abs(fullWin + halfWin / 2 - componentWinMass) < 1e-9,
    'asian quarter-line settlement disagrees with its component lines',
  )

  return { line, fullWin, halfWin, push: 0, halfLoss, fullLoss }
}

/**
 * Fair (EV-zero) decimal odds for an Asian settlement distribution.
 *
 * Solves  P(fw)·(d−1) + P(hw)·(d−1)/2 − P(hl)/2 − P(fl) = 0  for d. Pushes
 * contribute nothing on either side. When the win mass is zero there is no
 * finite fair price; Infinity is returned and the UI renders "—" rather than
 * a made-up cap.
 */
export function fairAsianOdds(s: AsianHandicapSettlement): number {
  const winMass = s.fullWin + s.halfWin / 2
  const lossMass = s.fullLoss + s.halfLoss / 2
  if (winMass <= 0) return Number.POSITIVE_INFINITY
  return 1 + lossMass / winMass
}

/** The mirrored AWAY settlement of a home line: negate the line, swap sides. */
function mirrorSettlement(home: AsianHandicapSettlement): AsianHandicapSettlement {
  return {
    line: -home.line,
    fullWin: home.fullLoss,
    halfWin: home.halfLoss,
    push: home.push,
    halfLoss: home.halfWin,
    fullLoss: home.fullWin,
  }
}

/** Standard line ladder −2.0 … +2.0 in 0.25 steps. */
export const ASIAN_LINES: readonly number[] = Array.from({ length: 17 }, (_, i) => -2 + i * 0.25)

export function matrixToAsianHandicaps(
  matrix: PoissonScoreMatrix,
  lines: readonly number[] = ASIAN_LINES,
): AsianHandicapLine[] {
  return lines.map((line) => {
    const home = asianHandicapSettlement(matrix, line)
    const away = mirrorSettlement(home)
    return {
      line,
      home,
      away,
      homeFairOdds: fairAsianOdds(home),
      awayFairOdds: fairAsianOdds(away),
    }
  })
}

/** European (3-way) handicap: integer head start added to home goals. */
export function matrixToEuropeanHandicap(
  matrix: PoissonScoreMatrix,
  line: number,
): EuropeanHandicapLine {
  invariant(Number.isInteger(line), `European handicap line must be an integer, got ${line}`)
  const mass = matrixMass(matrix)
  let home = 0
  let draw = 0
  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      const adjusted = h - a + line
      if (adjusted > 0) home += p
      else if (adjusted === 0) draw += p
    })
  })
  home /= mass
  draw /= mass
  return { line, home, draw, away: 1 - home - draw }
}

// ---------------------------------------------------------------------------
// The full set
// ---------------------------------------------------------------------------

export const TOTAL_LINES: readonly number[] = [0.5, 1.5, 2.5, 3.5, 4.5]
export const TEAM_TOTAL_LINES: readonly number[] = [0.5, 1.5, 2.5]
export const EUROPEAN_LINES: readonly number[] = [-2, -1, 0, 1, 2]

/**
 * Derive the complete coherent market set from one score matrix. This is the
 * single entry point the orchestrator and API use — market-by-market calls
 * exist for tests and for callers that need exactly one market.
 */
export function deriveBetMarkets(matrix: PoissonScoreMatrix): BetMarkets {
  return {
    oneXTwo: matrixToOneXTwo(matrix),
    doubleChance: matrixToDoubleChance(matrix),
    drawNoBet: matrixToDrawNoBet(matrix),
    btts: matrixToBttsProbs(matrix),
    totals: TOTAL_LINES.map((line) => matrixToTotal(matrix, line)),
    homeTeamTotals: TEAM_TOTAL_LINES.map((line) => matrixToTeamTotal(matrix, 'home', line)),
    awayTeamTotals: TEAM_TOTAL_LINES.map((line) => matrixToTeamTotal(matrix, 'away', line)),
    correctScores: matrixToCorrectScores(matrix),
    asianHandicap: matrixToAsianHandicaps(matrix),
    europeanHandicap: EUROPEAN_LINES.map((line) => matrixToEuropeanHandicap(matrix, line)),
    expectedGoals: matrixToExpectedGoals(matrix),
  }
}

/** Fair decimal odds for a plain probability — re-exported convenience so UI
 *  code renders odds without importing two modules. */
export { fairDecimalOdds }
