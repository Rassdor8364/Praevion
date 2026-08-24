/**
 * Vixera Team Strength — seven components, each 0–100, combined by
 * sport-specific weights into one overall score.
 *
 * Components: Attack, Defense, Form, Depth, Health, Home/Away, Momentum.
 *
 * -----------------------------------------------------------------------------
 * Null-tolerance is the design centre of this file
 * -----------------------------------------------------------------------------
 * A component that cannot be computed from the available data returns `null`
 * and its weight is REDISTRIBUTED over the components that were computed. The
 * tempting alternative — substituting a neutral 50 — would poison the overall:
 * a fabricated 50 is indistinguishable from a measured 50, it drags every
 * data-starved team toward the middle, and the overall score would look
 * equally trustworthy whether it was built from seven measurements or two.
 * The output therefore also reports WHICH components were actually computed,
 * so downstream confidence can penalise thin coverage instead of guessing.
 */

import { invariant } from '@/core/errors'
import { sigmoid } from '@/core/prediction/probability'
import type { Injury, TeamGameStats } from '@/providers/types'
import { FOOTBALL_STRENGTH_WEIGHTS, type LeagueGoalMeans, type SportConfig, type StrengthComponentWeights } from './config/football'
import { DEFAULT_FORM_SCORE_CONFIG, formScore, type FormScore, type FormScoreConfig } from './form'

export type StrengthComponentKey =
  | 'attack'
  | 'defense'
  | 'form'
  | 'depth'
  | 'health'
  | 'homeAway'
  | 'momentum'

export interface TeamStrength {
  /** 0..100 weighted mean of the computed components. */
  readonly overall: number
  /** Every component, null where the data did not support computing it. */
  readonly components: Readonly<Record<StrengthComponentKey, number | null>>
  /** The components that were genuinely computed (the non-null keys). */
  readonly computedComponents: readonly StrengthComponentKey[]
}

export interface StrengthInput {
  /** Most-recent-first window of the team's finished games. */
  readonly games: readonly TeamGameStats[]
  /** Pre-computed form score, or null if unavailable. */
  readonly form: FormScore | null
  /** Current injury/suspension list for the team. */
  readonly injuries: readonly Injury[]
  /** Venue the upcoming fixture will be played at, from this team's view. */
  readonly venue: 'home' | 'away'
  /**
   * Squad depth 0..100 when a depth source exists (squad value, bench
   * minutes). We have no such source yet, so this is null in production —
   * and per the header note, null it stays rather than a fabricated 50.
   */
  readonly depthScore?: number | null
}

/**
 * Injury severity weights: how much of a "fully missing player" each status
 * represents. 'out' and 'suspended' are certain absences; the others scale by
 * roughly how often that tag converts into a real absence.
 */
const INJURY_STATUS_WEIGHT: Record<Injury['status'], number> = {
  out: 1.0,
  suspended: 1.0,
  doubtful: 0.6,
  questionable: 0.35,
  probable: 0.15,
}

/** Minimum games at a venue before the home/away split is more than noise. */
const MIN_VENUE_GAMES = 3
/** Minimum games before a recent-vs-earlier momentum split is meaningful. */
const MIN_MOMENTUM_GAMES = 4

export function computeTeamStrength(
  input: StrengthInput,
  leagueMeans: LeagueGoalMeans,
  config: SportConfig,
): TeamStrength {
  const components: Record<StrengthComponentKey, number | null> = {
    attack: attackComponent(input.games, leagueMeans),
    defense: defenseComponent(input.games, leagueMeans),
    form: input.form === null ? null : input.form.score,
    depth: input.depthScore ?? null,
    health: healthComponent(input.injuries),
    homeAway: homeAwayComponent(input.games, input.venue),
    momentum: momentumComponent(input.games),
  }

  // Weighted mean over the computed components only — the redistribution.
  // Health is always computable (an empty injury list is a real measurement:
  // "nobody is reported missing"), so the denominator can never be zero.
  let weightTotal = 0
  let weightedSum = 0
  const computed: StrengthComponentKey[] = []
  for (const key of Object.keys(components) as StrengthComponentKey[]) {
    const value = components[key]
    if (value === null) continue
    const weight = config.strengthWeights[key]
    weightTotal += weight
    weightedSum += weight * value
    computed.push(key)
  }
  invariant(weightTotal > 0, 'team strength requires at least one computable component')

  return {
    overall: weightedSum / weightTotal,
    components,
    computedComponents: computed,
  }
}

