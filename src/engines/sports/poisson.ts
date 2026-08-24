/**
 * Dixon–Coles bivariate Poisson match model — the fitted variant.
 *
 * Where dixon-coles.ts builds λs from one team's recent box scores, this
 * module fits per-team ATTACK and DEFENCE strengths jointly over a whole
 * league history by weighted maximum likelihood, the way Dixon & Coles (1997)
 * originally did. The joint fit matters: a team's goals-per-game is only
 * meaningful relative to WHO it played, and the coordinate-ascent below is
 * what disentangles "scores a lot" from "played leaky defences".
 *
 * -----------------------------------------------------------------------------
 * Why the low-score correction exists (the heart of the model)
 * -----------------------------------------------------------------------------
 * Two independent Poisson counts systematically UNDERESTIMATE the low-scoring
 * draws. Real 0-0 and 1-1 frequencies exceed what independence predicts,
 * because the two teams' scoring is not independent — game state feeds back.
 * A level game late stays cagey; both sides trade chance creation for risk
 * control, and the goals that independence expects simply never happen.
 *
 * And the draw is where football predictions live or die. It is ~25% of all
 * outcomes, it is the outcome every naive model misprices, and 1X2 markets
 * price it to the half-percent. A model that nails the home/away split but
 * leaks two points of draw probability is systematically wrong on a quarter
 * of all matches. Dixon–Coles fixes exactly the four cells where the
 * dependence shows — (0,0), (1,0), (0,1), (1,1) — with the τ factor:
 *
 *   τ(0,0) = 1 − λhλaρ     τ(0,1) = 1 + λhρ
 *   τ(1,0) = 1 + λaρ       τ(1,1) = 1 − ρ
 *
 * With football's empirical ρ < 0, probability moves INTO 0-0 and 1-1 and out
 * of 1-0/0-1: the draw rises, the narrow wins fall, and everything above two
 * goals is untouched. The four adjustments cancel analytically (each is
 * ±λhλaρ·e^{−λh−λa}), so τ reshapes the distribution without changing its
 * total mass.
 *
 * Everything here is pure. Time enters only through the explicit `asOf` in
 * the fit config — never through a clock.
 */

import { InsufficientDataError, invariant } from '@/core/errors'
import { DAY_MS } from '@/core/clock'
import { shrinkToPrior } from '@/core/prediction/probability'
import type { FinishedGame } from './elo'

// ---------------------------------------------------------------------------
// Poisson pmf — log-space for numerical safety
// ---------------------------------------------------------------------------

/**
 * ln(k!) by direct summation. Exact-in-spirit for the k ≤ ~20 this model ever
 * sees (score matrices truncate at 10 goals); no Stirling approximation and
 * no factorial overflow at any k.
 */
function logFactorial(k: number): number {
  invariant(Number.isInteger(k) && k >= 0, 'logFactorial requires a non-negative integer')
  let acc = 0
  for (let i = 2; i <= k; i++) acc += Math.log(i)
  return acc
}

/**
 * Poisson pmf P(X = k | λ), computed in LOG space:
 *
 *   ln p = k·ln λ − λ − ln k!
 *
 * then exponentiated once at the end. The naive λ^k / k! form multiplies a
 * potentially large power by a potentially huge factorial and hopes they
 * cancel — at football λs it happens to survive, but the log form costs
 * nothing and is safe for ANY λ a caller feeds it, which is the difference
 * between "works on the inputs we tested" and "total".
 */
export function poissonPmf(k: number, lambda: number): number {
  invariant(Number.isInteger(k) && k >= 0, 'poissonPmf requires a non-negative integer k')
  invariant(lambda > 0, 'poissonPmf requires a positive lambda')
  return Math.exp(k * Math.log(lambda) - lambda - logFactorial(k))
}

// ---------------------------------------------------------------------------
// Attack/defence fitting
// ---------------------------------------------------------------------------

export interface PoissonFitConfig {
  /**
   * The evaluation instant (epoch ms). Games after `asOf` are EXCLUDED from
   * the fit entirely — the lookahead guard. A strength that saw tomorrow's
   * result makes every backtest a measurement of hindsight.
   */
  readonly asOf: number
  /**
   * Time-decay rate ξ in w(g) = exp(−ξ · daysAgo). Dixon & Coles (1997)
   * found that down-weighting stale games materially improved forecast
   * likelihood — teams change (transfers, managers, injuries), so last
   * season's thrashings are weak evidence about next weekend. ξ = 0.0065
   * gives a half-life of ln2/0.0065 ≈ 107 days: the current half-season
   * dominates, and games a full year old retain under 10% of their weight.
   */
  readonly xi?: number
  /** Coordinate-ascent sweep cap — the fit refuses to loop forever. */
  readonly maxIterations?: number
  /** Max per-parameter change at which a sweep counts as converged. */
  readonly tolerance?: number
  /**
   * Effective prior sample for shrinking fitted strengths toward 1.0 (league
   * average). See fitAttackDefence for why this exists.
   */
  readonly shrinkPriorWeight?: number
}

