/**
 * The two football PredictionModel implementations.
 *
 * Both run over the same frozen `MatchFeatures` snapshot and emit the same
 * three outcome keys, which is what lets the meta-combiner pool them. They are
 * deliberately built on DIFFERENT evidence — Dixon–Coles on recent scoring
 * rates, Elo on the full trajectory of results — so their agreement is
 * informative rather than an echo.
 *
 * Both abstain below `minGamesForModel` games of history per side. Per the
 * PredictionModel contract, a model that lacks its inputs does not emit 50% —
 * it steps out of the pool.
 */

import { abstain, emit, type ModelContext, type PredictionModel } from '@/engines/model'
import type { Outcome } from '@/core/prediction/types'
import type { Injury, TeamGameStats } from '@/providers/types'
import { FOOTBALL_CONFIG, type LeagueGoalMeans } from './config/football'
import { dixonColesMatrix, estimateTeamRates, matrixTo1X2, type OneXTwo } from './dixon-coles'
import { eloExpectedGoalDiff, type EloEntry } from './elo'

/** Head-to-head record between the two sides, from the home team's view. */
export interface HeadToHeadRecord {
  readonly homeWins: number
  readonly draws: number
  readonly awayWins: number
}

/**
 * The shared feature snapshot for one fixture. Assembled by the feature
 * builder (which owns all I/O); frozen by the time any model sees it.
 */
export interface MatchFeatures {
  readonly gameId: string
  readonly homeTeamId: string
  readonly awayTeamId: string
  readonly homeTeamName: string
  readonly awayTeamName: string
  /** Most-recent-first windows of finished games, one per side. */
  readonly homeStats: readonly TeamGameStats[]
  readonly awayStats: readonly TeamGameStats[]
  /** Opponent quality (0..100) keyed by gameId, for the form calculation. */
  readonly homeOpponentRatings: Readonly<Record<string, number>>
  readonly awayOpponentRatings: Readonly<Record<string, number>>
  /** Elo entries as of the evaluation instant; null when no rating exists. */
  readonly homeElo: EloEntry | null
  readonly awayElo: EloEntry | null
  readonly homeInjuries: readonly Injury[]
  readonly awayInjuries: readonly Injury[]
  readonly leagueMeans: LeagueGoalMeans
  /** Head-to-head record, or null when none is known. */
  readonly h2h: HeadToHeadRecord | null
}

export const FOOTBALL_OUTCOME_KEYS = ['home', 'draw', 'away'] as const

/** True only when every game in both windows carries xG. */
export function xgAvailable(features: MatchFeatures): boolean {
  const hasXg = (g: TeamGameStats): boolean =>
    g.expectedGoalsFor !== null && g.expectedGoalsAgainst !== null
  return (
    features.homeStats.length > 0 &&
    features.awayStats.length > 0 &&
    features.homeStats.every(hasXg) &&
    features.awayStats.every(hasXg)
  )
}

/**
 * Model self-confidence from evidence depth: saturating in the shorter side's
 * sample, discounted when xG is unavailable (the rates are then built on
 * goals alone, a noisier estimator of true scoring ability). Capped well below
 * 1 — a single model over one fixture never deserves certainty.
 */
function historyConfidence(sampleSize: number, hasXg: boolean): number {
  const sample = sampleSize / (sampleSize + 8)
  return Math.min(0.85, Math.max(0.05, sample * (hasXg ? 1 : 0.85)))
}

function toOutcomes(p: OneXTwo, features: MatchFeatures): Outcome[] {
  return [
    { key: 'home', label: features.homeTeamName, probability: p.home },
    { key: 'draw', label: 'Draw', probability: p.draw },
    { key: 'away', label: features.awayTeamName, probability: p.away },
  ]
}

/**
 * Dixon–Coles model: recent scoring rates → attack/defence λs → score matrix
 * → 1X2. The draw probability comes out of the corrected joint distribution,
 * not a constant.
 */
