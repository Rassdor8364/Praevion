import { describe, expect, it } from 'vitest'

import {
  ScheduleSchema,
  ScoreboardSchema,
  formatDateRange,
  mapStatus,
  parseId,
  prefixId,
  toGame,
  toTeamGameStats,
  type ScheduleEvent,
  type ScoreboardEvent,
} from '@/providers/sports/espn'

// ---------------------------------------------------------------------------
// Fixtures — trimmed copies of REAL payloads probed from
// site.api.espn.com/apis/site/v2/sports/soccer/eng.1 (2026-08-13). The shapes
// here (string scores on the scoreboard, object scores on the schedule) are
// exactly what the live API returned; the tests pin the mapping to them.
// ---------------------------------------------------------------------------

/** Scoreboard event pre-kickoff: note score "0" is PADDING, not a scoreline. */
const scheduledScoreboardEvent = {
  id: '401879301',
  date: '2026-08-21T19:00Z',
  season: { year: 2026, type: 14308, slug: '2026-27-english-premier-league' },
  competitions: [
    {
      status: {
        clock: 0,
        type: { id: '1', name: 'STATUS_SCHEDULED', state: 'pre', completed: false },
      },
      venue: { fullName: 'Emirates Stadium', address: { city: 'London', country: 'England' } },
      competitors: [
        {
          id: '359',
          homeAway: 'home',
          winner: false,
          score: '0',
          team: { id: '359', displayName: 'Arsenal', shortDisplayName: 'Arsenal', abbreviation: 'ARS' },
        },
        {
          id: '388',
          homeAway: 'away',
          winner: false,
          score: '0',
          team: { id: '388', displayName: 'Coventry City', shortDisplayName: 'Coventry', abbreviation: 'COV' },
        },
      ],
    },
  ],
}

/** Scoreboard event after full time (2025-26 season run-in). */
const finishedScoreboardEvent = {
  id: '740942',
  date: '2026-05-01T19:00Z',
  season: { year: 2025 },
  competitions: [
    {
      status: { type: { id: '28', name: 'STATUS_FULL_TIME', state: 'post', completed: true } },
      venue: { fullName: 'Elland Road' },
      competitors: [
        { homeAway: 'home', winner: true, score: '3', team: { id: '357', displayName: 'Leeds United' } },
        { homeAway: 'away', winner: false, score: '1', team: { id: '379', displayName: 'Burnley' } },
      ],
    },
  ],
}

/** Schedule event: score is an OBJECT here, unlike the scoreboard's string. */
function scheduleEvent(params: {
  id?: string
  homeId: string
  awayId: string
  homeScore: number | null
  awayScore: number | null
  statusName?: string
  completed?: boolean
}): unknown {
  const { id = '740968', homeId, awayId, homeScore, awayScore } = params
  const statusName = params.statusName ?? 'STATUS_FULL_TIME'
  const completed = params.completed ?? true
  const score = (v: number | null, winner: boolean) =>
    v === null ? undefined : { value: v, displayValue: String(v), winner }
  return {
    id,
    date: '2026-05-24T15:00Z',
    season: { year: 2025, displayName: '2025-26 English Premier League' },
    competitions: [
      {
        status: {
          clock: 5400,
          type: { id: '28', name: statusName, state: completed ? 'post' : 'pre', completed },
        },
        competitors: [
          {
            id: homeId,
            homeAway: 'home',
            winner: homeScore !== null && awayScore !== null && homeScore > awayScore,
            score: score(homeScore, homeScore !== null && awayScore !== null && homeScore > awayScore),
            team: { id: homeId, displayName: `Home ${homeId}` },
          },
          {
            id: awayId,
            homeAway: 'away',
            winner: homeScore !== null && awayScore !== null && awayScore > homeScore,
            score: score(awayScore, homeScore !== null && awayScore !== null && awayScore > homeScore),
            team: { id: awayId, displayName: `Away ${awayId}` },
          },
        ],
      },
    ],
  }
}

function parseScoreboardEvent(raw: unknown): ScoreboardEvent {
  const parsed = ScoreboardSchema.safeParse({ events: [raw] })
  if (!parsed.success) throw new Error(parsed.error.message)
  const event = parsed.data.events[0]
  if (!event) throw new Error('fixture lost in parse')
  return event
}

