/**
 * football-data.org v4 (association football).
 *
 * The only keyed sports source in the stack. The free tier covers ~12 major
 * competitions with fixtures, results and standings, which is enough to drive
 * the match model — but it stops at the scoreline. Shots, possession and xG are
 * NOT available at any price on this API's free tier, and this adapter reports
 * them as null rather than deriving stand-ins from goals. A model that receives
 * `shots: null` abstains on that feature; a model that receives an invented
 * shot count silently prices a guess as evidence.
 *
 * Auth is a single header, and an absent key means the provider is simply never
 * registered (see `isConfigured`), so the chain falls straight through to demo.
 */

import { z } from 'zod'
import { ProviderError } from '@/core/errors'
import { err, ok } from '@/core/result'
import { fetchJson } from '../http'
import type {
  Capability,
  Competition,
  Game,
  GameStatus,
  ProviderHealth,
  ProviderResult,
  SportsProvider,
  Sourced,
  Team,
  TeamGameStats,
} from '../types'

const BASE = 'https://api.football-data.org/v4'
const PROVIDER_ID = 'football-data'
/** Free tier is 10 requests/minute and answers 429 the instant you exceed it. */
const RATE_LIMIT = { capacity: 10, windowMs: 60_000 } as const

const AreaSchema = z.object({ name: z.string().nullish() })

const SeasonSchema = z.object({
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
})

const CompetitionRefSchema = z.object({
  id: z.number().nullish(),
  code: z.string().nullish(),
  name: z.string().nullish(),
})

const CompetitionSchema = z.object({
  id: z.number(),
  /** Short code ('PL', 'CL'); this is what every other path segment expects. */
  code: z.string().nullish(),
  name: z.string(),
  area: AreaSchema.nullish(),
  currentSeason: SeasonSchema.nullish(),
})
const CompetitionsSchema = z.object({ competitions: z.array(CompetitionSchema) })

const TeamSchema = z.object({
  id: z.number(),
  name: z.string(),
  shortName: z.string().nullish(),
  tla: z.string().nullish(),
  crest: z.string().nullish(),
})
const TeamsSchema = z.object({ teams: z.array(TeamSchema) })

/**
 * `score.fullTime` holds nulls until the match is played, and `winner` is
 * present only afterwards. Everything optional is modelled as nullish because
 * the API omits rather than nulls some fields depending on status.
 */
const MatchSchema = z.object({
  id: z.number(),
  utcDate: z.string(),
  status: z.string(),
  matchday: z.number().nullish(),
  homeTeam: z.object({
    id: z.number().nullish(),
    name: z.string().nullish(),
    shortName: z.string().nullish(),
  }),
  awayTeam: z.object({
    id: z.number().nullish(),
    name: z.string().nullish(),
    shortName: z.string().nullish(),
  }),
  score: z.object({
    fullTime: z.object({
      home: z.number().nullish(),
      away: z.number().nullish(),
    }),
  }),
  competition: CompetitionRefSchema.nullish(),
  season: SeasonSchema.nullish(),
})
const MatchesSchema = z.object({ matches: z.array(MatchSchema) })

/**
 * football-data's status vocabulary is wider than ours. IN_PLAY and PAUSED (the
 * half-time state) both mean "the match is happening", and SUSPENDED/AWARDED are
 * documented but rare — SUSPENDED is treated as postponed and AWARDED as
 * finished, because that is how each affects a settled prediction.
 */
function toGameStatus(raw: string): GameStatus {
  switch (raw) {
    case 'SCHEDULED':
    case 'TIMED':
      return 'scheduled'
    case 'IN_PLAY':
    case 'PAUSED':
      return 'live'
    case 'FINISHED':
    case 'AWARDED':
      return 'finished'
    case 'POSTPONED':
    case 'SUSPENDED':
      return 'postponed'
    case 'CANCELLED':
      return 'cancelled'
    default:
      // An unrecognised status must not be silently called 'finished' — a
      // prediction would be scored against a match that never completed.
      return 'scheduled'
  }
}

