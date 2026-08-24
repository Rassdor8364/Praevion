/**
 * predictMatch — the Phase-2 pure football ensemble.
 *
 * Three models, three DIFFERENT kinds of evidence, one pooled 1X2:
 *
 *   (a) Dixon–Coles  — jointly fitted attack/defence rates (what teams score)
 *   (b) Elo–Davidson — the full trajectory of results (who beats whom)
 *   (c) Form/venue   — the recent-window heuristic (who is trending)
 *
 * Diversity is the point: models built on the same evidence agree for free,
 * and their agreement means nothing. These three can genuinely disagree, and
 * when they do, the ensemble's agreement measure — and therefore confidence —
 * says so.
 *
 * This module is PURE and returns a rich INTERNAL result, deliberately NOT a
 * VixeraPrediction: buildPrediction requires provenance (SourceRefs, data
 * mode, fetch timestamps), and provenance is a property of I/O that a pure
 * engine has no honest access to. Fabricating it here would defeat the entire
 * boundary-measured data-mode design. The orchestrator, which did the
 * fetching, maps this result plus its provenance into the universal object.
 *
 * Time enters exclusively via `asOf`. No clock, no randomness, no network —
 * identical inputs produce identical predictions, which is what makes a
 * backtest of this function meaningful.
 */

import { InsufficientDataError } from '@/core/errors'
import { DAY_MS } from '@/core/clock'
import {
  computeConfidence,
  type ConfidenceBreakdown,
  type ConfidenceInputs,
} from '@/core/prediction/confidence'
import { combineModels } from '@/core/prediction/ensemble'
import { fairDecimalOdds, shrinkToPrior, softmax } from '@/core/prediction/probability'
import type { ModelOutput, Outcome, PredictionFactor } from '@/core/prediction/types'
import { abstain, emit } from '@/engines/model'
import type { TeamGameStats } from '@/providers/types'
import { MODEL_VERSION } from './config/football'
import {
  DEFAULT_ELO_CONFIG,
  eloExpectedScore,
  eloWinDrawLoss,
  fitElo,
  type EloConfig,
  type FinishedGame,
} from './elo'
import { formRawComposite, formScore, type FormScoreConfig, type VixeraFormScore } from './form'
import {
  DEFAULT_RHO,
  DEFAULT_XI,
  expectedGoals,
  fitAttackDefence,
  matrixToOutcomes,
  scoreMatrix,
  type AttackDefenceFit,
} from './poisson'

export const MATCH_OUTCOME_KEYS = ['home', 'draw', 'away'] as const

export interface MatchPredictionConfig {
  readonly elo: EloConfig
  /** Dixon–Coles time-decay ξ — see poisson.ts for the 107-day half-life. */
  readonly xi: number
  readonly rho: number
  readonly maxGoals: number
  readonly shrinkPriorWeight: number
  /** Below this many games per side, every model abstains. */
  readonly minGames: number
  /** §9 form weights + decay, applied over the derived game windows. */
  readonly formDecayLambda: number
  /**
   * H2H shrink prior weight. Deliberately harsh: five meetings across four
   * seasons with different squads is weak evidence, and the plan explicitly
   * warns against letting a folklore rivalry stat outshout the models.
   */
  readonly h2hPriorWeight: number
  /** Hard ceiling on the H2H factor's contribution, in probability points. */
  readonly h2hContributionCap: number
}

export const DEFAULT_MATCH_PREDICTION_CONFIG: MatchPredictionConfig = {
  elo: DEFAULT_ELO_CONFIG,
  xi: DEFAULT_XI,
  rho: DEFAULT_RHO,
  maxGoals: 10,
  shrinkPriorWeight: 6,
  minGames: 5,
  formDecayLambda: 0.18,
  h2hPriorWeight: 6,
  h2hContributionCap: 0.03,
}