/**
 * Attack: goals scored per game relative to the league's per-team mean,
 * squashed so that exactly league-average scoring reads 50. A team scoring at
 * 1.5x the league rate lands around 73.
 */
function attackComponent(games: readonly TeamGameStats[], means: LeagueGoalMeans): number | null {
  if (games.length === 0) return null
  const perTeamMean = (means.homeGoals + means.awayGoals) / 2
  const rate = meanOf(games.map((g) => g.scored))
  return 100 * sigmoid(2 * (rate / perTeamMean - 1))
}

/**
 * Defense: mirror of attack on goals conceded — conceding LESS than the league
 * mean pushes the score above 50.
 */
function defenseComponent(games: readonly TeamGameStats[], means: LeagueGoalMeans): number | null {
  if (games.length === 0) return null
  const perTeamMean = (means.homeGoals + means.awayGoals) / 2
  const rate = meanOf(games.map((g) => g.conceded))
  return 100 * sigmoid(2 * (1 - rate / perTeamMean))
}

/**
 * Health: 100 minus a penalty per reported absence, weighted by status
 * severity. 12 points per fully-out player ≈ one of eleven starters plus the
 * quality gap to the replacement; three confirmed absences already cost a
 * third of the scale, which matches how heavily simultaneous absences bite.
 */
function healthComponent(injuries: readonly Injury[]): number {
  let burden = 0
  for (const injury of injuries) burden += INJURY_STATUS_WEIGHT[injury.status]
  return Math.max(0, 100 - 12 * burden)
}

/**
 * Home/Away: points-per-game at the venue the upcoming fixture will be played
 * at, as a fraction of the 3 points available. Needs a minimum venue sample —
 * two away games tell you nothing but noise.
 */
function homeAwayComponent(games: readonly TeamGameStats[], venue: 'home' | 'away'): number | null {
  const atVenue = games.filter((g) => (venue === 'home' ? g.isHome : !g.isHome))
  if (atVenue.length < MIN_VENUE_GAMES) return null
  const ppg = meanOf(atVenue.map((g) => (g.result === 'W' ? 3 : g.result === 'D' ? 1 : 0)))
  return (100 * ppg) / 3
}

/**
 * Momentum: the trajectory rather than the level — result rate over the last
 * three games versus the rest of the window, mapped so "no change" reads 50.
 * Form already measures the level; this measures the derivative.
 */
function momentumComponent(games: readonly TeamGameStats[]): number | null {
  if (games.length < MIN_MOMENTUM_GAMES) return null
  const points = games.map((g) => (g.result === 'W' ? 1 : g.result === 'D' ? 0.5 : 0))
  const recent = meanOf(points.slice(0, 3))
  const earlier = meanOf(points.slice(3))
  return clampScore(50 + 50 * (recent - earlier))
}

