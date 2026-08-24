/**
 * Football (association football / soccer) sport configuration.
 *
 * Every tunable constant for the football prediction stack lives here, in one
 * versioned object. The engines themselves are sport-agnostic mathematics; the
 * numbers below are what make them football. Changing any weight produces a new
 * `version`, which flows into `model_version` on every prediction — a silent
 * retune that leaves the version untouched would corrupt the accuracy ledger,
 * because predictions made under different weights would be pooled as if they
 * came from the same model.
 *
 * Each constant carries its provenance. "Literature" here means the published
 * football-modelling canon (Dixon & Coles 1997; Maher 1982; club Elo systems),
 * not a value someone liked the look of.
 */

import type { SportKey } from '@/providers/types'

/** Weights of the four Vixera Form Score components (must sum to 1). */
export interface FormComponentWeights {
  readonly resultPoints: number
  readonly normalizedGoalDiff: number
  readonly opponentStrength: number
  readonly performanceVsExpected: number
}

/** Weights of the seven Team Strength components (must sum to 1). */
export interface StrengthComponentWeights {
  readonly attack: number
  readonly defense: number
  readonly form: number
  readonly depth: number
  readonly health: number
  readonly homeAway: number
  readonly momentum: number
}

/** League-level scoring environment: mean goals per game for each venue side. */
export interface LeagueGoalMeans {
  /** Mean goals scored per game by the home side. */
  readonly homeGoals: number
  /** Mean goals scored per game by the away side. */
  readonly awayGoals: number
}

/**
 * The per-sport configuration contract.
 *
 * Basketball, hockey and the rest implement this same interface with their own
 * constants (and their own goal/point scale), so every engine in
 * `engines/sports/` stays sport-generic.
 */
export interface SportConfig {
  readonly sport: SportKey
  /** Bumped on ANY constant change — feeds model_version on predictions. */
  readonly version: string

  // --- Form Score -----------------------------------------------------------
  /** Exponential recency decay λ for form weights w(g) = exp(−λ·gamesAgo). */
  readonly formDecayLambda: number
  readonly formWeights: FormComponentWeights
  /**
   * The raw composite value of the league-median team. The logistic squash is
   * centred here so that a score of 50 means "median team in this league".
   */
  readonly formLeagueMedianRaw: number
  /** Logistic scale of the squash — smaller spreads teams further apart. */
  readonly formSquashScale: number

  // --- Team Strength ---------------------------------------------------------
  readonly strengthWeights: StrengthComponentWeights

  // --- Dixon–Coles match model ------------------------------------------------
  /**
   * The low-score dependence parameter ρ. Dixon & Coles (1997) estimated
   * ρ ≈ −0.13 on English league data, and subsequent replications on modern
   * European seasons land in the −0.10..−0.16 band. Negative ρ moves probability
   * INTO the 0-0 and 1-1 cells, correcting the independent-Poisson
   * underestimate of draws.
   */
  readonly dixonColesRho: number
  /** Score matrix truncation. P(a side scores >10) is ~1e-5 at football λs. */
  readonly maxGoals: number
  /**
   * Home advantage expressed in goals of expected-goal margin. Cross-league
   * studies (Pollard & Pollard 2005 and successors) put the modern European
   * value at roughly +0.25 to +0.30 goals; it has been shrinking for decades,
   * so we take the conservative end.
   */
  readonly homeAdvantageGoals: number
  /**
   * Effective sample size for shrinking observed scoring rates toward the
   * league mean in estimateTeamRates. Six games of prior means a team's first
   * six real games move it halfway from "league average" to its observed rate.
   */
  readonly rateShrinkPriorWeight: number

  // --- Elo ---------------------------------------------------------------------
  /**
   * Home advantage as an Elo rating offset. Club football Elo systems
   * (eloratings.net, clubelo.com) use ~50–100 points; 65 points corresponds to
   * roughly a 59% expected score for otherwise equal sides, consistent with the
   * observed home points share in the big European leagues.
   */
  readonly eloHomeAdvantage: number
  /** K for a team with no rated history — new teams should move fast. */
  readonly eloKBase: number
  /** Floor K for a fully established team (clubelo-style K ≈ 20). */
  readonly eloKMin: number
  /** Games over which K decays from base toward the floor (e-folding scale). */
  readonly eloKDecayGames: number
  /**
   * Elo points per goal of expected margin — the bridge from rating space to
   * goal space. Calibrated so a 100-point favourite is expected to win by
   * ~0.57 goals, in line with clubelo.com's published margin regressions.
   */
  readonly eloPointsPerGoal: number