export interface MatchPredictionParams {
  readonly homeTeamId: string
  readonly awayTeamId: string
  readonly homeTeamName?: string
  readonly awayTeamName?: string
  /** Each team's own finished-game history (any competition). */
  readonly homeGames: readonly FinishedGame[]
  readonly awayGames: readonly FinishedGame[]
  /** The league's finished games — the joint-fit substrate for DC and Elo. */
  readonly leagueGames: readonly FinishedGame[]
  /** The evaluation instant. Games after this are invisible — the lookahead guard. */
  readonly asOf: number
  /** Epoch ms of the current season's start, for the regime-stability term. */
  readonly seasonStart: number
  readonly config?: Partial<MatchPredictionConfig>
}

/** Secondary markets, read off the Dixon–Coles joint distribution. */
export interface MatchMarkets {
  readonly over25: number
  readonly under25: number
  readonly bttsYes: number
  readonly bttsNo: number
}

export interface MatchPredictionResult {
  readonly outcomes: readonly Outcome[]
  readonly modelOutputs: readonly ModelOutput[]
  readonly modelAgreement: number
  readonly effectiveModelCount: number
  readonly confidence: number
  readonly confidenceBreakdown: ConfidenceBreakdown
  /** The raw inputs fed to computeConfidence — the orchestrator's audit trail. */
  readonly confidenceInputs: ConfidenceInputs
  /** 0..100 feature-sufficiency score (provenance quality is measured upstream). */
  readonly dataQuality: number
  /**
   * Signed toward the HOME side (positive favours home). The orchestrator
   * splits supporting/opposing relative to the leading outcome.
   */
  readonly factors: readonly PredictionFactor[]
  readonly sampleSize: number
  /**
   * Null when the DC model abstained. These come from the DC joint
   * distribution ALONE — Elo and the form heuristic have no goals dimension —
   * so they are coherent with the DC 1X2, not with the pooled one, and must
   * be presented as model-derived rather than ensemble-derived.
   */
  readonly markets: MatchMarkets | null
  /** Fitted expected goals per side, null when DC abstained. */
  readonly lambdas: { readonly home: number; readonly away: number } | null
  readonly modelVersion: string
}

// ---------------------------------------------------------------------------
// Form/venue heuristic constants — the documented linear score
// ---------------------------------------------------------------------------
//
// The third model is deliberately simple: score_home = β·formGap + η,
// score_draw = δ, score_away = −β·formGap, softmaxed into 1X2.
//
//   β (form gap → score): 1.1 per full 0..1 form gap. A total form mismatch
//     (100 vs 0) moves the home score by ~1.1 nats — roughly 75/25 before the
//     draw takes its share. Form windows are a handful of games, so the slope
//     is kept moderate.
//   η (home advantage): 0.30 nats, chosen so an even fixture lands near the
//     big-league empirical base rates (~43% home, ~26% draw, ~31% away).
//   δ (draw intercept): −0.19, calibrated jointly with η against the same
//     ~26% even-fixture draw rate.
//
// It exists as a sanity anchor: when both sophisticated models chase a noisy
// fit, a transparent heuristic pulling toward base rates keeps the pool
// honest — and when IT disagrees with THEM, agreement (and confidence) drops.
const FORM_GAP_BETA = 1.1
const HOME_ADV_ETA = 0.3
const DRAW_DELTA = -0.19

/** Saturating sample-confidence curve shared by all three models, capped
 *  well below 1 — a single model over one fixture never deserves certainty. */
function historyConfidence(sampleSize: number): number {
  return Math.min(0.85, Math.max(0.05, sampleSize / (sampleSize + 8)))
}

/**
 * Run one model body, converting InsufficientDataError into a proper
 * abstention. Abstention is not a neutral vote — combineModels removes the
 * model from the pool entirely, and the confidence layer sees the gap.
 * Any OTHER error is a bug and keeps propagating loudly.
 */
function runModel(modelId: string, body: () => ModelOutput): ModelOutput {
  try {
    return body()
  } catch (error) {
    if (error instanceof InsufficientDataError) {
      return abstain(modelId, MODEL_VERSION, MATCH_OUTCOME_KEYS, error.message)
    }
    throw error
  }
}