function meanOf(values: readonly number[]): number {
  invariant(values.length > 0, 'meanOf requires a non-empty array')
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function clampScore(x: number): number {
  return Math.min(100, Math.max(0, x))
}

// ---------------------------------------------------------------------------
// Vixera Team Strength profile — the pure-engine, percentile-based API
// ---------------------------------------------------------------------------
//
// computeTeamStrength above scores against sigmoid curves anchored on league
// MEANS; the profile below scores against the league's ACTUAL distribution
// (percentiles), which is self-calibrating: "attack 80" always means "better
// than ~80% of this league", whether the league averages 2.4 or 3.1 goals.
// It is the API the Phase-2 match-prediction engine and the orchestrator
// consume, weighted by the versioned FOOTBALL_STRENGTH_WEIGHTS.

/**
 * The league context every percentile is measured against. One entry per
 * league team in each array; which team is which does not matter — only the
 * distribution does.
 */
export interface StrengthLeagueContext {
  /** Per-team goals scored per game across the league. */
  readonly goalsForRates: readonly number[]
  /** Per-team goals conceded per game across the league. */
  readonly goalsAgainstRates: readonly number[]
  /**
   * Per-team points per game AT THE RELEVANT VENUE (home ppg values when the
   * upcoming fixture puts this team at home, away ppg values otherwise).
   */
  readonly venuePointsPerGame: readonly number[]
  /** Raw form composites for the league-relative form squash. */
  readonly formRaws: readonly number[]
}

export interface VixeraStrengthProfile {
  /** 0..100 — weighted over the COMPUTED components only (see weightsUsed). */
  readonly overall: number
  readonly components: Readonly<Record<StrengthComponentKey, number | null>>
  /** Effective weights after renormalising over non-null components (sum 1). */
  readonly weightsUsed: Readonly<Record<StrengthComponentKey, number>>
  readonly computedComponents: readonly StrengthComponentKey[]
  readonly modelVersion: string
}

/** Fewest games at a venue before the venue split beats noise. */
const MIN_VENUE_SAMPLE = 3
/** Fewest games before the short/long momentum windows meaningfully differ. */
const MIN_MOMENTUM_SAMPLE = 8
/** Fewest league data points before a percentile is worth quoting. */
const MIN_LEAGUE_SAMPLE = 4

/**
 * Compute the seven-component Vixera Team Strength profile.
 *
 * DEPTH AND HEALTH ARE ALWAYS NULL TODAY, and that is a feature, not a gap:
 * our current providers ship no injury, lineup or squad data, and a Health
 * score fabricated from nothing (a hardcoded 100? a neutral 50?) would be
 * indistinguishable from a measured one — the overall would look exactly as
 * trustworthy built from five real components as from seven, which is
 * precisely the lie the abstention pattern exists to prevent. The two
 * components are EXCLUDED from the weighted overall and the remaining
 * weights renormalised; their declared weights (.06 each) sit ready in
 * FOOTBALL_STRENGTH_WEIGHTS so that when an injuries provider lands, these
 * light up with no retune and a deliberate MODEL_VERSION bump.
 *
 * @param params.teamGames Most-recent-first window of the team's games.
 * @param params.venue The venue the UPCOMING fixture puts this team at —
 *   the HomeAway component is venue-specific, so a team strong at home and
 *   feeble away gets two different profiles depending on the fixture.
 */
export function vixeraTeamStrength(params: {
  readonly teamGames: readonly TeamGameStats[]
  /** Opponent quality 0..1 keyed by gameId (see formRawComposite in form.ts). */
  readonly opponentStrength: (gameId: string) => number
  readonly venue: 'home' | 'away'
  readonly league: StrengthLeagueContext
  readonly weights?: StrengthComponentWeights
  readonly formConfig?: FormScoreConfig
  /** Evaluation instant — threaded for purity/backtest replay (see form.ts). */
  readonly asOf: number
}): VixeraStrengthProfile {
  const weights = params.weights ?? FOOTBALL_STRENGTH_WEIGHTS.weights
  const baseFormConfig = params.formConfig ?? DEFAULT_FORM_SCORE_CONFIG
  const formConfig: FormScoreConfig = { ...baseFormConfig, leagueRaws: params.league.formRaws }
  const games = params.teamGames

  // --- Attack / Defense: percentile vs the league distribution -------------
  const attack =
    games.length === 0 || params.league.goalsForRates.length < MIN_LEAGUE_SAMPLE
      ? null
      : 100 * percentileRank(params.league.goalsForRates, meanOf(games.map((g) => g.scored)))
  // Conceding LESS is better, so defense is the COMPLEMENT of the percentile.
  const defense =
    games.length === 0 || params.league.goalsAgainstRates.length < MIN_LEAGUE_SAMPLE
      ? null
      : 100 * (1 - percentileRank(params.league.goalsAgainstRates, meanOf(games.map((g) => g.conceded))))

  // --- Form (league-squashed; null when the sample is insufficient) --------
  const form = formScore(games, params.opponentStrength, formConfig, params.asOf)
  const formComponent = form.insufficient ? null : form.score

  // --- Momentum: last-5 form minus last-15 form, centred at 50 --------------
  // The level is Form's job; momentum measures the DERIVATIVE — is the team's
  // trajectory rising or falling within its own window? Below 8 games the two
  // windows are mostly the same games and the difference is pure noise.
  let momentum: number | null = null
  if (games.length >= MIN_MOMENTUM_SAMPLE) {
    const short = formScore(games.slice(0, 5), params.opponentStrength, formConfig, params.asOf)
    const long = formScore(games.slice(0, 15), params.opponentStrength, formConfig, params.asOf)
    // Halved so the extremes (±100 score gap) map onto the 0..100 scale.
    momentum = clampScore(50 + (short.score - long.score) / 2)
  }

  // --- HomeAway: venue-specific points-per-game percentile ------------------
  const atVenue = games.filter((g) => (params.venue === 'home' ? g.isHome : !g.isHome))
  const homeAway =
    atVenue.length < MIN_VENUE_SAMPLE || params.league.venuePointsPerGame.length < MIN_LEAGUE_SAMPLE
      ? null
      : 100 *
        percentileRank(
          params.league.venuePointsPerGame,
          meanOf(atVenue.map((g) => (g.result === 'W' ? 3 : g.result === 'D' ? 1 : 0))),
        )

  // --- Depth / Health: no data source exists — null, never fabricated ------
  const depth: number | null = null
  const health: number | null = null

  const components: Record<StrengthComponentKey, number | null> = {
    attack,
    defense,
    form: formComponent,
    depth,
    health,
    homeAway,
    momentum,
  }

  // Renormalise weights over the computed components.
  let weightTotal = 0
  const computed: StrengthComponentKey[] = []
  for (const key of Object.keys(components) as StrengthComponentKey[]) {
    if (components[key] === null) continue
    weightTotal += weights[key]
    computed.push(key)
  }
  invariant(weightTotal > 0, 'vixeraTeamStrength requires at least one computable component')

  const weightsUsed: Record<StrengthComponentKey, number> = {
    attack: 0,
    defense: 0,
    form: 0,
    depth: 0,
    health: 0,
    homeAway: 0,
    momentum: 0,
  }
  let overall = 0
  for (const key of computed) {
    const w = weights[key] / weightTotal
    weightsUsed[key] = w
    overall += w * (components[key] ?? 0)
  }

  return {
    overall,
    components,
    weightsUsed,
    computedComponents: computed,
    modelVersion: FOOTBALL_STRENGTH_WEIGHTS.version,
  }
}

/**
 * Midrank percentile of `value` within `distribution`: fraction strictly
 * below plus half the ties. The midrank convention means a value equal to
 * every league entry reads 0.5 (dead median) rather than 0 or 1 — ties carry
 * no ordering information and should not be awarded any.
 */
function percentileRank(distribution: readonly number[], value: number): number {
  invariant(distribution.length > 0, 'percentileRank requires a non-empty distribution')
  let below = 0
  let ties = 0
  for (const v of distribution) {
    if (v < value) below += 1
    else if (v === value) ties += 1
  }
  return (below + 0.5 * ties) / distribution.length
}
