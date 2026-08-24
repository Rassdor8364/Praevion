/**
 * football.learned — the trainable statistical model (Model E).
 *
 * A regularized multinomial logistic regression over pre-match features,
 * trained on the league's own completed games and applied to the upcoming
 * fixture. Unlike the hand-specified models (Dixon–Coles, Elo, form), every
 * coefficient here is LEARNED from historical observations — this is the
 * model that makes "Praevion measures whether its signals actually predict
 * outcomes" literally true, because a feature that does not predict outcomes
 * earns a coefficient near zero and the UI can show that.
 *
 * TEMPORAL INTEGRITY IS STRUCTURAL, NOT POLICED. The feature builder scans
 * the league history once in kickoff order, and each training sample's
 * features are read from the accumulator state BEFORE that game updates it.
 * There is no way to write a feature that has seen its own label, because at
 * the moment features are read the game has not been applied yet. The
 * fixture's own features are read from the state after every game ≤ asOf —
 * the same rule the live system operates under. Leakage tests assert both.
 *
 * Pure: time enters via `asOf`, determinism is inherited from the trainer
 * (full-batch descent, zero init — no randomness anywhere).
 */

import { DAY_MS } from '@/core/clock'
import {
  predictProbabilities,
  trainMultinomialLogistic,
  type LogisticModel,
  type TrainingSample,
} from '@/core/learning/logistic'
import { walkForwardValidate, type WalkForwardResult } from '@/core/learning/walk-forward'
import type { ModelOutput, PredictionFactor } from '@/core/prediction/types'
import { abstain, emit } from '@/engines/model'
import type { FinishedGame } from './elo'

export const LEARNED_MODEL_ID = 'football.learned'
export const LEARNED_MODEL_VERSION = 'learned-lr-1.0.0'

/** Class order everywhere in this module. */
export const LEARNED_CLASSES = ['home', 'draw', 'away'] as const

// ---------------------------------------------------------------------------
// Feature definitions
// ---------------------------------------------------------------------------

/**
 * The named feature list — the single source of truth for order, display
 * labels and scaling. Interpretability is a product requirement (§20): every
 * entry here surfaces in the UI as "what drove this prediction", so features
 * must stay nameable in one plain sentence.
 */
export const LEARNED_FEATURES = [
  { id: 'elo-diff', label: 'Elo rating difference' },
  { id: 'form-ppg-diff', label: 'Recency-weighted points-per-game difference' },
  { id: 'venue-ppg-diff', label: 'Home-venue vs away-venue points difference' },
  { id: 'goal-diff-rate', label: 'Recency-weighted goal-difference rate gap' },
  { id: 'rest-diff', label: 'Rest-days differential' },
] as const

export const LEARNED_FEATURE_COUNT = LEARNED_FEATURES.length

// Incremental Elo used ONLY as a feature stream. Deliberately simple and
// fixed: K=20, 60-point home advantage in the expectation (so ratings are not
// venue-biased), draws worth half. The ensemble's real Elo model has its own
// fitted table; re-deriving a small one here keeps this module one-pass and
// self-contained instead of O(n²) refits per training sample.
const ELO_K = 20
const ELO_HOME_ADV = 60
const ELO_INITIAL = 1500

/** Per-game exponential decay for the rolling averages: γ = 0.92 gives a
 *  half-life of ~8.3 games — recent form dominates, one season fades. */
const DECAY = 0.92

/** Rest-days cap: beyond two weeks the gap is a break, not a recovery edge. */
const REST_CAP_DAYS = 14

interface DecayedMean {
  sum: number
  weight: number
}

function decayedPush(m: DecayedMean, value: number): void {
  m.sum = m.sum * DECAY + value
  m.weight = m.weight * DECAY + 1
}

function decayedValue(m: DecayedMean, fallback: number): number {
  return m.weight > 0 ? m.sum / m.weight : fallback
}

interface TeamState {
  elo: number
  games: number
  points: DecayedMean
  homePoints: DecayedMean
  awayPoints: DecayedMean
  goalDiff: DecayedMean
  lastKickoff: number | null
}

