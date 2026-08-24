import type { Game, Injury, TeamGameStats } from '@/providers/types'
import type { EloEntry } from '@/engines/sports/elo'
import type { MatchFeatures } from '@/engines/sports/models'
import type { SourceRef } from '@/core/prediction/types'

/** A fixed evaluation instant used across the sports tests. */
export const NOW_MS = Date.parse('2026-08-01T12:00:00Z')

export function makeStats(partial: Partial<TeamGameStats> & { gameId: string }): TeamGameStats {
  return {
    teamId: 'team-a',
    isHome: true,
    scored: 1,
    conceded: 1,
    result: 'D',
    shots: null,
    shotsOnTarget: null,
    possession: null,
    expectedGoalsFor: null,
    expectedGoalsAgainst: null,
    extra: {},
    ...partial,
  }
}

/**
 * Build a most-recent-first stats window from a result string, with plausible
 * scorelines (W = 2-0, D = 1-1, L = 0-2) unless overridden.
 */
export function statsFromResults(
  results: readonly ('W' | 'D' | 'L')[],
  overrides: Partial<TeamGameStats> = {},
): TeamGameStats[] {
  return results.map((result, i) =>
    makeStats({
      gameId: `g${i}`,
      result,
      scored: result === 'W' ? 2 : result === 'D' ? 1 : 0,
      conceded: result === 'W' ? 0 : result === 'D' ? 1 : 2,
      isHome: i % 2 === 0,
      ...overrides,
    }),
  )
}

/** Uniform opponent-rating map for a window built by statsFromResults. */
export function flatOpponentRatings(count: number, rating: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (let i = 0; i < count; i++) out[`g${i}`] = rating
  return out
}

export function makeGame(partial: Partial<Game> & { externalId: string }): Game {
  return {
    competitionId: 'PL',
    season: '2025-26',
    kickoff: NOW_MS - 30 * 86_400_000,
    status: 'finished',
    homeTeamId: 'team-a',
    awayTeamId: 'team-b',
    homeTeamName: 'Alpha FC',
    awayTeamName: 'Beta United',
    homeScore: 1,
    awayScore: 1,
    matchday: null,
    venue: null,
    ...partial,
  }
}

export function makeInjury(partial: Partial<Injury> & { playerId: string }): Injury {
  return {
    playerName: `Player ${partial.playerId}`,
    teamId: 'team-a',
    status: 'out',
    reason: null,
    reportedAt: NOW_MS - 86_400_000,
    expectedReturn: null,
    ...partial,
  }
}

export function makeSourceRef(partial: Partial<SourceRef> = {}): SourceRef {
  return {
    providerId: 'football-data',
    capability: 'sports.teamStats',
    reliability: 'HIGH_RELIABILITY',
    fetchedAt: new Date(NOW_MS).toISOString(),
    dataAsOf: new Date(NOW_MS - 3_600_000).toISOString(),
    isDemo: false,
    ...partial,
  }
}

export function makeFeatures(partial: Partial<MatchFeatures> = {}): MatchFeatures {
  const homeElo: EloEntry = { rating: 1550, gamesPlayed: 20 }
  const awayElo: EloEntry = { rating: 1480, gamesPlayed: 20 }
  const homeResults: readonly ('W' | 'D' | 'L')[] = ['W', 'D', 'W', 'L', 'W', 'D', 'W', 'W']
  const awayResults: readonly ('W' | 'D' | 'L')[] = ['L', 'D', 'L', 'W', 'D', 'L', 'L', 'D']
  return {
    gameId: 'pl-2026-0142',
    homeTeamId: 'team-a',
    awayTeamId: 'team-b',
    homeTeamName: 'Alpha FC',
    awayTeamName: 'Beta United',
    homeStats: statsFromResults(homeResults, { teamId: 'team-a' }),
    awayStats: statsFromResults(awayResults, { teamId: 'team-b' }),
    homeOpponentRatings: flatOpponentRatings(homeResults.length, 55),
    awayOpponentRatings: flatOpponentRatings(awayResults.length, 50),
    homeElo,
    awayElo,
    homeInjuries: [],
    awayInjuries: [],
    leagueMeans: { homeGoals: 1.52, awayGoals: 1.2 },
    h2h: { homeWins: 3, draws: 1, awayWins: 1 },
    ...partial,
  }
}

/**
 * Deterministic pseudo-random generator (Park–Miller LCG) for property-style
 * tests — seeded so failures reproduce exactly.
 */
export function seededRandom(seed: number): () => number {
  let state = seed % 2147483647
  if (state <= 0) state += 2147483646
  return () => {
    state = (state * 16807) % 2147483647
    return (state - 1) / 2147483646
  }
}