function parseScheduleEvent(raw: unknown): ScheduleEvent {
  const parsed = ScheduleSchema.safeParse({ season: { year: 2026 }, events: [raw] })
  if (!parsed.success) throw new Error(parsed.error.message)
  const event = parsed.data.events[0]
  if (!event) throw new Error('fixture lost in parse')
  return event
}

describe('mapStatus', () => {
  it('maps the probed vocabulary onto GameStatus', () => {
    expect(mapStatus('STATUS_SCHEDULED', 'pre', false)).toBe('scheduled')
    expect(mapStatus('STATUS_FIRST_HALF', 'in', false)).toBe('live')
    expect(mapStatus('STATUS_HALFTIME', 'in', false)).toBe('live')
    expect(mapStatus('STATUS_SECOND_HALF', 'in', false)).toBe('live')
    expect(mapStatus('STATUS_FULL_TIME', 'post', true)).toBe('finished')
    expect(mapStatus('STATUS_POSTPONED', 'post', false)).toBe('postponed')
    expect(mapStatus('STATUS_ABANDONED', 'post', false)).toBe('postponed')
    expect(mapStatus('STATUS_CANCELED', 'post', false)).toBe('cancelled')
  })

  it('falls back to state for unknown names, and never invents a result', () => {
    expect(mapStatus('STATUS_SOMETHING_NEW', 'in', false)).toBe('live')
    expect(mapStatus('STATUS_SOMETHING_NEW', 'post', true)).toBe('finished')
    // post but NOT completed: must not be scored as a finished match.
    expect(mapStatus('STATUS_SOMETHING_NEW', 'post', false)).toBe('postponed')
    expect(mapStatus(undefined, undefined, undefined)).toBe('scheduled')
  })
})

describe('id prefix/parse', () => {
  it('round-trips league-prefixed ids, including leagues containing dots', () => {
    for (const [league, id] of [
      ['eng.1', '359'],
      ['uefa.champions', '86'],
      ['usa.1', '186'],
    ] as const) {
      expect(parseId(prefixId(league, id))).toEqual({ league, id })
    }
  })

  it('rejects ids that are not league-prefixed', () => {
    expect(parseId('359')).toBeNull()
    expect(parseId('eng.1:')).toBeNull()
    expect(parseId(':359')).toBeNull()
  })
})

describe('formatDateRange', () => {
  it('formats an epoch-ms window as the UTC YYYYMMDD-YYYYMMDD dates param', () => {
    const from = Date.UTC(2026, 7, 12) // 2026-08-12
    const to = Date.UTC(2026, 7, 26)
    expect(formatDateRange(from, to)).toBe('20260812-20260826')
  })
})

describe('toGame', () => {
  it('maps a scheduled event with null scores despite ESPN padding score to "0"', () => {
    const game = toGame(parseScoreboardEvent(scheduledScoreboardEvent), 'eng.1')
    expect(game).not.toBeNull()
    expect(game?.externalId).toBe('eng.1:401879301')
    expect(game?.competitionId).toBe('eng.1')
    expect(game?.season).toBe('2026')
    expect(game?.status).toBe('scheduled')
    expect(game?.homeTeamId).toBe('eng.1:359')
    expect(game?.awayTeamId).toBe('eng.1:388')
    expect(game?.homeTeamName).toBe('Arsenal')
    // "0" pre-kickoff is padding, not a scoreline.
    expect(game?.homeScore).toBeNull()
    expect(game?.awayScore).toBeNull()
    expect(game?.venue).toBe('Emirates Stadium')
    expect(game?.kickoff).toBe(Date.parse('2026-08-21T19:00Z'))
  })

  it('surfaces numeric scores on a finished event', () => {
    const game = toGame(parseScoreboardEvent(finishedScoreboardEvent), 'eng.1')
    expect(game?.status).toBe('finished')
    expect(game?.homeScore).toBe(3)
    expect(game?.awayScore).toBe(1)
  })
})