export const DEFAULT_XI = 0.0065
const DEFAULT_MAX_ITERATIONS = 100
const DEFAULT_TOLERANCE = 1e-6
const DEFAULT_SHRINK_PRIOR_WEIGHT = 6

/** One team's serialisable fitted state. */
export interface AttackDefenceEntry {
  /** Multiplicative attack strength; 1.0 = league average. */
  readonly attack: number
  /** Multiplicative defence WEAKNESS; 1.0 = league average, >1 = leaky. */
  readonly defence: number
  /** Raw count of fitted games. */
  readonly games: number
  /** Decay-weighted game count — the honest sample size behind the strengths. */
  readonly effectiveGames: number
}

/**
 * The fitted table. Unknown teams read as exactly league average (1.0/1.0)
 * with zero games — the maximally-ignorant answer, and `gamesFitted` is the
 * flag that tells callers it IS ignorance rather than measurement.
 */
export interface AttackDefenceFit {
  attack(teamId: string): number
  defence(teamId: string): number
  gamesFitted(teamId: string): number
  effectiveGames(teamId: string): number
  /** Multiplicative home advantage on the home side's λ (>1 in every league). */
  readonly homeAdvantage: number
  /** Decay-weighted league mean goals per team per game — the λ base rate. */
  readonly leagueAvg: number
  readonly converged: boolean
  readonly iterations: number
  readonly teamIds: readonly string[]
  snapshot(): Readonly<Record<string, AttackDefenceEntry>>
}

/**
 * Fit attack/defence strengths + home advantage by weighted maximum
 * likelihood, via the classic iterative re-estimation (coordinate ascent —
 * each parameter family has a closed-form weighted-Poisson update given the
 * others, so no gradients are needed):
 *
 *   λ_home(g) = μ · H · α_home · δ_away        λ_away(g) = μ · α_away · δ_home
 *
 *   α_i ← Σ w·goals_i / Σ w·μ·H(g,i)·δ_opp     (and symmetrically for δ, H)
 *
 * where w(g) = exp(−ξ·daysAgo). After each sweep α and δ are renormalised to
 * mean 1 (the model is only identified up to a scale, which is absorbed into
 * μ), and the sweep repeats until the largest parameter change drops below
 * tolerance or the iteration cap is hit.
 *
 * SHRINKAGE, applied after convergence: each strength is pulled toward 1.0
 * with `shrinkToPrior`, using the team's decay-weighted game count as the
 * sample size. This is a deliberate departure from the pure MLE — a team with
 * 3 games and a lucky 3.0 goals/game would otherwise get an attack strength
 * near 2, and the ML machinery has no idea that three games is mostly
 * variance. With the default prior weight of 6, three games move a team less
 * than halfway from "league average" toward its observed rate; the bias this
 * introduces is tiny next to the variance it removes, which is the same
 * trade Dixon–Coles themselves made with the decay weights.
 */
