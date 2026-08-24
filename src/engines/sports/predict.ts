/**
 * predictMatch — the football orchestration point.
 *
 * Runs both PredictionModels over one frozen MatchFeatures snapshot, pools
 * them with the core meta-combiner, computes confidence from the evidence
 * actually present, attaches human-readable factors, and returns a full
 * VixeraPrediction via the one sanctioned constructor.
 *
 * Pure: the evaluation instant comes from ModelContext/Clock, provenance
 * (SourceRefs) is passed in by the caller who did the I/O, and identical
 * inputs produce identical predictions — which is what makes a backtest of
 * this function meaningful.
 */

import type { Clock } from '@/core/clock'
import { computeConfidence } from '@/core/prediction/confidence'
import { combineModels } from '@/core/prediction/ensemble'
import { shrinkToPrior } from '@/core/prediction/probability'
import { buildPrediction } from '@/core/prediction/builder'
import type { PredictionFactor, SourceRef, VixeraPrediction } from '@/core/prediction/types'
import type { ModelContext } from '@/engines/model'
import type { Injury } from '@/providers/types'
import { FOOTBALL_CONFIG, type SportConfig } from './config/football'
import { eloWinProbability } from './elo'
import { computeFormScore } from './form'
import { dixonColesModel, eloModel, xgAvailable, FOOTBALL_OUTCOME_KEYS, type MatchFeatures } from './models'

/** How many games per side removes the sample-size confidence penalty. */
const SAMPLE_SIZE_TARGET = 12

/** Injury severity weights, mirroring the strength engine's health component. */
const INJURY_BURDEN: Record<Injury['status'], number> = {
  out: 1.0,
  suspended: 1.0,
  doubtful: 0.6,
  questionable: 0.35,
  probable: 0.15,
}

export function predictMatch(
  features: MatchFeatures,
  ctx: ModelContext,
  clock: Clock,
  sources: readonly SourceRef[],
  config: SportConfig = FOOTBALL_CONFIG,
): VixeraPrediction {
  // 1) Run the pool. Abstentions stay in the array — the combiner excludes
  //    them from the vote but the prediction records that they abstained.
  const modelOutputs = [dixonColesModel.run(features, ctx), eloModel.run(features, ctx)]

  const ensemble = combineModels(modelOutputs, FOOTBALL_OUTCOME_KEYS, {
    home: features.homeTeamName,
    draw: 'Draw',
    away: features.awayTeamName,
  })

  // 2) Evidence bookkeeping for confidence and data quality.
  const sampleSize = Math.min(features.homeStats.length, features.awayStats.length)
  const hasXg = xgAvailable(features)

  // Feature completeness: the fraction of the feature groups this pipeline
  // expects that are actually usable. Presence of an empty injuries array is
  // not counted — we cannot distinguish "no injuries" from "no injury feed"
  // at this layer, so injuries do not appear in the completeness measure.
  const completenessFlags = [
    features.homeStats.length >= config.minGamesForModel,
    features.awayStats.length >= config.minGamesForModel,
    features.homeElo !== null && features.awayElo !== null,
    features.h2h !== null,
    hasXg,
  ]
  const featureCompleteness = completenessFlags.filter(Boolean).length / completenessFlags.length

  // Engine-side data quality: a feature-sufficiency score. Freshness,
  // reliability and corroboration are provenance concerns measured by the
  // core data-quality engine upstream; here we can only score whether the
  // features themselves were deep enough to model from.
  const dataQuality = Math.round(
    100 * (0.45 * featureCompleteness + 0.55 * (sampleSize / (sampleSize + 6))),
  )

  const confidence = computeConfidence({
    dataQuality,
    modelAgreement: ensemble.modelAgreement,
    sampleSize,
    sampleSizeTarget: SAMPLE_SIZE_TARGET,
    featureCompleteness,
    effectiveModelCount: ensemble.effectiveModelCount,
    // Football has no volatility-regime concept yet; regime change (new
    // manager, transfer window) is handled by the form decay, so this term is
    // neutral rather than a pretended measurement.
    regimeStability: 1,
  })

  // 3) Factors — the explainable "why" attached to the prediction.
  const factors = buildFactors(features, ensemble.outcomes, config)

  return buildPrediction({
    id: `sports-${features.gameId}-${ctx.runId}`,
    domain: 'sports',
    subject: `game:${features.gameId}`,
    subjectLabel: `${features.homeTeamName} vs ${features.awayTeamName}`,
    timeframe: 'event',
    outcomes: ensemble.outcomes,
    confidence: confidence.confidence,
    dataQuality,
    modelAgreement: ensemble.modelAgreement,
    factors,
    modelOutputs,
    sources,
    scenarios: null,
    volatility: null,
    modelVersion: `${config.sport}-${config.version}`,
    clock,
  })
}

/**
 * Build the factor list. Contributions are signed toward the LEADING outcome:
 * a home-favouring signal is positive when home leads and negative (opposing)
 * when away leads. When the draw leads, home-orientation is used — "supports
 * the home side" remains the most legible reading for a drawish market.
 */
