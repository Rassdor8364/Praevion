/**
 * Settlement + persistence wiring tests.
 *
 * The pure mapping helpers are tested exhaustively; the orchestrator's
 * persist/settle wiring is tested against mocked repositories — what is
 * asserted is the CONTRACT the learning loop depends on: pre-kickoff
 * predictions get persisted exactly once per throttle window, finished games
 * settle with the correct outcome key, post-kickoff rows never enter the
 * accuracy record, and unfinished games stay pending.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  actualKeyFromScore,
  gameIdFromSubject,
  leagueOfGameId,
} from '@/engines/sports/settlement'

vi.mock('@/db/client', () => ({
  isServiceRoleConfigured: () => true,
}))

vi.mock('@/db/repositories', () => ({
  savePrediction: vi.fn(async () => ({ ok: true as const, value: { id: 'row-1' } })),
  recordPredictionHistory: vi.fn(async () => ({ ok: true as const, value: 3 })),
  getUnsettled: vi.fn(async () => ({ ok: true as const, value: [] })),
  settleOutcome: vi.fn(async () => ({ ok: true as const, value: { id: 'outcome-1' } })),
  getModelPerformance: vi.fn(async () => ({
    ok: true as const,
    value: { totalSettled: 0, ensemble: null, perModel: [], calibration: [] },
  })),
  listResolvedPredictions: vi.fn(async () => ({ ok: true as const, value: [] })),
  listPredictions: vi.fn(async () => ({ ok: true as const, value: [] })),
}))

import * as repositories from '@/db/repositories'
import {
  resetSportsCaches,
  getSportsPersistenceStats,
  SportsIntelligenceOrchestrator,
} from '@/engines/sports/orchestrator'
import type { ProviderRegistry } from '@/providers/registry'
import type { Game } from '@/providers/types'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('actualKeyFromScore', () => {
  it('maps every score relation to its 1X2 key', () => {
    expect(actualKeyFromScore(2, 1)).toBe('home')
    expect(actualKeyFromScore(0, 0)).toBe('draw')
    expect(actualKeyFromScore(1, 3)).toBe('away')
  })

  it('rejects invalid scores', () => {
    expect(() => actualKeyFromScore(-1, 0)).toThrow()
    expect(() => actualKeyFromScore(1.5, 0)).toThrow()
  })
})

describe('subject parsing', () => {
  it('round-trips the persisted subject format', () => {
    expect(gameIdFromSubject('game:eng.1:401879301')).toBe('eng.1:401879301')
    expect(leagueOfGameId('eng.1:401879301')).toBe('eng.1')
    expect(gameIdFromSubject('game:uefa.champions:123')).toBe('uefa.champions:123')
    expect(leagueOfGameId('uefa.champions:123')).toBe('uefa.champions')
  })

  it('returns null for foreign or malformed subjects', () => {
    expect(gameIdFromSubject('BTCUSDT')).toBeNull()
    expect(gameIdFromSubject('game:')).toBeNull()
    expect(gameIdFromSubject('game:noleague')).toBeNull()
    expect(gameIdFromSubject('game:eng.1:')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Orchestrator wiring
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-03-10T12:00:00Z')
const DAY = 86_400_000

function makeGame(partial: Partial<Game> & { externalId: string }): Game {
  return {
    competitionId: 'eng.1',
    season: '2025',
    kickoff: NOW - 30 * DAY,
    status: 'finished',
    homeTeamId: 'eng.1:H',
    awayTeamId: 'eng.1:A',
    homeTeamName: 'Home FC',
    awayTeamName: 'Away FC',
    homeScore: 2,
    awayScore: 1,
    matchday: null,
    venue: null,
    ...partial,
  }
}

/** A league window: enough finished history to predict, one game finished
 *  yesterday (settleable) and one scheduled tomorrow (persistable). */
function leagueGames(): Game[] {
  const games: Game[] = []
  for (let i = 0; i < 12; i++) {
    games.push(
      makeGame({
        externalId: `eng.1:hist${i}`,
        kickoff: NOW - (60 - i * 3) * DAY,
        homeTeamId: i % 2 === 0 ? 'eng.1:H' : 'eng.1:A',
        awayTeamId: i % 2 === 0 ? 'eng.1:A' : 'eng.1:H',
        homeScore: 1 + (i % 3),
        awayScore: i % 2,
      }),
    )
  }
  games.push(makeGame({ externalId: 'eng.1:done', kickoff: NOW - DAY, homeScore: 3, awayScore: 1 }))
  games.push(
    makeGame({
      externalId: 'eng.1:next',
      kickoff: NOW + DAY,
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
    }),
  )
  return games
}

