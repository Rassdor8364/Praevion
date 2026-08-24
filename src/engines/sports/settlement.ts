/**
 * Settlement mapping — the pure half of prediction resolution.
 *
 * Everything that touches the database or the provider lives in the
 * orchestrator; what lives here is the part worth testing exhaustively: how
 * a final score becomes the outcome key a prediction is scored against, and
 * how a persisted subject string is parsed back into a game reference.
 *
 * The subject format is the one the orchestrator writes at persist time:
 * `game:<leagueId>:<providerGameId>`, e.g. `game:eng.1:401879301`, where the
 * league prefix is itself dotted — hence lastIndexOf, not split.
 */

export const MATCH_SETTLEMENT_KEYS = ['home', 'draw', 'away'] as const
export type MatchSettlementKey = (typeof MATCH_SETTLEMENT_KEYS)[number]

/** Final score → the 1X2 outcome key that actually occurred. */
export function actualKeyFromScore(homeScore: number, awayScore: number): MatchSettlementKey {
  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
    throw new Error(`actualKeyFromScore requires non-negative integer scores, got ${homeScore}-${awayScore}`)
  }
  if (homeScore > awayScore) return 'home'
  if (homeScore === awayScore) return 'draw'
  return 'away'
}

/** `game:eng.1:401879301` → `eng.1:401879301`, or null for foreign subjects. */
export function gameIdFromSubject(subject: string): string | null {
  if (!subject.startsWith('game:')) return null
  const gameId = subject.slice('game:'.length)
  // A well-formed game id is `<league>:<id>` with a non-empty tail.
  const at = gameId.lastIndexOf(':')
  if (at <= 0 || at === gameId.length - 1) return null
  return gameId
}

/** `eng.1:401879301` → `eng.1`. */
export function leagueOfGameId(gameExternalId: string): string | null {
  const at = gameExternalId.lastIndexOf(':')
  return at > 0 ? gameExternalId.slice(0, at) : null
}
