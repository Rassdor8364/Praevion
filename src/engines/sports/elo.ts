/**
 * Elo rating system for team sports.
 *
 * Classic Elo with three football-standard refinements:
 *
 *  1. Margin-of-victory multiplier in LOG form. A linear MOV multiplier
 *     overweights blowouts: a 6-0 would move ratings six times as far as a
 *     1-0, but the sixth goal against a collapsed side carries almost no
 *     information about relative strength — garbage-time goals are noise, not
 *     signal. log(1+margin) makes each additional goal worth less than the
 *     last, which matches the empirical predictive value of margins.
 *
 *  2. Home advantage as a rating OFFSET applied at expectation time, never
 *     baked into the stored rating. Stored ratings stay venue-neutral and
 *     comparable; the offset is applied (or not) per fixture.
 *
 *  3. K decay by games played. An unrated team's 1500 is a guess and should
 *     move fast; an established team's rating is evidence-backed and should
 *     move slowly. K glides from kBase to kMin as history accumulates.
 *
 * Everything here is pure: updates return NEW ratings objects, and the only
 * time source is the timestamps already on the games.
 */

import { invariant } from '@/core/errors'
import type { Game } from '@/providers/types'
import type { SportConfig } from './config/football'

/** A team's rating plus how much history backs it (drives K decay). */
export interface EloEntry {
  readonly rating: number
  readonly gamesPlayed: number
}

export type EloRatings = Readonly<Record<string, EloEntry>>

/** Standard Elo anchor — every unrated team starts here. */
export const INITIAL_ELO = 1500

/** Rating for a team, defaulting to the unrated entry. */
export function getEloEntry(ratings: EloRatings, teamId: string): EloEntry {
  return ratings[teamId] ?? { rating: INITIAL_ELO, gamesPlayed: 0 }
}

/**
 * Expected score for the home side: 1/(1+10^(−d/400)), d including the home
 * advantage offset.
 *
 * Strictly this is Elo's EXPECTED SCORE (win=1, draw=0.5), not a pure win
 * probability — the draw mass is not separated here. The Dixon–Coles bridge in
 * models.ts is what turns this into a proper 1X2 distribution; this function
 * serves the binary "who is stronger" question and the update rule.
 */
export function eloWinProbability(home: number, away: number, homeAdvantage: number): number {
  const diff = home + homeAdvantage - away
  return 1 / (1 + Math.pow(10, -diff / 400))
}

/**
 * Expected goal margin (home − away) implied by a rating gap.
 *
 * Linear in rating difference with slope 1/pointsPerGoal — the empirical
 * rating-to-margin regressions used by club Elo sites are close to linear in
 * the range that actually occurs (±400 points).
 */
export function eloExpectedGoalDiff(
  home: number,
  away: number,
  homeAdvantage: number,
  pointsPerGoal: number,
): number {
  invariant(pointsPerGoal > 0, 'pointsPerGoal must be positive')
  return (home + homeAdvantage - away) / pointsPerGoal
}

/**
 * Margin-of-victory multiplier: log(1+margin)/log(2), normalised so a one-goal
 * margin (and a draw) is exactly 1.0.
 *
 * Diminishing by construction: 1-goal → 1.0, 2 → 1.58, 3 → 2.0, 6 → 2.81. The
 * linear alternative (6-0 counting six times a 1-0) lets one anomalous
 * scoreline distort a rating for months.
 */
export function movMultiplier(goalMargin: number): number {
  const margin = Math.max(1, Math.abs(goalMargin))
  return Math.log1p(margin) / Math.LN2
}

/** K decays exponentially from kBase toward kMin as a team accumulates games. */
export function kFactor(gamesPlayed: number, config: SportConfig): number {
  invariant(gamesPlayed >= 0, 'gamesPlayed must be non-negative')
  return config.eloKMin + (config.eloKBase - config.eloKMin) * Math.exp(-gamesPlayed / config.eloKDecayGames)
}