describe('toTeamGameStats', () => {
  it('scores the winner W regardless of home/away, for any scoreline a > b', () => {
    // Property over a grid of scorelines: whoever scored more gets 'W' whether
    // they were the home or the away competitor.
    for (let a = 1; a <= 4; a++) {
      for (let b = 0; b < a; b++) {
        const asHome = toTeamGameStats(
          parseScheduleEvent(scheduleEvent({ homeId: '359', awayId: '388', homeScore: a, awayScore: b })),
          'eng.1',
          '359',
        )
        const asAway = toTeamGameStats(
          parseScheduleEvent(scheduleEvent({ homeId: '388', awayId: '359', homeScore: b, awayScore: a })),
          'eng.1',
          '359',
        )
        expect(asHome?.result).toBe('W')
        expect(asHome?.isHome).toBe(true)
        expect(asHome?.scored).toBe(a)
        expect(asHome?.conceded).toBe(b)
        expect(asAway?.result).toBe('W')
        expect(asAway?.isHome).toBe(false)
        expect(asAway?.scored).toBe(a)
        expect(asAway?.conceded).toBe(b)
        // And the opponent's view of the same match is a loss.
        const loser = toTeamGameStats(
          parseScheduleEvent(scheduleEvent({ homeId: '359', awayId: '388', homeScore: a, awayScore: b })),
          'eng.1',
          '388',
        )
        expect(loser?.result).toBe('L')
      }
    }
  })

  it('maps equal scores to a draw and prefixes both ids with the league', () => {
    const row = toTeamGameStats(
      parseScheduleEvent(scheduleEvent({ homeId: '359', awayId: '388', homeScore: 2, awayScore: 2 })),
      'eng.1',
      '359',
    )
    expect(row?.result).toBe('D')
    expect(row?.gameId).toBe('eng.1:740968')
    expect(row?.teamId).toBe('eng.1:359')
  })

  it('reports no shots/possession/xG — ESPN does not publish them', () => {
    const row = toTeamGameStats(
      parseScheduleEvent(scheduleEvent({ homeId: '359', awayId: '388', homeScore: 1, awayScore: 0 })),
      'eng.1',
      '359',
    )
    expect(row?.shots).toBeNull()
    expect(row?.shotsOnTarget).toBeNull()
    expect(row?.possession).toBeNull()
    expect(row?.expectedGoalsFor).toBeNull()
    expect(row?.expectedGoalsAgainst).toBeNull()
  })

  it('skips unplayed fixtures and finished matches with missing scores', () => {
    const unplayed = toTeamGameStats(
      parseScheduleEvent(
        scheduleEvent({
          homeId: '359',
          awayId: '388',
          homeScore: null,
          awayScore: null,
          statusName: 'STATUS_SCHEDULED',
          completed: false,
        }),
      ),
      'eng.1',
      '359',
    )
    expect(unplayed).toBeNull()

    // Upstream gap: FULL_TIME but no score object. Skip, do not score 0-0.
    const gap = toTeamGameStats(
      parseScheduleEvent(scheduleEvent({ homeId: '359', awayId: '388', homeScore: null, awayScore: null })),
      'eng.1',
      '359',
    )
    expect(gap).toBeNull()
  })
})

describe('schema tripwire', () => {
  it('rejects a scoreboard whose scores stopped being strings', () => {
    const mutated = structuredClone(finishedScoreboardEvent) as {
      competitions: { competitors: { score: unknown }[] }[]
    }
    mutated.competitions[0]!.competitors[0]!.score = 3 // number, not "3"
    expect(ScoreboardSchema.safeParse({ events: [mutated] }).success).toBe(false)
  })

  it('rejects events missing structural fields instead of passing them through', () => {
    expect(ScoreboardSchema.safeParse({ events: [{ id: 123 }] }).success).toBe(false)
    expect(ScoreboardSchema.safeParse({}).success).toBe(false)
    expect(
      ScheduleSchema.safeParse({ events: [{ id: '1', date: '2026-05-24T15:00Z' }] }).success,
    ).toBe(false)
  })

  it('accepts the real payload shapes it was written from', () => {
    expect(ScoreboardSchema.safeParse({ events: [scheduledScoreboardEvent] }).success).toBe(true)
    expect(ScoreboardSchema.safeParse({ events: [finishedScoreboardEvent] }).success).toBe(true)
    expect(
      ScheduleSchema.safeParse({
        season: { year: 2026, type: 14308 },
        events: [scheduleEvent({ homeId: '384', awayId: '359', homeScore: 1, awayScore: 2 })],
      }).success,
    ).toBe(true)
  })
})