function buildFactors(
  features: MatchFeatures,
  outcomes: readonly { key: string; probability: number }[],
  config: SportConfig,
): PredictionFactor[] {
  const leading = outcomes.reduce((a, b) => (b.probability > a.probability ? b : a))
  // +1 when a home-favouring signal supports the leading outcome, −1 when it
  // opposes it (away leading), and home-oriented for a leading draw.
  const direction = leading.key === 'away' ? -1 : 1

  const factors: PredictionFactor[] = []

  // --- Form gap --------------------------------------------------------------
  const homeForm = computeFormScore(features.homeStats, features.homeOpponentRatings, config)
  const awayForm = computeFormScore(features.awayStats, features.awayOpponentRatings, config)
  const formGap = homeForm.score - awayForm.score
  if (homeForm.sampleSize > 0 && awayForm.sampleSize > 0) {
    factors.push({
      id: 'form-gap',
      label: 'Recent form',
      // A full 100-point form gap is worth ~25pp — form matters but it is a
      // window of a handful of games, not the whole story.
      contribution: direction * (formGap / 100) * 0.25,
      detail: `Form ${homeForm.score.toFixed(0)} vs ${awayForm.score.toFixed(0)}${homeForm.xgAvailable ? '' : ' (no xG data)'}`,
      evidenceStrength: Math.min(1, Math.min(homeForm.sampleSize, awayForm.sampleSize) / 8),
    })
  }

  // --- Elo gap -----------------------------------------------------------------
  if (features.homeElo !== null && features.awayElo !== null) {
    const pElo = eloWinProbability(
      features.homeElo.rating,
      features.awayElo.rating,
      config.eloHomeAdvantage,
    )
    factors.push({
      id: 'elo-gap',
      label: 'Rating difference',
      // Elo's expected-score edge over a coin flip, half-weighted since the
      // rating already includes the venue offset counted separately below.
      contribution: direction * (pElo - 0.5) * 0.5,
      detail: `Elo ${features.homeElo.rating.toFixed(0)} vs ${features.awayElo.rating.toFixed(0)}`,
      evidenceStrength: Math.min(
        1,
        Math.min(features.homeElo.gamesPlayed, features.awayElo.gamesPlayed) / 15,
      ),
    })
  }

  // --- Home advantage -------------------------------------------------------------
  // +0.25 goals of margin is worth roughly +6pp on the home win across the
  // realistic λ range — a well-established, slowly-moving prior.
  factors.push({
    id: 'home-advantage',
    label: 'Home advantage',
    contribution: direction * 0.06 * (config.homeAdvantageGoals / 0.25),
    detail: `Playing at home is worth ~${config.homeAdvantageGoals.toFixed(2)} goals of expected margin`,
    evidenceStrength: 0.9,
  })

  // --- Injuries ----------------------------------------------------------------------
  const homeBurden = injuryBurden(features.homeInjuries)
  const awayBurden = injuryBurden(features.awayInjuries)
  if (features.homeInjuries.length > 0 || features.awayInjuries.length > 0) {
    // Positive when the AWAY side is more depleted (favours home). ~2pp per
    // net fully-missing player, capped — injury reports are noisy and
    // player-importance-blind at this layer.
    const net = awayBurden - homeBurden
    factors.push({
      id: 'injury-impact',
      label: 'Availability',
      contribution: direction * Math.max(-0.08, Math.min(0.08, net * 0.02)),
      detail: `Weighted absences — home ${homeBurden.toFixed(1)}, away ${awayBurden.toFixed(1)}`,
      evidenceStrength: 0.5,
    })
  }

  // --- Head-to-head -------------------------------------------------------------------
  // §7 of the original brief: do NOT overweight H2H. Five meetings across four
  // seasons with different squads is weak evidence, so the observed H2H home
  // share is shrunk hard toward the model's own home probability with
  // priorWeight 8 — the factor can only ever be the small residual the record
  // earns after that shrink.
  if (features.h2h !== null) {
    const meetings = features.h2h.homeWins + features.h2h.draws + features.h2h.awayWins
    if (meetings > 0) {
      const observedShare = (features.h2h.homeWins + 0.5 * features.h2h.draws) / meetings
      const prior = (outcomes.find((o) => o.key === 'home')?.probability ?? 1 / 3) + 0.5 * (outcomes.find((o) => o.key === 'draw')?.probability ?? 1 / 3)
      const shrunk = shrinkToPrior(observedShare, meetings, prior, config.h2hPriorWeight)
      factors.push({
        id: 'head-to-head',
        label: 'Head-to-head record',
        contribution: direction * (shrunk - prior),
        detail: `${features.h2h.homeWins}W-${features.h2h.draws}D-${features.h2h.awayWins}L over ${meetings} meetings (shrunk)` ,
        evidenceStrength: Math.min(0.5, meetings / (meetings + config.h2hPriorWeight)),
      })
    }
  }

  return factors
}

function injuryBurden(injuries: readonly Injury[]): number {
  let burden = 0
  for (const injury of injuries) burden += INJURY_BURDEN[injury.status]
  return burden
}