/**
 * Fold one finished game into the ratings. Pure — returns a new ratings map.
 *
 * The two sides may have different K (different history depths), but a
 * per-side K would break the zero-sum property: points would leak into or out
 * of the pool and the league's mean rating would drift. We therefore use the
 * MEAN of the two K values, applied symmetrically — the pair converges at the
 * average of their individual speeds and Σ ratings is exactly conserved.
 */
export function updateElo(ratings: EloRatings, game: Game, config: SportConfig): EloRatings {
  invariant(
    game.homeScore !== null && game.awayScore !== null,
    `updateElo requires a final score (game ${game.externalId})`,
  )

  const home = getEloEntry(ratings, game.homeTeamId)
  const away = getEloEntry(ratings, game.awayTeamId)

  const expected = eloWinProbability(home.rating, away.rating, config.eloHomeAdvantage)
  const actual = game.homeScore > game.awayScore ? 1 : game.homeScore === game.awayScore ? 0.5 : 0

  const k = (kFactor(home.gamesPlayed, config) + kFactor(away.gamesPlayed, config)) / 2
  const mov = movMultiplier(game.homeScore - game.awayScore)
  const delta = k * mov * (actual - expected)

  return {
    ...ratings,
    [game.homeTeamId]: { rating: home.rating + delta, gamesPlayed: home.gamesPlayed + 1 },
    [game.awayTeamId]: { rating: away.rating - delta, gamesPlayed: away.gamesPlayed + 1 },
  }
}

/**
 * Fold a full season of games chronologically into ratings.
 *
 * STRICT chronological order is asserted (kickoff non-decreasing) and a
 * violation throws InvariantError. This is the lookahead guard: a single
 * out-of-order game means a rating "knew" a result before it happened, and
 * every backtest downstream of that rating is quietly measuring hindsight.
 * Failing loudly here is the only honest option.
 *
 * Games without a final score (scheduled, postponed, abandoned) are skipped —
 * a fixture is not evidence — but they still participate in the ordering
 * check, because an out-of-order fixture list is the same pipeline bug.
 */
export function runEloHistory(games: readonly Game[], config: SportConfig): EloRatings {
  let previousKickoff = -Infinity
  let ratings: EloRatings = {}

  for (const game of games) {
    invariant(
      game.kickoff >= previousKickoff,
      `runEloHistory requires chronological games — ${game.externalId} kicks off before its predecessor`,
    )
    previousKickoff = game.kickoff

    if (game.status !== 'finished' || game.homeScore === null || game.awayScore === null) continue
    ratings = updateElo(ratings, game, config)
  }

  return ratings
}

// ---------------------------------------------------------------------------
// Batch Elo fitter (EloTable API)
// ---------------------------------------------------------------------------
//
// The incremental API above serves the streaming rating job, which folds games
// in one at a time as they finish. The batch fitter below is the PURE-ENGINE
// entry point: the match-prediction engine replays a caller-supplied history
// from scratch on every evaluation, which is what makes it trivially
// point-in-time correct — the table can only know the games it was handed.
// The two paths use different (both diminishing) margin-of-victory families;
// see goalDiffMultiplier for the note.

/**
 * The minimal finished-game record the fitter needs. Deliberately narrower
 * than the provider `Game`: scores are non-null by type, so "is this game
 * actually finished?" is settled at the boundary where the caller filters,
 * not re-litigated with runtime checks inside the fitter.
 */
export interface FinishedGame {
  readonly homeTeamId: string
  readonly awayTeamId: string
  readonly homeScore: number
  readonly awayScore: number
  /** Epoch ms. The fitter's only notion of time — no clock is ever consulted. */
  readonly kickoff: number
}