/** A team's derived view of a FinishedGame history: box-score rows plus the
 *  gameId → opponent map the form engine's strength callback needs. */
interface TeamView {
  /** Most-recent-first, matching the form engine's ordering contract. */
  readonly stats: readonly TeamGameStats[]
  readonly opponentByGameId: ReadonlyMap<string, string>
  /** Kickoff of the most recent game, or null with no history. */
  readonly lastKickoff: number | null
}

/** Deterministic synthetic id for a FinishedGame (it carries none itself). */
function syntheticGameId(game: FinishedGame): string {
  return `${game.homeTeamId}@${game.awayTeamId}@${game.kickoff}`
}

/**
 * Derive a team's box-score window from raw FinishedGames.
 *
 * The derived rows carry NO xG — FinishedGame is scores-only, which is the
 * honest shape of our free-tier feeds. The form engine's per-game weight
 * redistribution (the abstention pattern) absorbs that; nothing here invents
 * an expected-goals number to fill the field.
 */
function teamView(games: readonly FinishedGame[], teamId: string, asOf: number): TeamView {
  const involved = games
    .filter((g) => g.kickoff <= asOf && (g.homeTeamId === teamId || g.awayTeamId === teamId))
    .sort((a, b) => b.kickoff - a.kickoff)

  const opponentByGameId = new Map<string, string>()
  const stats: TeamGameStats[] = involved.map((g) => {
    const isHome = g.homeTeamId === teamId
    const scored = isHome ? g.homeScore : g.awayScore
    const conceded = isHome ? g.awayScore : g.homeScore
    const gameId = syntheticGameId(g)
    opponentByGameId.set(gameId, isHome ? g.awayTeamId : g.homeTeamId)
    return {
      gameId,
      teamId,
      isHome,
      scored,
      conceded,
      result: scored > conceded ? 'W' : scored === conceded ? 'D' : 'L',
      shots: null,
      shotsOnTarget: null,
      possession: null,
      expectedGoalsFor: null,
      expectedGoalsAgainst: null,
      extra: {},
    }
  })

  return {
    stats,
    opponentByGameId,
    lastKickoff: involved.length > 0 ? (involved[0]?.kickoff ?? null) : null,
  }
}