export function fitAttackDefence(
  games: readonly FinishedGame[],
  config: PoissonFitConfig,
): AttackDefenceFit {
  const xi = config.xi ?? DEFAULT_XI
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const tolerance = config.tolerance ?? DEFAULT_TOLERANCE
  const shrinkPriorWeight = config.shrinkPriorWeight ?? DEFAULT_SHRINK_PRIOR_WEIGHT
  invariant(xi >= 0, 'fitAttackDefence requires a non-negative decay rate')
  invariant(maxIterations > 0, 'fitAttackDefence requires a positive iteration cap')

  // Lookahead guard: nothing after asOf may influence the fit.
  const usable = games.filter((g) => g.kickoff <= config.asOf)
  if (usable.length === 0) {
    throw new InsufficientDataError('finished games on or before asOf')
  }

  // Decay weight per game. daysAgo is floored at 0 by the filter above.
  const weights = usable.map((g) => Math.exp((-xi * (config.asOf - g.kickoff)) / DAY_MS))

  // Weighted league environment: mean goals per TEAM per game.
  let weightTotal = 0
  let goalTotal = 0
  usable.forEach((g, i) => {
    const w = weights[i] ?? 0
    weightTotal += w
    goalTotal += w * (g.homeScore + g.awayScore)
  })
  let leagueAvg = goalTotal / (2 * weightTotal)
  if (leagueAvg <= 0) {
    // A history of exclusively 0-0s gives the Poisson model nothing to scale;
    // the multiplicative structure degenerates and any λ would be fabricated.
    throw new InsufficientDataError('non-zero league scoring rate')
  }

  // Parameter state, initialised at the maximally-ignorant point: every team
  // exactly league average, home advantage read straight off the raw ratio.
  const teamIds = [...new Set(usable.flatMap((g) => [g.homeTeamId, g.awayTeamId]))]
  const attack = new Map<string, number>(teamIds.map((id) => [id, 1]))
  const defence = new Map<string, number>(teamIds.map((id) => [id, 1]))
  let weightedAwayGoals = 0
  usable.forEach((g, i) => (weightedAwayGoals += (weights[i] ?? 0) * g.awayScore))
  let homeAdvantage = weightedAwayGoals > 0 ? (goalTotal - weightedAwayGoals) / weightedAwayGoals : 1.3

  // Per-team bookkeeping for the closed-form updates and the shrinkage.
  const rawGames = new Map<string, number>()
  const effGames = new Map<string, number>()
  for (const id of teamIds) {
    rawGames.set(id, 0)
    effGames.set(id, 0)
  }
  usable.forEach((g, i) => {
    const w = weights[i] ?? 0
    rawGames.set(g.homeTeamId, (rawGames.get(g.homeTeamId) ?? 0) + 1)
    rawGames.set(g.awayTeamId, (rawGames.get(g.awayTeamId) ?? 0) + 1)
    effGames.set(g.homeTeamId, (effGames.get(g.homeTeamId) ?? 0) + w)
    effGames.set(g.awayTeamId, (effGames.get(g.awayTeamId) ?? 0) + w)
  })

  let converged = false
  let iterations = 0

  for (let iter = 0; iter < maxIterations && !converged; iter++) {
    iterations = iter + 1
    let maxChange = 0
    const bump = (before: number, after: number): void => {
      maxChange = Math.max(maxChange, Math.abs(after - before))
    }

    // --- Attack sweep (Gauss–Seidel: each update sees the latest others) ----
    for (const id of teamIds) {
      let scored = 0
      let exposure = 0
      usable.forEach((g, i) => {
        const w = weights[i] ?? 0
        if (g.homeTeamId === id) {
          scored += w * g.homeScore
          exposure += w * leagueAvg * homeAdvantage * (defence.get(g.awayTeamId) ?? 1)
        } else if (g.awayTeamId === id) {
          scored += w * g.awayScore
          exposure += w * leagueAvg * (defence.get(g.homeTeamId) ?? 1)
        }
      })
      if (exposure <= 0) continue // no usable exposure — leave the prior 1.0
      const next = scored / exposure
      bump(attack.get(id) ?? 1, next)
      attack.set(id, next)
    }

    // --- Defence sweep ------------------------------------------------------
    for (const id of teamIds) {
      let conceded = 0
      let exposure = 0
      usable.forEach((g, i) => {
        const w = weights[i] ?? 0
        if (g.homeTeamId === id) {
          conceded += w * g.awayScore
          exposure += w * leagueAvg * (attack.get(g.awayTeamId) ?? 1)
        } else if (g.awayTeamId === id) {
          conceded += w * g.homeScore
          exposure += w * leagueAvg * homeAdvantage * (attack.get(g.homeTeamId) ?? 1)
        }
      })
      if (exposure <= 0) continue
      const next = conceded / exposure
      bump(defence.get(id) ?? 1, next)
      defence.set(id, next)
    }

    // --- Home advantage sweep ----------------------------------------------
    let homeGoals = 0
    let homeExposure = 0
    usable.forEach((g, i) => {
      const w = weights[i] ?? 0
      homeGoals += w * g.homeScore
      homeExposure += w * leagueAvg * (attack.get(g.homeTeamId) ?? 1) * (defence.get(g.awayTeamId) ?? 1)
    })
    if (homeExposure > 0) {
      const next = homeGoals / homeExposure
      bump(homeAdvantage, next)
      homeAdvantage = next
    }

    // --- Identifiability normalisation --------------------------------------
    // The likelihood is invariant under α → cα, μ → μ/c (and likewise δ), so
    // without pinning the scale the parameters would drift while the fit
    // stood still. Mean-1 strengths keep "1.0 = league average" true by
    // construction, and the scale is absorbed into μ so predictions are
    // unchanged.
    const meanAttack = meanOfMap(attack)
    const meanDefence = meanOfMap(defence)
    if (meanAttack > 0 && meanDefence > 0) {
      for (const id of teamIds) {
        attack.set(id, (attack.get(id) ?? 1) / meanAttack)
        defence.set(id, (defence.get(id) ?? 1) / meanDefence)
      }
      leagueAvg *= meanAttack * meanDefence
    }

    converged = maxChange < tolerance
  }

  // Post-fit shrinkage toward league average — see the function comment.
  for (const id of teamIds) {
    const eff = effGames.get(id) ?? 0
    attack.set(id, shrinkToPrior(attack.get(id) ?? 1, eff, 1, shrinkPriorWeight))
    defence.set(id, shrinkToPrior(defence.get(id) ?? 1, eff, 1, shrinkPriorWeight))
  }

  return {
    attack: (teamId) => attack.get(teamId) ?? 1,
    defence: (teamId) => defence.get(teamId) ?? 1,
    gamesFitted: (teamId) => rawGames.get(teamId) ?? 0,
    effectiveGames: (teamId) => effGames.get(teamId) ?? 0,
    homeAdvantage,
    leagueAvg,
    converged,
    iterations,
    teamIds,
    snapshot: () => {
      const out: Record<string, AttackDefenceEntry> = {}
      for (const id of teamIds) {
        out[id] = {
          attack: attack.get(id) ?? 1,
          defence: defence.get(id) ?? 1,
          games: rawGames.get(id) ?? 0,
          effectiveGames: effGames.get(id) ?? 0,
        }
      }
      return out
    },
  }
}