function fakeRegistry(games: readonly Game[]): ProviderRegistry {
  const provider = {
    id: 'espn',
    reliability: 'COMMUNITY' as const,
    getGames: async (q: { from: number; to: number }) => ({
      ok: true as const,
      value: {
        data: games.filter((g) => g.kickoff >= q.from && g.kickoff < q.to),
        provenance: { sourceId: 'espn', fetchedAt: NOW, dataAsOf: NOW, isDemo: false },
      },
    }),
    getTeams: async () => ({
      ok: true as const,
      value: {
        data: [],
        provenance: { sourceId: 'espn', fetchedAt: NOW, dataAsOf: NOW, isDemo: false },
      },
    }),
    getTeamGameStats: async () => ({
      ok: false as const,
      error: new Error('not in this fake'),
    }),
  }
  return {
    resolve: async (_capability: string, run: (p: unknown) => Promise<unknown>) => ({
      result: await run(provider),
      attempts: [],
    }),
    chain: () => [provider],
  } as unknown as ProviderRegistry
}

const clock = { now: () => NOW }

beforeEach(() => {
  resetSportsCaches()
  vi.clearAllMocks()
})

afterEach(() => {
  resetSportsCaches()
})

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('prediction persistence', () => {
  it('persists a scheduled pre-kickoff prediction once, then throttles repeats', async () => {
    const orchestrator = new SportsIntelligenceOrchestrator({
      registry: fakeRegistry(leagueGames()),
      clock,
    })

    const board = await orchestrator.getLeagueBoard('eng.1')
    expect(board.ok).toBe(true)
    if (!board.ok) return
    expect(board.value.upcoming.length).toBe(1)
    await flushAsync()

    const save = vi.mocked(repositories.savePrediction)
    expect(save).toHaveBeenCalledTimes(1)
    const persisted = save.mock.calls[0]?.[0]
    expect(persisted?.subject).toBe('game:eng.1:next')
    expect(persisted?.domain).toBe('sports')
    // The history time-series followed the save, one point per outcome.
    expect(vi.mocked(repositories.recordPredictionHistory)).toHaveBeenCalledTimes(1)

    // A second board view inside the throttle window must not write again.
    const again = await orchestrator.getLeagueBoard('eng.1')
    expect(again.ok).toBe(true)
    await flushAsync()
    expect(save).toHaveBeenCalledTimes(1)
    expect(getSportsPersistenceStats().throttled).toBeGreaterThanOrEqual(1)
    expect(getSportsPersistenceStats().saved).toBe(1)
  })
})

describe('settleFinishedGames', () => {
  it('settles finished games, keeps pending ones open, and enforces the kickoff lock', async () => {
    const games = leagueGames()
    const doneKickoff = NOW - DAY
    vi.mocked(repositories.getUnsettled).mockResolvedValue({
      ok: true as const,
      value: [
        // Legitimate: generated an hour before kickoff of a finished game.
        {
          id: 'p-done',
          subject: 'game:eng.1:done',
          generated_at: new Date(doneKickoff - 3_600_000).toISOString(),
        },
        // Lock violation: generated after kickoff — must be skipped.
        {
          id: 'p-late',
          subject: 'game:eng.1:done',
          generated_at: new Date(doneKickoff + 3_600_000).toISOString(),
        },
        // Game not finished yet — stays pending.
        {
          id: 'p-open',
          subject: 'game:eng.1:next',
          generated_at: new Date(NOW - 3_600_000).toISOString(),
        },
        // Foreign subject — skipped.
        { id: 'p-foreign', subject: 'BTCUSDT', generated_at: new Date(NOW).toISOString() },
      ] as never,
    })

    const orchestrator = new SportsIntelligenceOrchestrator({
      registry: fakeRegistry(games),
      clock,
    })
    const report = await orchestrator.settleFinishedGames()
    expect(report.ok).toBe(true)
    if (!report.ok) return

    expect(report.value.checked).toBe(4)
    expect(report.value.settled).toBe(1)
    expect(report.value.pending).toBe(1)
    expect(report.value.skipped).toBe(2)

    const settle = vi.mocked(repositories.settleOutcome)
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0]?.[0]).toBe('p-done')
    expect(settle.mock.calls[0]?.[1]).toBe('home') // 3-1
    const evidence = settle.mock.calls[0]?.[2]?.evidence as Record<string, unknown>
    expect(evidence['homeScore']).toBe(3)
    expect(evidence['awayScore']).toBe(1)
  })
})