export function predictMatch(params: MatchPredictionParams): MatchPredictionResult {
  const cfg: MatchPredictionConfig = { ...DEFAULT_MATCH_PREDICTION_CONFIG, ...params.config }
  const { asOf } = params
  const homeLabel = params.homeTeamName ?? params.homeTeamId
  const awayLabel = params.awayTeamName ?? params.awayTeamId

  // Lookahead guard on every input window.
  const league = params.leagueGames.filter((g) => g.kickoff <= asOf)
  const homeHistory = params.homeGames.filter((g) => g.kickoff <= asOf)
  const awayHistory = params.awayGames.filter((g) => g.kickoff <= asOf)
  const sampleSize = Math.min(homeHistory.length, awayHistory.length)

  // --- Shared fitted artefacts ---------------------------------------------
  // Elo over the league history (an empty history yields an empty table —
  // the Elo model then abstains on the isRated flag).
  const eloTable = fitElo(league, cfg.elo)

  // Dixon–Coles joint fit; an empty league is an abstention, not a crash.
  let dcFit: AttackDefenceFit | null = null
  try {
    dcFit = fitAttackDefence(league, {
      asOf,
      xi: cfg.xi,
      shrinkPriorWeight: cfg.shrinkPriorWeight,
    })
  } catch (error) {
    if (!(error instanceof InsufficientDataError)) throw error
  }

  // Opponent quality for the form composite: the Elo table's view of the
  // opponent, as P(opponent beats a league-average side, neutral venue).
  // Unrated opponents read exactly 0.5 — "we know nothing" is the median.
  const strengthOf = (view: TeamView) => (gameId: string): number => {
    const opponentId = view.opponentByGameId.get(gameId)
    if (opponentId === undefined || !eloTable.isRated(opponentId)) return 0.5
    return eloExpectedScore(eloTable.rating(opponentId), cfg.elo.initialRating, 0)
  }

  const homeView = teamView(homeHistory, params.homeTeamId, asOf)
  const awayView = teamView(awayHistory, params.awayTeamId, asOf)

  // League raw-form distribution, so the two teams' scores are squashed
  // against the league they actually play in rather than a fixed centre.
  const leagueTeamIds = [...new Set(league.flatMap((g) => [g.homeTeamId, g.awayTeamId]))]
  const leagueRaws = leagueTeamIds.map((teamId) => {
    const view = teamView(league, teamId, asOf)
    return formRawComposite(view.stats, strengthOf(view)).raw
  })

  const formCfg: FormScoreConfig = {
    weights: {
      resultPoints: 0.4,
      normalizedGoalDiff: 0.25,
      opponentStrength: 0.2,
      performanceVsExpected: 0.15,
    },
    decayLambda: cfg.formDecayLambda,
    minGames: cfg.minGames,
    leagueRaws,
  }
  const homeForm = formScore(homeView.stats, strengthOf(homeView), formCfg, asOf)
  const awayForm = formScore(awayView.stats, strengthOf(awayView), formCfg, asOf)

  // Surfaced from the DC model closure for the result's secondary markets.
  let markets: MatchMarkets | null = null
  let lambdas: { home: number; away: number } | null = null

  // --- The three models ------------------------------------------------------
  const modelOutputs: ModelOutput[] = [
    runModel('football.dixon-coles', () => {
      if (dcFit === null) throw new InsufficientDataError('league games for the Dixon–Coles fit')
      const fitted = Math.min(
        dcFit.gamesFitted(params.homeTeamId),
        dcFit.gamesFitted(params.awayTeamId),
      )
      if (fitted < cfg.minGames) {
        throw new InsufficientDataError(
          `${cfg.minGames} fitted games per side (have ${fitted})`,
        )
      }

      const lambdaHome = expectedGoals(
        dcFit.attack(params.homeTeamId),
        dcFit.defence(params.awayTeamId),
        dcFit.leagueAvg,
        dcFit.homeAdvantage,
      )
      const lambdaAway = expectedGoals(
        dcFit.attack(params.awayTeamId),
        dcFit.defence(params.homeTeamId),
        dcFit.leagueAvg,
        1,
      )
      const outcomes = matrixToOutcomes(scoreMatrix(lambdaHome, lambdaAway, cfg.rho, cfg.maxGoals))
      markets = {
        over25: outcomes.over25,
        under25: outcomes.under25,
        bttsYes: outcomes.bttsYes,
        bttsNo: outcomes.bttsNo,
      }
      lambdas = { home: lambdaHome, away: lambdaAway }

      // Real partial contributions: hold one channel at league average and
      // measure how much the fitted rates move the home probability. These
      // are computed counterfactuals, not narrated guesses.
      const neutralHome = expectedGoals(1, 1, dcFit.leagueAvg, dcFit.homeAdvantage)
      const neutralAway = expectedGoals(1, 1, dcFit.leagueAvg, 1)
      const baseline = matrixToOutcomes(
        scoreMatrix(neutralHome, neutralAway, cfg.rho, cfg.maxGoals),
      )
      const attackOnly = matrixToOutcomes(
        scoreMatrix(lambdaHome, neutralAway, cfg.rho, cfg.maxGoals),
      )
      const defenceOnly = matrixToOutcomes(
        scoreMatrix(neutralHome, lambdaAway, cfg.rho, cfg.maxGoals),
      )

      return emit({
        modelId: 'football.dixon-coles',
        version: MODEL_VERSION,
        outcomes: [
          { key: 'home', label: homeLabel, probability: outcomes.home },
          { key: 'draw', label: 'Draw', probability: outcomes.draw },
          { key: 'away', label: awayLabel, probability: outcomes.away },
        ],
        confidence: historyConfidence(fitted),
        factors: [
          {
            id: 'dc-attacking-output',
            label: 'Attacking output',
            contribution: attackOnly.home - baseline.home,
            detail: `Home xG rate ${lambdaHome.toFixed(2)} vs league-average ${neutralHome.toFixed(2)}`,
            evidenceStrength: historyConfidence(fitted),
          },
          {
            id: 'dc-defensive-record',
            label: 'Defensive record',
            contribution: defenceOnly.home - baseline.home,
            detail: `Away xG rate ${lambdaAway.toFixed(2)} vs league-average ${neutralAway.toFixed(2)}`,
            evidenceStrength: historyConfidence(fitted),
          },
        ],
      })
    }),

    runModel('football.elo-davidson', () => {
      if (!eloTable.isRated(params.homeTeamId) || !eloTable.isRated(params.awayTeamId)) {
        throw new InsufficientDataError('an Elo rating for both sides')
      }
      const rated = Math.min(
        eloTable.gamesRated(params.homeTeamId),
        eloTable.gamesRated(params.awayTeamId),
      )
      if (rated < cfg.minGames) {
        throw new InsufficientDataError(`${cfg.minGames} rated games per side (have ${rated})`)
      }

      const ratingHome = eloTable.rating(params.homeTeamId)
      const ratingAway = eloTable.rating(params.awayTeamId)
      const full = eloWinDrawLoss(ratingHome, ratingAway, cfg.elo)

      // Counterfactual decomposition: neutral-venue-even-ratings → add the
      // rating gap → add the venue. Each factor is a measured difference.
      const neutralCfg: EloConfig = { ...cfg.elo, homeAdvantage: 0 }
      const even = eloWinDrawLoss(cfg.elo.initialRating, cfg.elo.initialRating, neutralCfg)
      const gapOnly = eloWinDrawLoss(ratingHome, ratingAway, neutralCfg)

      return emit({
        modelId: 'football.elo-davidson',
        version: MODEL_VERSION,
        outcomes: [
          { key: 'home', label: homeLabel, probability: full.home },
          { key: 'draw', label: 'Draw', probability: full.draw },
          { key: 'away', label: awayLabel, probability: full.away },
        ],
        confidence: historyConfidence(rated),
        factors: [
          {
            id: 'elo-rating-gap',
            label: 'Rating difference',
            contribution: gapOnly.home - even.home,
            detail: `Elo ${ratingHome.toFixed(0)} vs ${ratingAway.toFixed(0)} (neutral venue)`,
            evidenceStrength: historyConfidence(rated),
          },
          {
            id: 'elo-home-advantage',
            label: 'Home advantage',
            contribution: full.home - gapOnly.home,
            detail: `Venue offset worth ${cfg.elo.homeAdvantage} Elo points`,
            evidenceStrength: 0.9,
          },
        ],
      })
    }),

    runModel('football.form-venue', () => {
      if (homeForm.insufficient || awayForm.insufficient) {
        throw new InsufficientDataError(
          `${cfg.minGames} games of form per side (have ${sampleSize})`,
        )
      }

      const gap = (homeForm.score - awayForm.score) / 100
      const probsOf = (g: number, eta: number): number[] =>
        softmax([FORM_GAP_BETA * g + eta, DRAW_DELTA, -FORM_GAP_BETA * g])
      const probs = probsOf(gap, HOME_ADV_ETA)
      const evenVenue = probsOf(0, HOME_ADV_ETA)
      const evenNeutral = probsOf(0, 0)

      return emit({
        modelId: 'football.form-venue',
        version: MODEL_VERSION,
        outcomes: [
          { key: 'home', label: homeLabel, probability: probs[0] ?? 0 },
          { key: 'draw', label: 'Draw', probability: probs[1] ?? 0 },
          { key: 'away', label: awayLabel, probability: probs[2] ?? 0 },
        ],
        // The heuristic is transparent but shallow — its self-confidence is
        // deliberately the lowest of the pool.
        confidence: 0.6 * historyConfidence(sampleSize),
        factors: [
          {
            id: 'form-gap',
            label: 'Recent form',
            contribution: (probs[0] ?? 0) - (evenVenue[0] ?? 0),
            detail: `Form ${homeForm.score.toFixed(0)} vs ${awayForm.score.toFixed(0)} (no xG in feed)`,
            evidenceStrength: historyConfidence(sampleSize),
          },
          {
            id: 'venue',
            label: 'Home advantage',
            contribution: (evenVenue[0] ?? 0) - (evenNeutral[0] ?? 0),
            detail: 'Softmax venue intercept, calibrated to big-league base rates',
            evidenceStrength: 0.9,
          },
        ],
      })
    }),
  ]

  // --- Pool -------------------------------------------------------------------
  const ensemble = combineModels(modelOutputs, MATCH_OUTCOME_KEYS, {
    home: homeLabel,
    draw: 'Draw',
    away: awayLabel,
  })

  // --- Confidence --------------------------------------------------------------
  // Feature completeness over the groups this pipeline EXPECTS. xG and the
  // injury feed are hardcoded false today because FinishedGame carries scores
  // only and no injuries provider exists — the flags must reflect that those
  // signals are missing, not quietly drop out of the denominator. When the
  // providers land, these become measured booleans and completeness rises for
  // real instead of by definition.
  const h2hMeetings = collectH2H(params, league, asOf)
  const completenessFlags = [
    homeHistory.length >= cfg.minGames,
    awayHistory.length >= cfg.minGames,
    false, // xG — not present in FinishedGame-based inputs
    false, // injuries/lineups — no provider yet
    h2hMeetings.total > 0,
  ]
  const featureCompleteness =
    completenessFlags.filter(Boolean).length / completenessFlags.length

  // Regime stability = 1 − a season-boundary penalty. When most of the
  // evidence predates the current season, the "regime" the models learned is
  // last season's squad — transfers, managerial changes and promoted
  // opposition all happened since. Early-season predictions ARE less
  // reliable, and this term says so instead of letting stale evidence wear
  // fresh confidence. Below 60% staleness the penalty is zero; from there it
  // ramps to a 0.5 stability floor when the history is entirely pre-season.
  const combinedHistory = [...homeHistory, ...awayHistory]
  const staleFraction =
    combinedHistory.length === 0
      ? 1
      : combinedHistory.filter((g) => g.kickoff < params.seasonStart).length /
        combinedHistory.length
  const regimeStability = 1 - (Math.max(0, staleFraction - 0.6) / 0.4) * 0.5

  // Engine-side data quality is feature SUFFICIENCY; freshness/reliability of
  // the providers is provenance, measured upstream where the I/O happened.
  const dataQuality = Math.round(
    100 * (0.45 * featureCompleteness + 0.55 * (sampleSize / (sampleSize + 6))),
  )

  const confidenceInputs: ConfidenceInputs = {
    dataQuality,
    modelAgreement: ensemble.modelAgreement,
    sampleSize,
    sampleSizeTarget: 12,
    featureCompleteness,
    effectiveModelCount: ensemble.effectiveModelCount,
    regimeStability,
  }
  const confidenceBreakdown = computeConfidence(confidenceInputs)

  // --- Prediction-level factors -----------------------------------------------
  const factors = buildFactors({
    params,
    cfg,
    eloTable,
    homeForm,
    awayForm,
    homeView,
    awayView,
    h2h: h2hMeetings,
    ensembleOutcomes: ensemble.outcomes,
    asOf,
  })

  return {
    outcomes: ensemble.outcomes,
    modelOutputs,
    modelAgreement: ensemble.modelAgreement,
    effectiveModelCount: ensemble.effectiveModelCount,
    confidence: confidenceBreakdown.confidence,
    confidenceBreakdown,
    confidenceInputs,
    dataQuality,
    factors,
    sampleSize,
    markets,
    lambdas,
    modelVersion: MODEL_VERSION,
  }
}