function meanOfMap(values: ReadonlyMap<string, number>): number {
  if (values.size === 0) return 1
  let sum = 0
  for (const v of values.values()) sum += v
  return sum / values.size
}

// ---------------------------------------------------------------------------
// λ construction
// ---------------------------------------------------------------------------

/** Floor/ceiling for a side's expected goals — beyond these, inputs are broken. */
const LAMBDA_MIN = 0.05
const LAMBDA_MAX = 6

/**
 * Expected goals for one side: λ = leagueAvg · homeAdvantage · attack · defence,
 * where `attack` is the scoring side's strength and `defence` the OPPONENT's
 * weakness. Pass homeAdvantage = 1 for the away side — the advantage is a
 * property of the venue, not of the team, so it multiplies exactly one λ.
 *
 * Clamped into [0.05, 6]: outside that range the inputs are broken, and a
 * degenerate λ would silently produce a degenerate score matrix downstream
 * rather than a visible failure here.
 */
export function expectedGoals(
  attack: number,
  defence: number,
  leagueAvg: number,
  homeAdvantage: number,
): number {
  invariant(leagueAvg > 0, 'expectedGoals requires a positive league average')
  invariant(homeAdvantage > 0, 'expectedGoals requires a positive home advantage multiplier')
  const lambda = leagueAvg * homeAdvantage * attack * defence
  return Math.min(LAMBDA_MAX, Math.max(LAMBDA_MIN, lambda))
}

// ---------------------------------------------------------------------------
// Score matrix
// ---------------------------------------------------------------------------

/** matrix[homeGoals][awayGoals] = P(that exact scoreline). Sums to 1. */
export type PoissonScoreMatrix = readonly (readonly number[])[]

/**
 * Football's empirical ρ. Dixon & Coles (1997) estimated ≈ −0.13 on English
 * league data; replications on modern European seasons land in −0.10..−0.16.
 * −0.11 sits at the conservative end of that band — the correction is real
 * but modest, and overstating it manufactures draws that are not there.
 */
export const DEFAULT_RHO = -0.11

/**
 * Build the Dixon–Coles score matrix: independent Poisson cells with the τ
 * correction applied to the (0,0), (1,0), (0,1), (1,1) corner, truncated at
 * `maxGoals` per side and renormalised to sum to exactly 1.
 *
 * Why τ, in one sentence: independence underestimates low-score draws (0-0,
 * 1-1) because level games turn cagey, and the draw is where football
 * predictions live or die — see the module header for the long version.
 *
 * ρ is clamped into its admissible range — the range where every τ cell stays
 * non-negative: ρ ∈ [max(−1/λh, −1/λa), min(1, 1/(λhλa))]. The default −0.11
 * is comfortably inside it for any realistic λ pair; the clamp only bites on
 * degenerate inputs, where it keeps the matrix a valid distribution instead
 * of quietly emitting a negative "probability".
 *
 * The renormalisation folds the truncation tail (P(a side scores > maxGoals),
 * ~1e-5 at football λs with maxGoals 10) back over the matrix, so consumers
 * can treat it as THE complete joint distribution and every aggregator below
 * is a plain sum — the coherence guarantee (1X2 + O/U + BTTS all from one
 * distribution) rests on that.
 */
