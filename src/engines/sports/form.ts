/**
 * Vixera Form Score (0–100).
 *
 * An opponent-adjusted, recency-weighted composite of a team's recent
 * performances, per §9 of the implementation plan:
 *
 *   raw = Σ_g w(g) · [ 0.40·resultPoints(g)
 *                    + 0.25·normalizedGoalDiff(g)
 *                    + 0.20·opponentStrength(g)
 *                    + 0.15·performanceVsExpected(g) ]
 *   w(g) = exp(−λ · gamesAgo)
 *
 * then squashed to 0–100 via a league-relative logistic so 50 = the median
 * team in the league. The `performanceVsExpected` term is xG-based and is what
 * stops the score from being "recent results with extra steps": a team winning
 * 1–0 on 0.4 xG against 2.1 xG conceded scores high on results but low here,
 * and the composite declines even while the table flatters them.
 *
 * -----------------------------------------------------------------------------
 * Input ordering contract
 * -----------------------------------------------------------------------------
 * `games` is ordered MOST RECENT FIRST — index i is exactly `gamesAgo = i` in
 * the decay formula. TeamGameStats carries no timestamp, so this ordering
 * cannot be asserted here; the feature builder that assembles the window owns
 * it (and the Elo module's chronological guard protects the rating side).
 *
 * -----------------------------------------------------------------------------
 * Missing xG (the football-data.org free tier reality)
 * -----------------------------------------------------------------------------
 * When a game has no xG, its 0.15 weight is redistributed PROPORTIONALLY over
 * the other three components for that game, and the output is flagged
 * `xgAvailable: false` so downstream confidence knows the composite is running
 * on the shallower signal. Substituting a neutral 0.5 instead would silently
 * pull every xG-less team toward the median — a fabricated data point, not a
 * missing one.
 */

import { recencyWeight } from '@/core/prediction/probability'
import { sigmoid } from '@/core/prediction/probability'
import type { TeamGameStats } from '@/providers/types'
import { FOOTBALL_CONFIG, type FormComponentWeights, type SportConfig } from './config/football'

export interface FormComponents {
  /** Recency-weighted mean of result points (W=1, D=0.5, L=0), 0..1. */
  readonly resultPoints: number
  /** Recency-weighted mean of squashed goal difference, 0..1. */
  readonly normalizedGoalDiff: number
  /** Recency-weighted mean of opponent quality faced, 0..1. */
  readonly opponentStrength: number
  /** Recency-weighted mean of xG dominance, 0..1 — null when no game had xG. */
  readonly performanceVsExpected: number | null
}

export interface FormScore {
  /** 0..100, league-relative: 50 = median team. */
  readonly score: number
  readonly components: FormComponents
  /** Number of games behind the score — the confidence layer's input. */
  readonly sampleSize: number
  /** False when ANY game in the window lacked xG (strict, so confidence is honest). */
  readonly xgAvailable: boolean
}

/** Result → points on a 0..1 scale (the classic 3/1/0 rescaled). */
function resultPoints(result: TeamGameStats['result']): number {
  if (result === 'W') return 1
  if (result === 'D') return 0.5
  return 0
}

/**
 * Squash a goal-difference-like quantity into 0..1 via tanh.
 *
 * The divisor 3 means a +3 win maps to ~0.88 rather than 1.0 — winning by
 * three is very good, winning by six is only slightly better evidence, and a
 * linear map would let one freak scoreline own the whole window.
 */
function squashDiff(diff: number): number {
  return 0.5 * (1 + Math.tanh(diff / 3))
}

/**
 * Compute the Vixera Form Score for one team.
 *
 * @param games            Most-recent-first window of the team's finished games.
 * @param opponentRatings  Opponent quality (0..100) keyed by gameId. A missing
 *                         entry falls back to 50 — "we know nothing about this
 *                         opponent" is best modelled as "league median", and
 *                         the schedule-difficulty signal simply goes flat.
 * @param config           Sport config supplying λ, weights and squash params.
 */