/**
 * Fair (margin-free) decimal odds for each pooled outcome — the number the
 * Vixera Edge comparison holds against the market's quoted price.
 */
export function fairOddsFor(
  prediction: Pick<MatchPredictionResult, 'outcomes'>,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const outcome of prediction.outcomes) {
    out[outcome.key] = fairDecimalOdds(outcome.probability)
  }
  return out
}

// ---------------------------------------------------------------------------
// H2H and factor assembly
// ---------------------------------------------------------------------------

interface H2HRecord {
  /** Wins by the UPCOMING home team, regardless of past venue. */
  readonly homeTeamWins: number
  readonly draws: number
  readonly awayTeamWins: number
  readonly total: number
}

/**
 * Collect head-to-head meetings from every supplied history, deduplicated —
 * the same fixture routinely appears in both a team history and the league
 * list, and double-counting would double the (already weak) H2H evidence.
 */
function collectH2H(
  params: MatchPredictionParams,
  league: readonly FinishedGame[],
  asOf: number,
): H2HRecord {
  const seen = new Set<string>()
  let homeTeamWins = 0
  let draws = 0
  let awayTeamWins = 0

  const pools = [league, params.homeGames, params.awayGames]
  for (const pool of pools) {
    for (const g of pool) {
      if (g.kickoff > asOf) continue
      const pair =
        (g.homeTeamId === params.homeTeamId && g.awayTeamId === params.awayTeamId) ||
        (g.homeTeamId === params.awayTeamId && g.awayTeamId === params.homeTeamId)
      if (!pair) continue
      const id = syntheticGameId(g)
      if (seen.has(id)) continue
      seen.add(id)

      const homeTeamScore = g.homeTeamId === params.homeTeamId ? g.homeScore : g.awayScore
      const awayTeamScore = g.homeTeamId === params.homeTeamId ? g.awayScore : g.homeScore
      if (homeTeamScore > awayTeamScore) homeTeamWins += 1
      else if (homeTeamScore === awayTeamScore) draws += 1
      else awayTeamWins += 1
    }
  }

  return { homeTeamWins, draws, awayTeamWins, total: homeTeamWins + draws + awayTeamWins }
}