export const dixonColesModel: PredictionModel<MatchFeatures> = {
  id: 'football.dixon-coles',
  version: FOOTBALL_CONFIG.version,
  outcomeKeys: FOOTBALL_OUTCOME_KEYS,

  run(features: MatchFeatures, _ctx: ModelContext) {
    const sampleSize = Math.min(features.homeStats.length, features.awayStats.length)
    if (sampleSize < FOOTBALL_CONFIG.minGamesForModel) {
      return abstain(
        this.id,
        this.version,
        this.outcomeKeys,
        `needs ${FOOTBALL_CONFIG.minGamesForModel} games per side, have ${sampleSize}`,
      )
    }

    const rates = estimateTeamRates(
      features.homeStats,
      features.awayStats,
      features.leagueMeans,
      FOOTBALL_CONFIG.homeAdvantageGoals,
      FOOTBALL_CONFIG.rateShrinkPriorWeight,
    )
    const matrix = dixonColesMatrix(
      rates.lambdaHome,
      rates.lambdaAway,
      FOOTBALL_CONFIG.dixonColesRho,
      FOOTBALL_CONFIG.maxGoals,
    )

    return emit({
      modelId: this.id,
      version: this.version,
      outcomes: toOutcomes(matrixTo1X2(matrix), features),
      confidence: historyConfidence(sampleSize, xgAvailable(features)),
    })
  },
}

/**
 * Elo model: rating gap → expected goal margin → Dixon–Coles matrix → 1X2.
 *
 * The bridge through the DC matrix is the point of this model's design. Elo
 * natively answers only the binary "who is stronger" question; football needs
 * a draw probability, and bolting on a fixed draw constant would contradict
 * the margin (big favourites draw less often than even matches). Instead the
 * rating gap sets the MARGIN (λh − λa) while the league environment sets the
 * TOTAL (λh + λa), and the same corrected joint distribution used by the DC
 * model turns that into 1X2 — so the draw probability shrinks naturally as the
 * gap grows, and both models price the draw with consistent machinery.
 */
export const eloModel: PredictionModel<MatchFeatures> = {
  id: 'football.elo',
  version: FOOTBALL_CONFIG.version,
  outcomeKeys: FOOTBALL_OUTCOME_KEYS,

  run(features: MatchFeatures, _ctx: ModelContext) {
    if (features.homeElo === null || features.awayElo === null) {
      return abstain(this.id, this.version, this.outcomeKeys, 'missing Elo rating for a side')
    }
    const sampleSize = Math.min(features.homeElo.gamesPlayed, features.awayElo.gamesPlayed)
    if (sampleSize < FOOTBALL_CONFIG.minGamesForModel) {
      return abstain(
        this.id,
        this.version,
        this.outcomeKeys,
        `needs ${FOOTBALL_CONFIG.minGamesForModel} rated games per side, have ${sampleSize}`,
      )
    }

    const diff = eloExpectedGoalDiff(
      features.homeElo.rating,
      features.awayElo.rating,
      FOOTBALL_CONFIG.eloHomeAdvantage,
      FOOTBALL_CONFIG.eloPointsPerGoal,
    )
    // Margin from the ratings, total from the league environment. Both λs are
    // floored so an extreme rating gap degrades to "heavy favourite", never to
    // a degenerate zero-goal side.
    const total = features.leagueMeans.homeGoals + features.leagueMeans.awayGoals
    const lambdaHome = Math.max(0.1, (total + diff) / 2)
    const lambdaAway = Math.max(0.1, (total - diff) / 2)

    const matrix = dixonColesMatrix(
      lambdaHome,
      lambdaAway,
      FOOTBALL_CONFIG.dixonColesRho,
      FOOTBALL_CONFIG.maxGoals,
    )

    // Elo has no xG input — its discount is purely evidence depth. Rated-game
    // counts can be large, so the same saturating curve applies.
    return emit({
      modelId: this.id,
      version: this.version,
      outcomes: toOutcomes(matrixTo1X2(matrix), features),
      confidence: historyConfidence(sampleSize, true),
    })
  },
}
