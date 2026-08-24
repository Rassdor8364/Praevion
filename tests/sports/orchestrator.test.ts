/**
 * Pure derivation helpers of the sports orchestrator. The I/O paths
 * (dataset assembly, caching) are exercised end-to-end against the live
 * provider chain; these tests pin the deterministic logic they rest on.
 */

import { describe, expect, it } from 'vitest'
import {
  boxScoreCompleteness,
  latestSeasonLabel,
  monthlyChunks,
  seasonStartOf,
  teamWindow,
  toFinishedGames,
} from '@/engines/sports/orchestrator'
import type { Game, TeamGameStats } from '@/providers/types'

function makeGame(partial: Partial<Game> & { externalId: string }): Game {
  return {
    competitionId: 'eng.1',
    season: '2025',
    kickoff: Date.parse('2025-10-04T14:00:00Z'),
    status: 'finished',
    homeTeamId: 'eng.1:1',
    awayTeamId: 'eng.1:2',
    homeTeamName: 'Home FC',
    awayTeamName: 'Away FC',
    homeScore: 2,
    awayScore: 1,
    matchday: null,
    venue: null,
    ...partial,
  }
}

describe('monthlyChunks', () => {
  it('covers the range contiguously with month-aligned boundaries', () => {
    const from = Date.parse('2025-07-15T06:00:00Z')
    const to = Date.parse('2025-10-02T00:00:00Z')
    const chunks = monthlyChunks(from, to)

    expect(chunks[0]?.from).toBe(from)
    expect(chunks[chunks.length - 1]?.to).toBe(to)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.from).toBe(chunks[i - 1]?.to)
    }
    // Interior boundaries land on UTC month starts (the cap-avoidance shape).
    expect(new Date(chunks[0]?.to ?? 0).toISOString()).toBe('2025-08-01T00:00:00.000Z')
    // Every chunk spans at most one month.
    for (const c of chunks) {
      expect(c.to - c.from).toBeLessThanOrEqual(31 * 86_400_000)
    }
  })

  it('returns an empty list for an empty range', () => {
    expect(monthlyChunks(1000, 1000)).toEqual([])
  })
})

describe('toFinishedGames', () => {
  it('keeps only finished games with real scores', () => {
    const games = [
      makeGame({ externalId: 'a' }),
      makeGame({ externalId: 'b', status: 'scheduled', homeScore: null, awayScore: null }),
      makeGame({ externalId: 'c', status: 'finished', homeScore: null, awayScore: null }),
    ]
    const finished = toFinishedGames(games)
    expect(finished).toHaveLength(1)
    expect(finished[0]?.homeScore).toBe(2)
  })
})

describe('teamWindow', () => {
  it('derives a most-recent-first box window with an opponent map', () => {
    const t = (iso: string) => Date.parse(iso)
    const games = [
      makeGame({ externalId: 'g1', kickoff: t('2025-08-10T14:00:00Z'), homeScore: 3, awayScore: 0 }),
      makeGame({
        externalId: 'g2',
        kickoff: t('2025-08-20T14:00:00Z'),
        homeTeamId: 'eng.1:3',
        awayTeamId: 'eng.1:1',
        homeScore: 2,
        awayScore: 2,
      }),
      makeGame({ externalId: 'other', homeTeamId: 'eng.1:4', awayTeamId: 'eng.1:5' }),
    ]
    const { stats, opponentByGameId } = teamWindow(games, 'eng.1:1')

    expect(stats.map((s) => s.gameId)).toEqual(['g2', 'g1']) // newest first
    expect(stats[0]).toMatchObject({ isHome: false, scored: 2, conceded: 2, result: 'D' })
    expect(stats[1]).toMatchObject({ isHome: true, scored: 3, conceded: 0, result: 'W' })
    expect(opponentByGameId.get('g1')).toBe('eng.1:2')
    expect(opponentByGameId.get('g2')).toBe('eng.1:3')
    // Scores-only feed: optional box fields stay null, never invented.
    expect(stats[0]?.expectedGoalsFor).toBeNull()
  })
})

describe('season helpers', () => {
  it('seasonStartOf takes the earliest kickoff carrying the label', () => {
    const games = [
      makeGame({ externalId: 'a', season: '2026', kickoff: Date.parse('2026-08-21T19:00:00Z'), status: 'scheduled', homeScore: null, awayScore: null }),
      makeGame({ externalId: 'b', season: '2026', kickoff: Date.parse('2026-08-22T14:00:00Z'), status: 'scheduled', homeScore: null, awayScore: null }),
      makeGame({ externalId: 'c', season: '2025', kickoff: Date.parse('2025-08-15T19:00:00Z') }),
    ]
    expect(seasonStartOf('2026', [games])).toBe(Date.parse('2026-08-21T19:00:00Z'))
    expect(seasonStartOf('2025', [games])).toBe(Date.parse('2025-08-15T19:00:00Z'))
  })

  it('seasonStartOf falls back to July 1 of the season year when no game carries the label', () => {
    expect(seasonStartOf('2026', [[]])).toBe(Date.UTC(2026, 6, 1))
  })

  it('latestSeasonLabel follows the newest kickoff', () => {
    const games = [
      makeGame({ externalId: 'a', season: '2025', kickoff: Date.parse('2026-05-24T15:00:00Z') }),
      makeGame({ externalId: 'b', season: '2026', kickoff: Date.parse('2026-08-21T19:00:00Z'), status: 'scheduled', homeScore: null, awayScore: null }),
    ]
    expect(latestSeasonLabel([games])).toBe('2026')
    expect(latestSeasonLabel([[]])).toBeNull()
  })
})

describe('boxScoreCompleteness', () => {
  const base: Omit<TeamGameStats, 'gameId'> = {
    teamId: 'eng.1:1',
    isHome: true,
    scored: 1,
    conceded: 0,
    result: 'W',
    shots: null,
    shotsOnTarget: null,
    possession: null,
    expectedGoalsFor: null,
    expectedGoalsAgainst: null,
    extra: {},
  }

  it('is 0.5 for a scores-only feed (mandatory fields only)', () => {
    expect(boxScoreCompleteness([{ ...base, gameId: 'g1' }])).toBe(0.5)
  })

  it('rises with populated optional fields and reaches 1 when all are present', () => {
    const full: TeamGameStats = {
      ...base,
      gameId: 'g1',
      shots: 12,
      shotsOnTarget: 5,
      possession: 55,
      expectedGoalsFor: 1.4,
      expectedGoalsAgainst: 0.7,
    }
    expect(boxScoreCompleteness([full])).toBe(1)
    expect(boxScoreCompleteness([full, { ...base, gameId: 'g2' }])).toBe(0.75)
  })

  it('is 0 for an empty window', () => {
    expect(boxScoreCompleteness([])).toBe(0)
  })
})