export interface EloConfig {
  /** Rating every unrated team starts at — the conventional Elo anchor. */
  readonly initialRating: number
  /** Fixed K for the batch fitter (clubelo-style steady-state value). */
  readonly kFactor: number
  /**
   * Home advantage as a rating offset applied at expectation time only.
   * ~60 points ≈ a 58.5% expected score for otherwise equal sides, in line
   * with the home points share observed in the big European leagues.
   */
  readonly homeAdvantage: number
  /**
   * Davidson draw parameter ν. Provenance: Davidson (1970) extended the
   * Bradley–Terry paired-comparison model with a tie probability proportional
   * to the geometric mean of the two win strengths — p_draw ∝ ν·√(p_h·p_a).
   * ν = 0.85 is calibrated against football's empirical ~25% overall draw
   * rate: at dead-even ratings the formula peaks at ≈29.8% draws, decaying as
   * the gap grows, and averaged over a realistic distribution of rating gaps
   * the league-wide draw share lands near the observed quarter.
   */
  readonly drawNu: number
}

export const DEFAULT_ELO_CONFIG: EloConfig = {
  initialRating: 1500,
  kFactor: 20,
  homeAdvantage: 60,
  drawNu: 0.85,
}

/** One team's serialisable state inside an EloTable snapshot. */
export interface EloTableEntry {
  readonly rating: number
  readonly games: number
}

/**
 * The fitted rating table. Lookup for an unknown team returns the initial
 * rating, and `isRated`/`gamesRated` are the flag telling callers that the
 * number is a default rather than evidence — a caller that treats an unrated
 * 1500 as a measured 1500 is fabricating information, so the flag travels
 * with the lookup API rather than being left to convention.
 */
export interface EloTable {
  rating(teamId: string): number
  /** False means `rating()` returned the default — flag it downstream. */
  isRated(teamId: string): boolean
  gamesRated(teamId: string): number
  readonly teamIds: readonly string[]
  /** Plain-object snapshot, safe to JSON-serialise and rehydrate elsewhere. */
  snapshot(): Readonly<Record<string, EloTableEntry>>
}

/**
 * Logistic expected score for side A: 1/(1 + 10^(−(rA + homeAdvantage − rB)/400)).
 *
 * This is Elo's EXPECTED SCORE (win = 1, draw = 0.5), not yet a win
 * probability — the draw mass is carved out by eloWinDrawLoss below. Pass
 * homeAdvantage = 0 for a venue-neutral comparison.
 */
export function eloExpectedScore(ratingA: number, ratingB: number, homeAdvantage: number): number {
  return 1 / (1 + Math.pow(10, -(ratingA + homeAdvantage - ratingB) / 400))
}

/**
 * Margin-of-victory multiplier for the batch fitter: √max(1, |gd|).
 *
 * The point is that it is CONCAVE. Unbounded LINEAR goal-difference scaling —
 * multiplying the update by the raw margin — lets a single anomalous 7-0 move
 * a rating seven times as far as a 1-0, and one freak afternoon (a red card
 * in minute 8, a collapsed keeper) then distorts the whole table for months:
 * every subsequent expectation involving either team is wrong, and the
 * zero-sum updates propagate the error to their opponents too. √|gd| still
 * rewards decisive wins (a 4-0 counts double a 1-0) but each additional
 * garbage-time goal is worth less than the last, which matches the margin's
 * actual predictive value. This is the square-root member of the diminishing
 * MOV family; the incremental path above uses the log member — both appear in
 * the football-Elo literature (Hvattum & Arntzen 2010 tested several) and
 * both exist to prevent exactly the same failure.
 */
export function goalDiffMultiplier(goalDiff: number): number {
  return Math.sqrt(Math.max(1, Math.abs(goalDiff)))
}

/**
 * Fit an Elo table over a finished-game history.
 *
 * Games are processed in KICKOFF ORDER — a sorted copy is taken rather than
 * trusting the input, because an out-of-order game means a rating "knew" a
 * result before it happened and every backtest downstream is quietly
 * measuring hindsight. Updates are exactly zero-sum (one shared delta applied
 * ± to the pair), so Σ ratings ≡ nTeams · initialRating forever — rating
 * points are conserved, never minted.
 */