export function scoreMatrix(
  lambdaHome: number,
  lambdaAway: number,
  rho: number = DEFAULT_RHO,
  maxGoals = 10,
): PoissonScoreMatrix {
  invariant(lambdaHome > 0 && lambdaAway > 0, 'scoreMatrix requires positive lambdas')
  invariant(Number.isInteger(maxGoals) && maxGoals >= 2, 'scoreMatrix requires integer maxGoals >= 2')

  const rhoLo = Math.max(-1 / lambdaHome, -1 / lambdaAway)
  const rhoHi = Math.min(1, 1 / (lambdaHome * lambdaAway))
  const safeRho = Math.min(rhoHi, Math.max(rhoLo, rho))

  // Precompute the two marginal pmfs once — the matrix is their outer product
  // except in the τ corner.
  const pmfHome: number[] = []
  const pmfAway: number[] = []
  for (let k = 0; k <= maxGoals; k++) {
    pmfHome.push(poissonPmf(k, lambdaHome))
    pmfAway.push(poissonPmf(k, lambdaAway))
  }

  const cells: number[][] = []
  let total = 0
  for (let h = 0; h <= maxGoals; h++) {
    const row: number[] = []
    for (let a = 0; a <= maxGoals; a++) {
      const cell = (pmfHome[h] ?? 0) * (pmfAway[a] ?? 0) * tau(h, a, lambdaHome, lambdaAway, safeRho)
      row.push(cell)
      total += cell
    }
    cells.push(row)
  }

  invariant(total > 0, 'scoreMatrix produced no probability mass')
  return cells.map((row) => row.map((p) => p / total))
}

/** The Dixon–Coles correction factor τ. 1 everywhere outside the 2×2 corner. */
function tau(
  home: number,
  away: number,
  lambdaHome: number,
  lambdaAway: number,
  rho: number,
): number {
  if (home === 0 && away === 0) return 1 - lambdaHome * lambdaAway * rho
  if (home === 0 && away === 1) return 1 + lambdaHome * rho
  if (home === 1 && away === 0) return 1 + lambdaAway * rho
  if (home === 1 && away === 1) return 1 - rho
  return 1
}

// ---------------------------------------------------------------------------
// Market read-off — everything from the SAME joint distribution
// ---------------------------------------------------------------------------

export interface MatchOutcomes {
  readonly home: number
  readonly draw: number
  readonly away: number
  /** Over/under 2.5 total goals. */
  readonly over25: number
  readonly under25: number
  /** Both teams to score. */
  readonly bttsYes: number
  readonly bttsNo: number
}

/**
 * Read 1X2, over/under 2.5 and BTTS off one score matrix.
 *
 * All three markets are sums over the SAME cells, which is the point: they
 * are jointly coherent by construction. Three independently-estimated markets
 * can quietly contradict each other (a 55% home win with a 70% under 2.5 and
 * a 65% BTTS-yes is close to impossible), and a consumer combining them would
 * inherit the contradiction. Here, home + draw + away = 1 and
 * over25 + under25 = 1 to floating-point precision because the matrix itself
 * sums to 1.
 */
export function matrixToOutcomes(matrix: PoissonScoreMatrix): MatchOutcomes {
  invariant(matrix.length > 0, 'matrixToOutcomes requires a non-empty matrix')

  let home = 0
  let draw = 0
  let away = 0
  let over25 = 0
  let bttsYes = 0

  matrix.forEach((row, h) => {
    row.forEach((p, a) => {
      if (h > a) home += p
      else if (h === a) draw += p
      else away += p
      if (h + a > 2.5) over25 += p
      if (h > 0 && a > 0) bttsYes += p
    })
  })

  // Normalise by the actual matrix mass so the complements are exact even if
  // a caller hands us an unnormalised matrix.
  const total = home + draw + away
  invariant(total > 0, 'matrixToOutcomes requires positive probability mass')

  return {
    home: home / total,
    draw: draw / total,
    away: away / total,
    over25: over25 / total,
    under25: 1 - over25 / total,
    bttsYes: bttsYes / total,
    bttsNo: 1 - bttsYes / total,
  }
}