function buildFactors(input: {
  params: MatchPredictionParams
  cfg: MatchPredictionConfig
  eloTable: ReturnType<typeof fitElo>
  homeForm: VixeraFormScore
  awayForm: VixeraFormScore
  homeView: TeamView
  awayView: TeamView
  h2h: H2HRecord
  ensembleOutcomes: readonly Outcome[]
  asOf: number
}): PredictionFactor[] {
  const { params, cfg, eloTable, homeForm, awayForm, h2h, ensembleOutcomes, asOf } = input
  const factors: PredictionFactor[] = []

  // All contributions are signed toward the HOME side; the orchestrator
  // orients them against the leading outcome when it splits
  // supporting/opposing for display.

  // --- Form gap ---------------------------------------------------------------
  if (homeForm.sampleSize > 0 && awayForm.sampleSize > 0) {
    factors.push({
      id: 'form-gap',
      label: 'Recent form',
      // A full 100-point form gap is worth ~25pp — form matters, but it is a
      // handful of games, not the whole story.
      contribution: ((homeForm.score - awayForm.score) / 100) * 0.25,
      detail: `Form ${homeForm.score.toFixed(0)} vs ${awayForm.score.toFixed(0)} (league-relative)`,
      evidenceStrength: Math.min(1, Math.min(homeForm.sampleSize, awayForm.sampleSize) / 8),
    })
  }

  // --- Elo gap ----------------------------------------------------------------
  if (eloTable.isRated(params.homeTeamId) && eloTable.isRated(params.awayTeamId)) {
    const ratingHome = eloTable.rating(params.homeTeamId)
    const ratingAway = eloTable.rating(params.awayTeamId)
    factors.push({
      id: 'elo-gap',
      label: 'Rating difference',
      // Venue-neutral expected-score edge over a coin flip, half-weighted
      // because the venue is priced separately below.
      contribution: (eloExpectedScore(ratingHome, ratingAway, 0) - 0.5) * 0.5,
      detail: `Elo ${ratingHome.toFixed(0)} vs ${ratingAway.toFixed(0)}`,
      evidenceStrength: Math.min(
        1,
        Math.min(eloTable.gamesRated(params.homeTeamId), eloTable.gamesRated(params.awayTeamId)) /
          15,
      ),
    })
  }

  // --- Home advantage -----------------------------------------------------------
  // Measured, not asserted: the Davidson home probability with and without
  // the venue offset, at the initial rating — a slowly-moving league prior.
  const withVenue = eloWinDrawLoss(cfg.elo.initialRating, cfg.elo.initialRating, cfg.elo)
  const neutral = eloWinDrawLoss(cfg.elo.initialRating, cfg.elo.initialRating, {
    ...cfg.elo,
    homeAdvantage: 0,
  })
  factors.push({
    id: 'home-advantage',
    label: 'Home advantage',
    contribution: withVenue.home - neutral.home,
    detail: `Venue offset of ${cfg.elo.homeAdvantage} Elo points`,
    evidenceStrength: 0.9,
  })

  // --- Head-to-head ----------------------------------------------------------------
  // The plan explicitly warns against overweighting H2H: a handful of
  // meetings across seasons with different squads is folklore-grade evidence.
  // Two independent brakes: the observed share is shrunk toward the model's
  // own prior with priorWeight 6, and whatever survives is HARD-CAPPED at
  // ±3pp. The cap is not redundant with the shrink — a long one-sided record
  // (10-0-0) would still earn ~9pp after shrinking, and no head-to-head
  // record deserves that much of the probability.
  if (h2h.total > 0) {
    const observedShare = (h2h.homeTeamWins + 0.5 * h2h.draws) / h2h.total
    const prior =
      (ensembleOutcomes.find((o) => o.key === 'home')?.probability ?? 1 / 3) +
      0.5 * (ensembleOutcomes.find((o) => o.key === 'draw')?.probability ?? 1 / 3)
    const shrunk = shrinkToPrior(observedShare, h2h.total, prior, cfg.h2hPriorWeight)
    const capped = Math.max(
      -cfg.h2hContributionCap,
      Math.min(cfg.h2hContributionCap, shrunk - prior),
    )
    factors.push({
      id: 'head-to-head',
      label: 'Head-to-head record',
      contribution: capped,
      detail: `${h2h.homeTeamWins}W-${h2h.draws}D-${h2h.awayTeamWins}L over ${h2h.total} meetings (shrunk, capped ±3pp)`,
      evidenceStrength: Math.min(0.5, h2h.total / (h2h.total + cfg.h2hPriorWeight)),
    })
  }

  // --- Schedule rest differential ----------------------------------------------------
  // Fixture-congestion studies find a real but SMALL effect (~fractions of a
  // point of expected margin per rest day), so the slope is 0.4pp/day capped
  // at ±2pp. Rest is capped at 14 days per side first: beyond two weeks the
  // gap is an international break or an off-season, not a recovery edge.
  const homeLast = input.homeView.lastKickoff
  const awayLast = input.awayView.lastKickoff
  if (homeLast !== null && awayLast !== null) {
    const restDays = (last: number): number => Math.min(14, Math.max(0, (asOf - last) / DAY_MS))
    const differential = restDays(homeLast) - restDays(awayLast)
    factors.push({
      id: 'rest-differential',
      label: 'Rest advantage',
      contribution: Math.max(-0.02, Math.min(0.02, differential * 0.004)),
      detail: `Home rested ${restDays(homeLast).toFixed(1)}d vs away ${restDays(awayLast).toFixed(1)}d`,
      evidenceStrength: 0.6,
    })
  }

  return factors
}