  // --- Guards -------------------------------------------------------------------
  /** Below this many games of history per side, every model abstains. */
  readonly minGamesForModel: number
  /**
   * Effective sample size for shrinking head-to-head rates. Deliberately harsh
   * (§7 of the original brief): five meetings across four seasons with
   * different squads is weak evidence, so with priorWeight 8 those five
   * meetings move the estimate less than halfway from the prior.
   */
  readonly h2hPriorWeight: number
}

/**
 * Model version for the Phase-2 pure quantitative football stack (the
 * EloTable/Dixon–Coles/strength-profile engines). Bumped on ANY change to the
 * constants below or to the engine mathematics — predictions made under
 * different weights must never be pooled in the accuracy ledger as if they
 * came from the same model.
 */
export const MODEL_VERSION = 'football-quant-2.0.0'

/**
 * Team Strength component weights for football, per §9 of the implementation
 * plan, as consumed by the percentile-based strength profile
 * (`vixeraTeamStrength` in ../strength.ts).
 *
 * Attack and Defense carry the most weight because they are measured directly
 * from goals — the currency the game is settled in. Depth and Health carry the
 * least, and TODAY THEY ARE ALWAYS NULL: we have no injury or lineup feed, so
 * the strength engine excludes them and renormalises the remaining weights
 * over the components it could actually compute. The weights are declared here
 * anyway so that the day an injuries provider lands, those components light up
 * without a weight retune (and without a silent model-version drift — this
 * const is versioned for exactly that reason).
 *
 * Note the sum over ALL seven components is 1; the effective weights at
 * runtime are these renormalised over the non-null subset.
 */
export const FOOTBALL_STRENGTH_WEIGHTS: {
  readonly version: string
  readonly weights: StrengthComponentWeights
} = {
  version: MODEL_VERSION,
  weights: {
    attack: 0.22,
    defense: 0.22,
    form: 0.2,
    homeAway: 0.14,
    momentum: 0.1,
    depth: 0.06,
    health: 0.06,
  },
}

export const FOOTBALL_CONFIG: SportConfig = {
  sport: 'football',
  version: '1.0.0',

  // λ = 0.18 gives a half-life of ln2/0.18 ≈ 3.85 games — the window the
  // brief's "recent form" language actually means: last month of fixtures
  // dominates, two months ago still whispers.
  formDecayLambda: 0.18,

  // §9 of the implementation plan, verbatim. Results carry the most weight but
  // NOT a majority — the other 60% is what stops the score being "recent
  // results with extra steps".
  formWeights: {
    resultPoints: 0.4,
    normalizedGoalDiff: 0.25,
    opponentStrength: 0.2,
    performanceVsExpected: 0.15,
  },

  // Each per-game component is built to average 0.5 for a league-median team
  // (draw-rate results, zero goal difference, median opponents, xG ≈ goals),
  // so the median raw composite is 0.5 by construction.
  formLeagueMedianRaw: 0.5,
  // 0.12 maps a genuinely strong window (raw ≈ 0.8) to a score of ~92 while a
  // slightly-above-median one (raw ≈ 0.55) lands near 60 — spread without
  // saturation.
  formSquashScale: 0.12,

  // Football-specific strength weights. Attack and defense carry the most
  // because they are measured from actual goals; depth carries the least
  // because our depth signal is weakest (no squad-value data yet).
  strengthWeights: {
    attack: 0.22,
    defense: 0.22,
    form: 0.18,
    depth: 0.06,
    health: 0.12,
    homeAway: 0.1,
    momentum: 0.1,
  },

  dixonColesRho: -0.13, // Dixon & Coles (1997), Table 4 — see interface note.
  maxGoals: 10,
  homeAdvantageGoals: 0.25, // Pollard-line cross-league estimate, conservative end.
  rateShrinkPriorWeight: 6,

  eloHomeAdvantage: 65,
  eloKBase: 40, // fast convergence for unrated teams, standard chess-derived value
  eloKMin: 20, // clubelo.com-style steady-state K
  eloKDecayGames: 25, // roughly two-thirds of a league season
  eloPointsPerGoal: 175,

  minGamesForModel: 5,
  h2hPriorWeight: 8,
}