export function computeFormScore(
  games: readonly TeamGameStats[],
  opponentRatings: Readonly<Record<string, number>>,
  config: SportConfig,
): FormScore {
  // No games is not an error: it is "no evidence of deviation from the
  // median", so the score sits at 50 and sampleSize 0 tells the confidence
  // layer exactly how little that means.
  if (games.length === 0) {
    return {
      score: 50,
      components: {
        resultPoints: 0.5,
        normalizedGoalDiff: 0.5,
        opponentStrength: 0.5,
        performanceVsExpected: null,
      },
      sampleSize: 0,
      xgAvailable: false,
    }
  }

  const w = config.formWeights

  // Accumulators for the composite and for the per-component report.
  let weightSum = 0
  let rawSum = 0
  let resultSum = 0
  let goalDiffSum = 0
  let opponentSum = 0
  let pveSum = 0
  let pveWeightSum = 0
  let allHaveXg = true

  games.forEach((game, gamesAgo) => {
    const weight = recencyWeight(gamesAgo, config.formDecayLambda)

    const result = resultPoints(game.result)
    const goalDiff = squashDiff(game.scored - game.conceded)
    // Opponent quality faced — the schedule-difficulty component. Two teams
    // with identical results get different form if one earned them against
    // stronger opposition.
    const opponent = clamp01((opponentRatings[game.gameId] ?? 50) / 100)

    // xG dominance: what SHOULD have happened. When results outrun xG this
    // component lags them and drags the composite down — the "fortunate win"
    // detector from the plan.
    const hasXg = game.expectedGoalsFor !== null && game.expectedGoalsAgainst !== null
    const pve = hasXg
      ? squashDiff((game.expectedGoalsFor ?? 0) - (game.expectedGoalsAgainst ?? 0))
      : null
    if (!hasXg) allHaveXg = false

    // Per-game composite. When xG is missing, its weight is redistributed
    // proportionally over the three available components (divide by their
    // weight total) rather than imputing a neutral value.
    let composite: number
    if (pve !== null) {
      composite =
        w.resultPoints * result +
        w.normalizedGoalDiff * goalDiff +
        w.opponentStrength * opponent +
        w.performanceVsExpected * pve
    } else {
      const available = w.resultPoints + w.normalizedGoalDiff + w.opponentStrength
      composite =
        (w.resultPoints * result + w.normalizedGoalDiff * goalDiff + w.opponentStrength * opponent) /
        available
    }

    weightSum += weight
    rawSum += weight * composite
    resultSum += weight * result
    goalDiffSum += weight * goalDiff
    opponentSum += weight * opponent
    if (pve !== null) {
      pveSum += weight * pve
      pveWeightSum += weight
    }
  })

  const raw = rawSum / weightSum

  // League-relative logistic squash: centred on the median team's raw value so
  // 50 always reads "median in this league", regardless of the league's
  // scoring environment.
  const score = 100 * sigmoid((raw - config.formLeagueMedianRaw) / config.formSquashScale)

  return {
    score,
    components: {
      resultPoints: resultSum / weightSum,
      normalizedGoalDiff: goalDiffSum / weightSum,
      opponentStrength: opponentSum / weightSum,
      performanceVsExpected: pveWeightSum > 0 ? pveSum / pveWeightSum : null,
    },
    sampleSize: games.length,
    xgAvailable: allHaveXg,
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5
  return Math.min(1, Math.max(0, x))
}

// ---------------------------------------------------------------------------
// Vixera Form Score — the pure-engine API (formScore / squashToLeague)
// ---------------------------------------------------------------------------
//
// computeFormScore above squashes against a CONFIGURED league centre; the API
// below squashes against the league's ACTUAL raw distribution, which is what
// the plan's "50 = league median" literally requires — a configured centre is
// only correct until the league's scoring environment drifts. The two share
// the per-game composite machinery (resultPoints / squashDiff) so the raw
// values are identical; only the squash reference differs.

export interface FormScoreConfig {
  /** §9 component weights (0.40 / 0.25 / 0.20 / 0.15). Must sum to 1. */
  readonly weights: FormComponentWeights
  /** Recency decay λ in w(g) = exp(−λ·gamesAgo). 0.18 ≈ 3.8-game half-life. */
  readonly decayLambda: number
  /** Below this many games the score is flagged insufficient (default 5). */
  readonly minGames: number
  /**
   * Raw composites of every team in the league, for the league-relative
   * squash. Empty is tolerated (squashToLeague falls back to a fixed centre)
   * but the score then measures "vs a neutral 0.5", not "vs this league".
   */
  readonly leagueRaws: readonly number[]
}

export const DEFAULT_FORM_SCORE_CONFIG: FormScoreConfig = {
  weights: FOOTBALL_CONFIG.formWeights,
  decayLambda: FOOTBALL_CONFIG.formDecayLambda,
  minGames: FOOTBALL_CONFIG.minGamesForModel,
  leagueRaws: [],
}

export interface VixeraFormComponents {
  /** Recency-weighted mean of result points (W=1, D=0.5, L=0), 0..1. */
  readonly resultPoints: number
  /** Recency-weighted mean of squashed goal difference, 0..1. */
  readonly normalizedGoalDiff: number
  /** Recency-weighted mean of opponent quality faced, 0..1. */
  readonly opponentStrength: number
  /** Recency-weighted mean of xG dominance — null when NO game carried xG. */
  readonly performanceVsExpected: number | null
}

export interface VixeraFormScore {
  /** 0..100, league-relative: 50 = the median team in `leagueRaws`. */
  readonly score: number
  /** The pre-squash composite, 0..1 — what squashToLeague was fed. */
  readonly raw: number
  readonly components: VixeraFormComponents
  readonly sampleSize: number
  /**
   * True below `minGames`. Callers MUST NOT display a score when this is set
   * — two games of form is a coin-flip narrative, and rendering it as a
   * confident 0–100 number is how products lie with small samples.
   */
  readonly insufficient: boolean
  /** Fraction of the window's games that carried xG, 0..1. */
  readonly xgCoverage: number
}

/**
 * League-relative logistic squash: 50 = the league's median raw composite.
 *
 * The scale is set from the league's own IQR so that the QUARTILE teams land
 * at exactly 25 and 75: a logistic distribution's quartiles sit at
 * ±ln(3)·scale from its centre, so scale = IQR / (2·ln 3) aligns the model's
 * quartiles with the league's. That makes the number self-calibrating — a
 * tight league spreads its teams across the same 0–100 range as a lopsided
 * one, and "68" means the same thing ("upper quartile-ish") in both.
 *
 * Fallback: with fewer than 4 league values (or a degenerate zero IQR) the
 * quartiles are not estimable, so we squash against a fixed centre of 0.5
 * with the configured-scale default — clearly weaker, but honest: the output
 * is then "vs neutral", and callers who need "vs league" must supply a league.
 */
export function squashToLeague(raw: number, leagueRaws: readonly number[]): number {
  const FALLBACK_SCALE = 0.12 // matches FOOTBALL_CONFIG.formSquashScale rationale

  if (leagueRaws.length < 4) {
    return 100 * sigmoid((raw - 0.5) / FALLBACK_SCALE)
  }

  const sorted = [...leagueRaws].sort((a, b) => a - b)
  const median = quantileOf(sorted, 0.5)
  const iqr = quantileOf(sorted, 0.75) - quantileOf(sorted, 0.25)
  // Logistic quartiles sit at ±ln(3)·scale, so this puts the league's
  // quartile teams at exactly 25 and 75. Zero IQR (every team identical —
  // synthetic data, tiny samples) falls back to the fixed scale.
  const scale = iqr > 1e-9 ? iqr / (2 * Math.log(3)) : FALLBACK_SCALE
  return 100 * sigmoid((raw - median) / scale)
}

/** Linear-interpolated quantile of a pre-sorted array. */
function quantileOf(sorted: readonly number[], q: number): number {
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = sorted[lo] ?? 0
  const b = sorted[hi] ?? a
  return a + (b - a) * (pos - lo)
}

/**
 * The raw (pre-squash) form composite — exposed so a caller can build the
 * league distribution that squashToLeague needs: compute every team's raw,
 * then squash each against the collection.
 *
 * Implements the plan's weighted composite exactly:
 *
 *   raw = Σ_g w(g)·[0.40·resultPoints + 0.25·normalizedGoalDiff
 *                  + 0.20·opponentStrength + 0.15·performanceVsExpected]
 *   w(g) = exp(−0.18·gamesAgo)
 *
 * xG-missing games (the ESPN/football-data free tier has NO xG) redistribute
 * the 0.15 weight PROPORTIONALLY over the other three components for that
 * game. This is the abstention pattern again, not a silent zero: a missing
 * measurement steps out of the average, it does not vote. Substituting a
 * neutral value instead would drag every xG-less team toward the median —
 * fabricated data wearing a real number's clothes — and zeroing the term
 * would punish teams for our provider's gaps.
 *
 * @param opponentStrength Opponent quality 0..1 keyed by GAME id — the box
 *   score does not carry the opponent's team id, so lookups are keyed by the
 *   game; callers with team-keyed strength close over a gameId→teamId map.
 */
export function formRawComposite(
  teamGames: readonly TeamGameStats[],
  opponentStrength: (gameId: string) => number,
  config: FormScoreConfig = DEFAULT_FORM_SCORE_CONFIG,
): { raw: number; components: VixeraFormComponents; xgCoverage: number } {
  const w = config.weights

  let weightSum = 0
  let rawSum = 0
  let resultSum = 0
  let goalDiffSum = 0
  let opponentSum = 0
  let pveSum = 0
  let pveWeightSum = 0
  let xgGames = 0

  teamGames.forEach((game, gamesAgo) => {
    const weight = recencyWeight(gamesAgo, config.decayLambda)

    const result = resultPoints(game.result)
    const goalDiff = squashDiff(game.scored - game.conceded)
    const opponent = clamp01(opponentStrength(game.gameId))

    const hasXg = game.expectedGoalsFor !== null && game.expectedGoalsAgainst !== null
    const pve = hasXg
      ? squashDiff((game.expectedGoalsFor ?? 0) - (game.expectedGoalsAgainst ?? 0))
      : null
    if (hasXg) xgGames += 1

    // Per-game composite; on missing xG the remaining three weights are
    // renormalised (divide by their own total) so they still sum to 1.
    let composite: number
    if (pve !== null) {
      composite =
        w.resultPoints * result +
        w.normalizedGoalDiff * goalDiff +
        w.opponentStrength * opponent +
        w.performanceVsExpected * pve
    } else {
      const available = w.resultPoints + w.normalizedGoalDiff + w.opponentStrength
      composite =
        (w.resultPoints * result + w.normalizedGoalDiff * goalDiff + w.opponentStrength * opponent) /
        available
    }

    weightSum += weight
    rawSum += weight * composite
    resultSum += weight * result
    goalDiffSum += weight * goalDiff
    opponentSum += weight * opponent
    if (pve !== null) {
      pveSum += weight * pve
      pveWeightSum += weight
    }
  })

  if (weightSum === 0) {
    return {
      raw: 0.5,
      components: {
        resultPoints: 0.5,
        normalizedGoalDiff: 0.5,
        opponentStrength: 0.5,
        performanceVsExpected: null,
      },
      xgCoverage: 0,
    }
  }

  return {
    raw: rawSum / weightSum,
    components: {
      resultPoints: resultSum / weightSum,
      normalizedGoalDiff: goalDiffSum / weightSum,
      opponentStrength: opponentSum / weightSum,
      performanceVsExpected: pveWeightSum > 0 ? pveSum / pveWeightSum : null,
    },
    xgCoverage: teamGames.length === 0 ? 0 : xgGames / teamGames.length,
  }
}

/**
 * The Vixera Form Score, 0–100 and league-relative.
 *
 * @param teamGames Most-recent-first window of the team's finished games —
 *   index i is exactly `gamesAgo = i` in the decay. The box score carries no
 *   timestamps, so ordering is the assembler's contract, not assertable here.
 * @param opponentStrength Opponent quality 0..1, keyed by gameId (see
 *   formRawComposite for why the key is the game, not the opponent).
 * @param _asOf The evaluation instant (epoch ms). Time enters every engine
 *   through an explicit parameter for signature stability and backtest
 *   replay; the decay itself is games-based per the plan (the box score has
 *   no timestamps), so the parameter anchors the call site today and becomes
 *   load-bearing the day per-game timestamps land — never a clock either way.
 */
export function formScore(
  teamGames: readonly TeamGameStats[],
  opponentStrength: (gameId: string) => number,
  config: FormScoreConfig = DEFAULT_FORM_SCORE_CONFIG,
  _asOf?: number,
): VixeraFormScore {
  const { raw, components, xgCoverage } = formRawComposite(teamGames, opponentStrength, config)
  return {
    score: squashToLeague(raw, config.leagueRaws),
    raw,
    components,
    sampleSize: teamGames.length,
    insufficient: teamGames.length < config.minGames,
    xgCoverage,
  }
}