export class FootballDataProvider implements SportsProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'football-data.org'
  readonly sport = 'football' as const
  readonly reliability = 'ESTABLISHED_MEDIA' as const
  readonly isDemo = false
  readonly capabilities: readonly Capability[] = [
    'sports.competitions',
    'sports.teams',
    'sports.games',
    'sports.teamStats',
  ]

  isConfigured(): boolean {
    return Boolean(process.env.FOOTBALL_DATA_API_KEY)
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/competitions`,
      schema: CompetitionsSchema,
      headers: headers(),
      timeoutMs: 8000,
      retries: 0,
    })
    return {
      healthy: r.ok,
      latencyMs: Date.now() - started,
      message: r.ok ? null : r.error.message,
    }
  }

  async getCompetitions(): Promise<ProviderResult<Competition[]>> {
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/competitions`,
      schema: CompetitionsSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const competitions: Competition[] = []
    for (const c of r.value.competitions) {
      // Every other endpoint is addressed by code, so a competition without one
      // is unusable downstream and is dropped rather than returned unqueryable.
      if (!c.code) continue
      competitions.push({
        externalId: c.code,
        name: c.name,
        sport: 'football',
        country: c.area?.name ?? null,
        currentSeason: seasonLabel(c.currentSeason?.startDate),
      })
    }

    if (competitions.length === 0) return err(badPayload('no addressable competitions returned'))
    const now = Date.now()
    return ok(sourced(competitions, now))
  }

  async getTeams(competitionId: string): Promise<ProviderResult<Team[]>> {
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/competitions/${encodeURIComponent(competitionId)}/teams`,
      schema: TeamsSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const teams: Team[] = r.value.teams.map((t) => ({
      externalId: String(t.id),
      name: t.name,
      // shortName is usually present; tla ('ARS') is the fallback before the
      // full name, since a truncated full name reads worse than either.
      shortName: t.shortName ?? t.tla ?? t.name,
      competitionId,
      crestUrl: t.crest ?? null,
    }))

    const now = Date.now()
    return ok(sourced(teams, now))
  }

  async getGames(params: {
    competitionId: string
    from?: number
    to?: number
    status?: GameStatus
  }): Promise<ProviderResult<Game[]>> {
    const query: string[] = []
    if (params.from !== undefined) query.push(`dateFrom=${toIsoDate(params.from)}`)
    if (params.to !== undefined) query.push(`dateTo=${toIsoDate(params.to)}`)
    const suffix = query.length > 0 ? `?${query.join('&')}` : ''

    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/competitions/${encodeURIComponent(params.competitionId)}/matches${suffix}`,
      schema: MatchesSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const games: Game[] = []
    for (const m of r.value.matches) {
      const game = toGame(m, params.competitionId)
      if (!game) continue
      // Status is filtered locally rather than via the API's `status` param:
      // our 'live' spans two upstream statuses, and one local pass is cheaper
      // than reasoning about that mapping in a query string.
      if (params.status && game.status !== params.status) continue
      games.push(game)
    }

    // dataAsOf is fetch time, not the newest kickoff: a fixture list is a
    // statement about the future, and its freshness is when we asked.
    return ok(sourced(games, Date.now()))
  }

  async getTeamGameStats(teamId: string, limit: number): Promise<ProviderResult<TeamGameStats[]>> {
    // The API's `limit` truncates from the START of the result set, so asking
    // for `limit=5` would return the season's FIRST five matches — the opposite
    // of the recent form the model needs. The whole finished set for the current
    // season is fetched instead (a few dozen rows at most) and trimmed from the
    // tail locally.
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/teams/${encodeURIComponent(teamId)}/matches?status=FINISHED`,
      schema: MatchesSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    // Sorted explicitly rather than trusting the response order, because the
    // tail-trim below is what defines "most recent" and must not depend on an
    // undocumented ordering guarantee.
    const ordered = [...r.value.matches].sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate))

    const stats: TeamGameStats[] = []
    for (const m of ordered) {
      const homeId = m.homeTeam.id
      const awayId = m.awayTeam.id
      const homeScore = m.score.fullTime.home
      const awayScore = m.score.fullTime.away
      if (homeId === null || homeId === undefined) continue
      if (awayId === null || awayId === undefined) continue
      // A FINISHED match with a null score is an upstream data gap (it happens
      // for awarded/abandoned fixtures); it is skipped, not scored as 0-0.
      if (typeof homeScore !== 'number' || typeof awayScore !== 'number') continue

      const isHome = String(homeId) === String(teamId)
      const scored = isHome ? homeScore : awayScore
      const conceded = isHome ? awayScore : homeScore

      stats.push({
        gameId: String(m.id),
        teamId: String(teamId),
        isHome,
        scored,
        conceded,
        result: scored > conceded ? 'W' : scored === conceded ? 'D' : 'L',
        // ---------------------------------------------------------------
        // Deliberately null: football-data.org's free tier serves scores and
        // fixtures only. It publishes NO shot counts, NO possession and NO
        // expected goals. These stay null so downstream models abstain on the
        // corresponding features instead of consuming a fabricated proxy
        // (e.g. "shots ≈ goals × 8"), which would look like evidence and carry
        // none.
        // ---------------------------------------------------------------
        shots: null,
        shotsOnTarget: null,
        possession: null,
        expectedGoalsFor: null,
        expectedGoalsAgainst: null,
        extra: {},
      })
    }

    if (stats.length === 0) return err(badPayload(`no finished matches with scores for team ${teamId}`))
    const trimmed = stats.slice(Math.max(0, stats.length - limit))
    return ok(sourced(trimmed, Date.now()))
  }
}

function headers(): Record<string, string> {
  return {
    'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY ?? '',
    'User-Agent': 'VixeraIntelligence/1.0',
  }
}

function toGame(m: z.infer<typeof MatchSchema>, fallbackCompetition: string): Game | null {
  const kickoff = Date.parse(m.utcDate)
  if (!Number.isFinite(kickoff)) return null
  const homeId = m.homeTeam.id
  const awayId = m.awayTeam.id
  if (homeId === null || homeId === undefined) return null
  if (awayId === null || awayId === undefined) return null

  return {
    externalId: String(m.id),
    competitionId: m.competition?.code ?? fallbackCompetition,
    season: seasonLabel(m.season?.startDate) ?? 'unknown',
    kickoff,
    status: toGameStatus(m.status),
    homeTeamId: String(homeId),
    awayTeamId: String(awayId),
    homeTeamName: m.homeTeam.name ?? String(homeId),
    awayTeamName: m.awayTeam.name ?? String(awayId),
    homeScore: typeof m.score.fullTime.home === 'number' ? m.score.fullTime.home : null,
    awayScore: typeof m.score.fullTime.away === 'number' ? m.score.fullTime.away : null,
    matchday: typeof m.matchday === 'number' ? m.matchday : null,
    // v4 does not include venue on the match resource, only on the team.
    venue: null,
  }
}

/**
 * '2025-08-15' → '2025/26'.
 *
 * European seasons span the new year, so the start year alone is ambiguous in a
 * UI. The label is derived from the start date because that is the only season
 * field the free tier reliably populates on every resource.
 */
function seasonLabel(startDate: string | null | undefined): string | null {
  if (!startDate) return null
  const year = Number(startDate.slice(0, 4))
  if (!Number.isFinite(year)) return null
  const nextTwo = String((year + 1) % 100).padStart(2, '0')
  return `${year}/${nextTwo}`
}

/** Epoch ms → 'YYYY-MM-DD' in UTC, the only date format the API accepts. */
function toIsoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

function sourced<T>(data: T, dataAsOf: number): Sourced<T> {
  return {
    data,
    provenance: { sourceId: PROVIDER_ID, fetchedAt: Date.now(), dataAsOf, isDemo: false },
  }
}

function badPayload(detail: string): ProviderError {
  return new ProviderError({
    kind: 'schema_mismatch',
    providerId: PROVIDER_ID,
    message: 'football-data payload was structurally valid but semantically unusable',
    detail,
  })
}