function newTeamState(): TeamState {
  return {
    elo: ELO_INITIAL,
    games: 0,
    points: { sum: 0, weight: 0 },
    homePoints: { sum: 0, weight: 0 },
    awayPoints: { sum: 0, weight: 0 },
    goalDiff: { sum: 0, weight: 0 },
    lastKickoff: null,
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

/**
 * The mutable league accumulator. `featuresFor` reads the current state;
 * `apply` folds one finished game in. The one-pass builders below own the
 * ordering discipline; this class just holds the arithmetic.
 */
class LeagueState {
  private readonly teams = new Map<string, TeamState>()

  private team(id: string): TeamState {
    let t = this.teams.get(id)
    if (t === undefined) {
      t = newTeamState()
      this.teams.set(id, t)
    }
    return t
  }

  gamesSeen(teamId: string): number {
    return this.teams.get(teamId)?.games ?? 0
  }

  /** Pre-match feature vector for home vs away at instant `atMs`. */
  featuresFor(homeId: string, awayId: string, atMs: number): number[] {
    const home = this.team(homeId)
    const away = this.team(awayId)

    const restDays = (t: TeamState): number =>
      t.lastKickoff === null
        ? REST_CAP_DAYS
        : clamp((atMs - t.lastKickoff) / DAY_MS, 0, REST_CAP_DAYS)

    return [
      clamp((home.elo - away.elo) / 400, -1.5, 1.5),
      clamp((decayedValue(home.points, 1.35) - decayedValue(away.points, 1.35)) / 3, -1, 1),
      clamp(
        (decayedValue(home.homePoints, 1.5) - decayedValue(away.awayPoints, 1.2)) / 3,
        -1,
        1,
      ),
      clamp((decayedValue(home.goalDiff, 0) - decayedValue(away.goalDiff, 0)) / 3, -1, 1),
      (restDays(home) - restDays(away)) / REST_CAP_DAYS,
    ]
  }

  apply(game: FinishedGame): void {
    const home = this.team(game.homeTeamId)
    const away = this.team(game.awayTeamId)

    const homeWin = game.homeScore > game.awayScore
    const draw = game.homeScore === game.awayScore

    // Elo update (venue-adjusted expectation, raw ratings).
    const expectedHome = 1 / (1 + 10 ** (-(home.elo + ELO_HOME_ADV - away.elo) / 400))
    const actualHome = homeWin ? 1 : draw ? 0.5 : 0
    const shift = ELO_K * (actualHome - expectedHome)
    home.elo += shift
    away.elo -= shift

    const homePts = homeWin ? 3 : draw ? 1 : 0
    const awayPts = draw ? 1 : homeWin ? 0 : 3
    decayedPush(home.points, homePts)
    decayedPush(away.points, awayPts)
    decayedPush(home.homePoints, homePts)
    decayedPush(away.awayPoints, awayPts)
    decayedPush(home.goalDiff, game.homeScore - game.awayScore)
    decayedPush(away.goalDiff, game.awayScore - game.homeScore)

    home.games += 1
    away.games += 1
    home.lastKickoff = game.kickoff
    away.lastKickoff = game.kickoff
  }
}

// ---------------------------------------------------------------------------
// Training-set and fixture-feature builders
// ---------------------------------------------------------------------------

export interface LearnedSample extends TrainingSample {
  /** Kickoff of the labelled game — the walk-forward timestamp. */
  readonly timestamp: number
}

export interface LearnedTrainingSet {
  readonly samples: readonly LearnedSample[]
  /** Games skipped because a side lacked `minPriorGames` history. */
  readonly skippedColdStart: number
}

/**
 * Build the training set from a league history: one sample per finished game
 * where BOTH sides had at least `minPriorGames` completed games beforehand.
 * Features are read pre-update — see the module header for why that ordering
 * is the leakage guard.
 */
export function buildLearnedTrainingSet(
  leagueGames: readonly FinishedGame[],
  asOf: number,
  minPriorGames = 5,
): LearnedTrainingSet {
  const ordered = [...leagueGames]
    .filter((g) => g.kickoff <= asOf)
    .sort((a, b) => a.kickoff - b.kickoff || a.homeTeamId.localeCompare(b.homeTeamId))

  const state = new LeagueState()
  const samples: LearnedSample[] = []
  let skippedColdStart = 0

  for (const game of ordered) {
    if (
      state.gamesSeen(game.homeTeamId) >= minPriorGames &&
      state.gamesSeen(game.awayTeamId) >= minPriorGames
    ) {
      const label = game.homeScore > game.awayScore ? 0 : game.homeScore === game.awayScore ? 1 : 2
      samples.push({
        features: state.featuresFor(game.homeTeamId, game.awayTeamId, game.kickoff),
        label,
        timestamp: game.kickoff,
      })
    } else {
      skippedColdStart += 1
    }
    state.apply(game)
  }

  return { samples, skippedColdStart }
}

/**
 * Pre-match features for an upcoming fixture, from every game ≤ asOf. Null
 * when either side lacks the minimum history — the model abstains rather
 * than predicting from priors dressed up as evidence.
 */
export function buildFixtureFeatures(
  leagueGames: readonly FinishedGame[],
  homeTeamId: string,
  awayTeamId: string,
  asOf: number,
  minPriorGames = 5,
): number[] | null {
  const ordered = [...leagueGames]
    .filter((g) => g.kickoff <= asOf)
    .sort((a, b) => a.kickoff - b.kickoff || a.homeTeamId.localeCompare(b.homeTeamId))

  const state = new LeagueState()
  for (const game of ordered) state.apply(game)

  if (
    state.gamesSeen(homeTeamId) < minPriorGames ||
    state.gamesSeen(awayTeamId) < minPriorGames
  ) {
    return null
  }
  return state.featuresFor(homeTeamId, awayTeamId, asOf)
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** Below this many training samples the model abstains: coefficients from a
 *  hundred-odd games are mostly regularization prior wearing a lab coat. */
export const MIN_TRAINING_SAMPLES = 120

const TRAIN_CONFIG = {
  classCount: LEARNED_CLASSES.length,
  l2: 0.02,
  learningRate: 0.5,
  iterations: 300,
} as const

export interface LearnedModelResult {
  readonly output: ModelOutput
  /** The trained coefficients, for the Model Lab and versioned persistence.
   *  Null when the model abstained. */
  readonly model: LogisticModel | null
  readonly trainingSamples: number
}

/** Saturating self-confidence from training size, capped below the fitted
 *  models — a five-feature linear model should never be the loudest voice. */
function trainingConfidence(n: number): number {
  return Math.min(0.75, n / (n + 250))
}

/**
 * Walk-forward evaluation of the learned model against the honest benchmark:
 * a base-rate forecaster that always predicts the training window's own
 * class frequencies. Beating uniform is trivial (home advantage alone does
 * it); beating the base rates is the actual evidence that the FEATURES carry
 * information. Both are evaluated on identical chronological folds, so the
 * comparison is like-for-like by construction.
 *
 * Pure and deterministic — this is what the Model Lab reports as validation
 * metrics, computed from real historical games at request time rather than
 * quoted from a config file.
 */
export function evaluateLearnedWalkForward(
  samples: readonly LearnedSample[],
  config?: { readonly minTrainSize?: number; readonly validationSize?: number },
): { learned: WalkForwardResult; baseRate: WalkForwardResult } | null {
  const minTrainSize = config?.minTrainSize ?? MIN_TRAINING_SAMPLES
  const validationSize = config?.validationSize ?? 40
  if (samples.length < minTrainSize + validationSize) return null

  const learned = walkForwardValidate(samples, { minTrainSize, validationSize }, (slice) => {
    const model = trainMultinomialLogistic(slice, TRAIN_CONFIG)
    return (s) => predictProbabilities(model, s.features)
  })

  const baseRate = walkForwardValidate(samples, { minTrainSize, validationSize }, (slice) => {
    const counts = [0, 0, 0]
    for (const s of slice) counts[s.label] = (counts[s.label] ?? 0) + 1
    const probs = counts.map((c) => c / slice.length)
    return () => probs
  })

  return { learned, baseRate }
}

export function runLearnedModel(params: {
  readonly homeTeamId: string
  readonly awayTeamId: string
  readonly homeLabel?: string
  readonly awayLabel?: string
  readonly leagueGames: readonly FinishedGame[]
  readonly asOf: number
  readonly minPriorGames?: number
}): LearnedModelResult {
  const minPrior = params.minPriorGames ?? 5
  const { samples } = buildLearnedTrainingSet(params.leagueGames, params.asOf, minPrior)

  if (samples.length < MIN_TRAINING_SAMPLES) {
    return {
      output: abstain(
        LEARNED_MODEL_ID,
        LEARNED_MODEL_VERSION,
        LEARNED_CLASSES,
        `${MIN_TRAINING_SAMPLES} training games (have ${samples.length})`,
      ),
      model: null,
      trainingSamples: samples.length,
    }
  }

  const features = buildFixtureFeatures(
    params.leagueGames,
    params.homeTeamId,
    params.awayTeamId,
    params.asOf,
    minPrior,
  )
  if (features === null) {
    return {
      output: abstain(
        LEARNED_MODEL_ID,
        LEARNED_MODEL_VERSION,
        LEARNED_CLASSES,
        `${minPrior} completed games per side before kickoff`,
      ),
      model: null,
      trainingSamples: samples.length,
    }
  }

  const model = trainMultinomialLogistic(samples, TRAIN_CONFIG)
  const probs = predictProbabilities(model, features)

  // Real per-feature contributions: how much feature j moves the home-vs-away
  // log-odds, which for a linear model is exactly (w_home[j] − w_away[j])·x[j].
  // These are computed numbers from learned coefficients — the honest version
  // of "feature importance", not a narration.
  const wHome = model.weights[0] ?? []
  const wAway = model.weights[2] ?? []
  const factors: PredictionFactor[] = LEARNED_FEATURES.map((f, j) => ({
    id: `learned-${f.id}`,
    label: f.label,
    contribution: ((wHome[j] ?? 0) - (wAway[j] ?? 0)) * (features[j] ?? 0) * 0.1,
    detail: `coefficient gap ${((wHome[j] ?? 0) - (wAway[j] ?? 0)).toFixed(3)} × feature ${(
      features[j] ?? 0
    ).toFixed(3)}`,
    evidenceStrength: trainingConfidence(samples.length),
  }))
    .filter((f) => f.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution ?? 0) - Math.abs(a.contribution ?? 0))
    .slice(0, 3)

  return {
    output: emit({
      modelId: LEARNED_MODEL_ID,
      version: LEARNED_MODEL_VERSION,
      outcomes: [
        { key: 'home', label: params.homeLabel ?? params.homeTeamId, probability: probs[0] ?? 0 },
        { key: 'draw', label: 'Draw', probability: probs[1] ?? 0 },
        { key: 'away', label: params.awayLabel ?? params.awayTeamId, probability: probs[2] ?? 0 },
      ],
      confidence: trainingConfidence(samples.length),
      factors,
    }),
    model,
    trainingSamples: samples.length,
  }
}
