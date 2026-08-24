/**
 * Player-absence impact — measured, not asserted.
 *
 * The impact of a player being unavailable is estimated by comparing the
 * team's historical performance in games the player featured in against games
 * they missed. That is a real measurement with real failure modes, and this
 * module's job is mostly to refuse the failure modes:
 *
 *  - The raw with/without delta is confounded (rotation correlates with
 *    fixture difficulty; absences cluster in congested periods), so it is
 *    SHRUNK by min(minutes share, sample-size factor). A player who was only
 *    on the pitch for 30% of minutes cannot own more than ~30% of the
 *    observed delta; a delta measured over five games barely counts at all.
 *
 *  - Below MIN_SUBSET_GAMES in EITHER subset the honest answer is
 *    "insufficient data", not a number (§6 of the original brief). The output
 *    then carries `reliable: false` and null impacts, and any UI or model that
 *    consumes it must show/handle the absence of an estimate rather than a
 *    fabricated one.
 */

import { invariant } from '@/core/errors'
import type { TeamGameStats } from '@/providers/types'

export interface AbsenceImpact {
  /**
   * Percent change in the team's goals-per-game attributable to the player
   * being PRESENT (positive = team scores more with them). Null when the
   * sample is too thin to say.
   */
  readonly offensiveImpactPct: number | null
  /**
   * Change in win rate (draws counted half) attributable to the player, in
   * probability points. Null when the sample is too thin to say.
   */
  readonly winProbabilityImpactPp: number | null
  /** The binding sample: min(games with, games without). */
  readonly sampleSize: number
  /** False means the numbers above are null and no estimate exists. */
  readonly reliable: boolean
}

/** Below this many games in either subset, we report insufficient data. */
export const MIN_SUBSET_GAMES = 4

/** Sample size at which the sample-side shrink factor reaches 0.5. */
const SAMPLE_SHRINK_HALFPOINT = 6

export function computeAbsenceImpact(params: {
  /** Games in which the player featured. */
  readonly withPlayer: readonly TeamGameStats[]
  /** Games the player missed. */
  readonly withoutPlayer: readonly TeamGameStats[]
  /** Fraction of the team's available minutes the player actually played, 0..1. */
  readonly minutesShare: number
}): AbsenceImpact {
  const { withPlayer, withoutPlayer } = params
  invariant(
    params.minutesShare >= 0 && params.minutesShare <= 1,
    'minutesShare must be in [0, 1]',
  )

  const sampleSize = Math.min(withPlayer.length, withoutPlayer.length)

  // The refusal path. A 2-game "without" subset can show any delta at all by
  // pure variance; publishing a shrunken version of a meaningless number is
  // still publishing a meaningless number.
  if (withPlayer.length < MIN_SUBSET_GAMES || withoutPlayer.length < MIN_SUBSET_GAMES) {
    return {
      offensiveImpactPct: null,
      winProbabilityImpactPp: null,
      sampleSize,
      reliable: false,
    }
  }

  // Shrink factor: the player cannot be credited beyond their share of the
  // minutes, nor beyond what the binding sample supports — whichever bound is
  // tighter wins.
  const sampleFactor = sampleSize / (sampleSize + SAMPLE_SHRINK_HALFPOINT)
  const shrink = Math.min(params.minutesShare, sampleFactor)

  // Offensive impact: relative change in goals per game.
  const withRate = goalsPerGame(withPlayer)
  const withoutRate = goalsPerGame(withoutPlayer)
  const rawOffensivePct =
    withoutRate > 0 ? ((withRate - withoutRate) / withoutRate) * 100 : withRate > 0 ? 100 : 0

  // Win-probability impact: with-vs-without win rate (draw = half a win).
  const rawWinPp = (winRate(withPlayer) - winRate(withoutPlayer)) * 100

  return {
    offensiveImpactPct: rawOffensivePct * shrink,
    winProbabilityImpactPp: rawWinPp * shrink,
    sampleSize,
    reliable: true,
  }
}

function goalsPerGame(games: readonly TeamGameStats[]): number {
  let goals = 0
  for (const g of games) goals += g.scored
  return goals / games.length
}

function winRate(games: readonly TeamGameStats[]): number {
  let points = 0
  for (const g of games) points += g.result === 'W' ? 1 : g.result === 'D' ? 0.5 : 0
  return points / games.length
}