export function fitElo(
  games: readonly FinishedGame[],
  config: EloConfig = DEFAULT_ELO_CONFIG,
): EloTable {
  invariant(config.kFactor > 0, 'fitElo requires a positive K factor')

  const ordered = [...games].sort((a, b) => a.kickoff - b.kickoff)
  const entries = new Map<string, { rating: number; games: number }>()

  const entryOf = (teamId: string): { rating: number; games: number } => {
    const existing = entries.get(teamId)
    if (existing !== undefined) return existing
    const fresh = { rating: config.initialRating, games: 0 }
    entries.set(teamId, fresh)
    return fresh
  }

  for (const game of ordered) {
    const home = entryOf(game.homeTeamId)
    const away = entryOf(game.awayTeamId)

    const expected = eloExpectedScore(home.rating, away.rating, config.homeAdvantage)
    const actual =
      game.homeScore > game.awayScore ? 1 : game.homeScore === game.awayScore ? 0.5 : 0

    const delta =
      config.kFactor * goalDiffMultiplier(game.homeScore - game.awayScore) * (actual - expected)

    home.rating += delta
    away.rating -= delta
    home.games += 1
    away.games += 1
  }

  return {
    rating: (teamId) => entries.get(teamId)?.rating ?? config.initialRating,
    isRated: (teamId) => entries.has(teamId),
    gamesRated: (teamId) => entries.get(teamId)?.games ?? 0,
    teamIds: [...entries.keys()],
    snapshot: () => {
      const out: Record<string, EloTableEntry> = {}
      for (const [teamId, entry] of entries) {
        out[teamId] = { rating: entry.rating, games: entry.games }
      }
      return out
    },
  }
}

export interface WinDrawLoss {
  readonly home: number
  readonly draw: number
  readonly away: number
}

/**
 * Convert a rating pair into a 1X2 distribution via the Davidson draw model.
 *
 * Elo natively answers a TWO-outcome question — its expected score folds the
 * draw into 0.5 of a win — but football needs the draw priced explicitly,
 * and it needs the draw to depend on the matchup: evenly matched sides draw
 * far more often than mismatches, so any fixed draw constant is wrong at
 * both ends.
 *
 * The Davidson construction gets that shape for free:
 *
 *   p_h_raw = E(home)                    // logistic expected score
 *   p_a_raw = 1 − p_h_raw
 *   d       = ν · √(p_h_raw · p_a_raw)   // draw mass, ν per config
 *   home    = p_h_raw / (1 + d)          // renormalised over {home, draw, away}
 *   draw    = d       / (1 + d)
 *   away    = p_a_raw / (1 + d)
 *
 * √(p_h·p_a) peaks at 0.5 when the sides are dead even and decays toward 0
 * as either raw probability approaches 1 — exactly the empirical draw curve.
 * ν = 0.85 (see EloConfig.drawNu for provenance) puts the even-match draw at
 * ≈29.8% and the league-wide average near football's observed ~25%.
 */
export function eloWinDrawLoss(
  ratingHome: number,
  ratingAway: number,
  config: EloConfig = DEFAULT_ELO_CONFIG,
): WinDrawLoss {
  invariant(config.drawNu >= 0, 'eloWinDrawLoss requires a non-negative draw parameter')

  const pHomeRaw = eloExpectedScore(ratingHome, ratingAway, config.homeAdvantage)
  const pAwayRaw = 1 - pHomeRaw
  const drawMass = config.drawNu * Math.sqrt(pHomeRaw * pAwayRaw)
  const total = 1 + drawMass // p_h_raw + p_a_raw = 1 by construction

  return {
    home: pHomeRaw / total,
    draw: drawMass / total,
    away: pAwayRaw / total,
  }
}
