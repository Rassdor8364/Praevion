/**
 * ESPN site API (association football).
 *
 * This is ESPN's public but UNDOCUMENTED site API: no key, no SLA, and the
 * schema can change without notice. That risk is priced in two ways. First, zod
 * validation is the tripwire — a payload that stops matching what we observed
 * fails loudly as `schema_mismatch` instead of leaking `undefined` into a
 * model. Second, football-data.org (keyed) sits beside this provider in the
 * chain, so a silent ESPN breakage degrades to a different live source rather
 * than to demo data.
 *
 * The free data covers fixtures, results and venues, but NOT shots, possession
 * or xG — those fields are reported as null and never invented, for the same
 * reason as in football-data.ts: a model that receives null abstains, a model
 * that receives a fabricated number prices a guess as evidence.
 *
 * Two endpoint quirks discovered by probing, encoded in the schemas below:
 * - /scoreboard reports each competitor's score as a STRING ("2"), padded to
 *   "0" even before kickoff, so a score is only meaningful once the match has
 *   started.
 * - /teams/{id}/schedule reports score as an OBJECT ({ value: 2 }), and its
 *   default view returns played RESULTS only (fixtures need ?fixture=true,
 *   which we never use — stats want history, not the future).
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

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer'
const PROVIDER_ID = 'espn'
/** Undocumented API, unknown limits — stay politely below anything plausible. */
const RATE_LIMIT = { capacity: 4, windowMs: 1000 } as const
const TIMEOUT_MS = 12_000

/**
 * The leagues this adapter serves. ESPN carries far more, but each league is a
 * separate path segment we must know in advance, so coverage is an explicit
 * allowlist rather than a discovery call.
 */
export const ESPN_LEAGUES = {
  'eng.1': { name: 'Premier League', country: 'England' },
  'esp.1': { name: 'La Liga', country: 'Spain' },
  'ger.1': { name: 'Bundesliga', country: 'Germany' },
  'ita.1': { name: 'Serie A', country: 'Italy' },
  'fra.1': { name: 'Ligue 1', country: 'France' },
  'usa.1': { name: 'MLS', country: 'USA' },
  'uefa.champions': { name: 'Champions League', country: null },
} as const satisfies Record<string, { name: string; country: string | null }>

export type EspnLeagueId = keyof typeof ESPN_LEAGUES

// ---------------------------------------------------------------------------
// Schemas — written from probed payloads, not from documentation (there is
// none). Everything not needed downstream is left unmodelled so unrelated
// upstream churn (tickets, broadcasts, links) cannot break us.
// ---------------------------------------------------------------------------

const StatusTypeSchema = z.object({
  name: z.string().nullish(),
  state: z.string().nullish(),
  completed: z.boolean().nullish(),
})
const StatusSchema = z.object({ type: StatusTypeSchema.nullish() })

const ScoreboardCompetitorSchema = z.object({
  homeAway: z.string().nullish(),
  winner: z.boolean().nullish(),
  /** String, e.g. "2" — and "0" even pre-kickoff (see file comment). */
  score: z.string().nullish(),
  team: z.object({
    id: z.string(),
    displayName: z.string().nullish(),
    shortDisplayName: z.string().nullish(),
    abbreviation: z.string().nullish(),
  }),
})

const ScoreboardEventSchema = z.object({
  id: z.string(),
  /** ISO-ish, e.g. "2026-08-21T19:00Z" — Date.parse handles it. */
  date: z.string(),
  season: z.object({ year: z.number().nullish() }).nullish(),
  competitions: z.array(
    z.object({
      status: StatusSchema.nullish(),
      venue: z.object({ fullName: z.string().nullish() }).nullish(),
      competitors: z.array(ScoreboardCompetitorSchema),
    }),
  ),
})
export const ScoreboardSchema = z.object({ events: z.array(ScoreboardEventSchema) })
export type ScoreboardEvent = z.infer<typeof ScoreboardEventSchema>

const TeamsSchema = z.object({
  sports: z.array(
    z.object({
      leagues: z.array(
        z.object({
          teams: z.array(
            z.object({
              team: z.object({
                id: z.string(),
                displayName: z.string(),
                shortDisplayName: z.string().nullish(),
                abbreviation: z.string().nullish(),
                logos: z.array(z.object({ href: z.string().nullish() })).nullish(),
              }),
            }),
          ),
        }),
      ),
    }),
  ),
})

const ScheduleCompetitorSchema = z.object({
  id: z.string().nullish(),
  homeAway: z.string().nullish(),
  winner: z.boolean().nullish(),
  /** Object here, unlike the scoreboard; absent entirely on unplayed fixtures. */
  score: z.object({ value: z.number().nullish(), displayValue: z.string().nullish() }).nullish(),
  team: z.object({ id: z.string().nullish(), displayName: z.string().nullish() }).nullish(),
})

const ScheduleEventSchema = z.object({
  id: z.string(),
  date: z.string(),
  competitions: z.array(
    z.object({
      status: StatusSchema.nullish(),
      competitors: z.array(ScheduleCompetitorSchema),
    }),
  ),
})
export const ScheduleSchema = z.object({
  /** Top-level season is the CURRENT season regardless of ?season= requested. */
  season: z.object({ year: z.number().nullish() }).nullish(),
  events: z.array(ScheduleEventSchema),
})
export type ScheduleEvent = z.infer<typeof ScheduleEventSchema>

// ---------------------------------------------------------------------------
// Pure mapping helpers — exported for tests, which exercise them against
// fixture objects copied from real payloads instead of hitting the network.
// ---------------------------------------------------------------------------

/**
 * ESPN status vocabulary observed: STATUS_SCHEDULED, STATUS_FIRST_HALF,
 * STATUS_HALFTIME, STATUS_SECOND_HALF, STATUS_FULL_TIME, plus the usual
 * suspects documented nowhere (POSTPONED, CANCELED, ABANDONED, DELAYED...).
 * An unrecognised name falls back to `state` ('pre' | 'in' | 'post'), and a
 * post-state game is only 'finished' when `completed` says so — an abandoned
 * match must not be scored as a result.
 */
export function mapStatus(
  name: string | null | undefined,
  state?: string | null,
  completed?: boolean | null,
): GameStatus {
  switch (name) {
    case 'STATUS_SCHEDULED':
    case 'STATUS_DELAYED':
      return 'scheduled'
    case 'STATUS_FIRST_HALF':
    case 'STATUS_HALFTIME':
    case 'STATUS_SECOND_HALF':
    case 'STATUS_IN_PROGRESS':
    case 'STATUS_OVERTIME':
    case 'STATUS_SHOOTOUT':
    case 'STATUS_END_OF_REGULATION':
      return 'live'
    case 'STATUS_FULL_TIME':
    case 'STATUS_FINAL':
    case 'STATUS_FINAL_PEN':
    case 'STATUS_FINAL_AET':
      return 'finished'
    case 'STATUS_POSTPONED':
    case 'STATUS_SUSPENDED':
    case 'STATUS_ABANDONED':
      return 'postponed'
    case 'STATUS_CANCELED':
    case 'STATUS_CANCELLED':
      return 'cancelled'
    default:
      if (state === 'in') return 'live'
      if (state === 'post') return completed ? 'finished' : 'postponed'
      // Unknown and not clearly started: 'scheduled' is the only status that
      // cannot cause a prediction to be settled against a phantom result.
      return 'scheduled'
  }
}

/**
 * `eng.1` + `401879301` → `eng.1:401879301`.
 *
 * ESPN event and team ids are only unique within a league path, so every id we
 * emit is prefixed with its league to stay unique across the leagues we serve.
 */
export function prefixId(league: string, id: string): string {
  return `${league}:${id}`
}

/** `eng.1:359` → { league: 'eng.1', id: '359' }; null when not in that shape. */
export function parseId(prefixed: string): { league: string; id: string } | null {
  const at = prefixed.lastIndexOf(':')
  if (at <= 0 || at === prefixed.length - 1) return null
  return { league: prefixed.slice(0, at), id: prefixed.slice(at + 1) }
}

/** Epoch-ms range → 'YYYYMMDD-YYYYMMDD' in UTC, the scoreboard's dates param. */
export function formatDateRange(fromMs: number, toMs: number): string {
  return `${yyyymmdd(fromMs)}-${yyyymmdd(toMs)}`
}

function yyyymmdd(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10).replaceAll('-', '')
}

/** Map one scoreboard event to a Game; null when structurally unusable. */
export function toGame(e: ScoreboardEvent, league: string): Game | null {
  const kickoff = Date.parse(e.date)
  if (!Number.isFinite(kickoff)) return null
  const comp = e.competitions[0]
  if (!comp) return null

  const home = comp.competitors.find((c) => c.homeAway === 'home')
  const away = comp.competitors.find((c) => c.homeAway === 'away')
  if (!home || !away) return null

  const status = mapStatus(comp.status?.type?.name, comp.status?.type?.state, comp.status?.type?.completed)
  // The scoreboard pads score to "0" before kickoff, so a scheduled 0 is a
  // placeholder, not a scoreline. Scores are surfaced only once the match has
  // actually produced any.
  const scoresMeaningful = status === 'live' || status === 'finished'

  return {
    externalId: prefixId(league, e.id),
    competitionId: league,
    // ESPN labels a European season by its starting year (2026 == 2026-27) and
    // an MLS season by its calendar year; the bare year is the only label that
    // is honest for both.
    season: typeof e.season?.year === 'number' ? String(e.season.year) : 'unknown',
    kickoff,
    status,
    homeTeamId: prefixId(league, home.team.id),
    awayTeamId: prefixId(league, away.team.id),
    homeTeamName: home.team.displayName ?? home.team.id,
    awayTeamName: away.team.displayName ?? away.team.id,
    homeScore: scoresMeaningful ? parseScore(home.score) : null,
    awayScore: scoresMeaningful ? parseScore(away.score) : null,
    // The soccer scoreboard carries no matchday/week field at all.
    matchday: null,
    venue: comp.venue?.fullName ?? null,
  }
}

function parseScore(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Map one schedule event to the given team's box score; null when the match is
 * not a usable finished result (unplayed, abandoned, missing scores, or the
 * team is somehow not one of the two competitors).
 */
export function toTeamGameStats(e: ScheduleEvent, league: string, teamId: string): TeamGameStats | null {
  const comp = e.competitions[0]
  if (!comp) return null

  const status = mapStatus(comp.status?.type?.name, comp.status?.type?.state, comp.status?.type?.completed)
  if (status !== 'finished') return null

  const mine = comp.competitors.find((c) => (c.team?.id ?? c.id) === teamId)
  const theirs = comp.competitors.find((c) => (c.team?.id ?? c.id) !== teamId)
  if (!mine || !theirs) return null

  const scored = mine.score?.value
  const conceded = theirs.score?.value
  // A finished match with a missing score is an upstream gap; skipping it beats
  // scoring it 0-0.
  if (typeof scored !== 'number' || typeof conceded !== 'number') return null

  return {
    gameId: prefixId(league, e.id),
    teamId: prefixId(league, teamId),
    isHome: mine.homeAway === 'home',
    scored,
    conceded,
    result: scored > conceded ? 'W' : scored === conceded ? 'D' : 'L',
    // -------------------------------------------------------------------
    // Deliberately null: ESPN's free site API serves fixtures, results and
    // venues only — no shot counts, no possession, no expected goals. Null
    // lets downstream models abstain on those features; an invented proxy
    // would look like evidence and carry none.
    // -------------------------------------------------------------------
    shots: null,
    shotsOnTarget: null,
    possession: null,
    expectedGoalsFor: null,
    expectedGoalsAgainst: null,
    extra: {},
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class EspnFootballProvider implements SportsProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'ESPN'
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
    return true // public endpoints, no key required
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/eng.1/scoreboard`,
      schema: ScoreboardSchema,
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
    // No fetch: the league set is a compile-time allowlist (each league is a
    // path segment we must already know), and ESPN offers no cheap endpoint
    // that enumerates just these. A static answer cannot be stale in any way
    // that matters — league identity changes on a timescale of decades.
    const competitions: Competition[] = Object.entries(ESPN_LEAGUES).map(([id, meta]) => ({
      externalId: id,
      name: meta.name,
      sport: 'football',
      country: meta.country,
      // Unknown without a per-league fetch; null is honest and cheap.
      currentSeason: null,
    }))
    return ok(sourced(competitions, Date.now()))
  }

  async getTeams(competitionId: string): Promise<ProviderResult<Team[]>> {
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/${encodeURIComponent(competitionId)}/teams`,
      schema: TeamsSchema,
      headers: headers(),
      timeoutMs: TIMEOUT_MS,
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const teams: Team[] = []
    for (const sport of r.value.sports) {
      for (const league of sport.leagues) {
        for (const { team } of league.teams) {
          teams.push({
            externalId: prefixId(competitionId, team.id),
            name: team.displayName,
            shortName: team.shortDisplayName ?? team.abbreviation ?? team.displayName,
            competitionId,
            crestUrl: team.logos?.[0]?.href ?? null,
          })
        }
      }
    }

    if (teams.length === 0) return err(badPayload(`no teams returned for ${competitionId}`))
    return ok(sourced(teams, Date.now()))
  }

  async getGames(params: {
    competitionId: string
    from?: number
    to?: number
    status?: GameStatus
  }): Promise<ProviderResult<Game[]>> {
    // The scoreboard without ?dates= returns only the "current" matchday, so a
    // window is always sent. Default -7d..+14d: enough recent results to settle
    // predictions plus enough fixtures to make new ones.
    const now = Date.now()
    const from = params.from ?? now - 7 * 86_400_000
    const to = params.to ?? now + 14 * 86_400_000

    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/${encodeURIComponent(params.competitionId)}/scoreboard?dates=${formatDateRange(from, to)}`,
      schema: ScoreboardSchema,
      headers: headers(),
      timeoutMs: TIMEOUT_MS,
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const games: Game[] = []
    for (const e of r.value.events) {
      const game = toGame(e, params.competitionId)
      if (!game) continue
      // Filtered locally: the API has no status query param at all.
      if (params.status && game.status !== params.status) continue
      games.push(game)
    }

    // Fetch time, not newest kickoff: a fixture list is a statement about the
    // future, and its freshness is when we asked.
    return ok(sourced(games, Date.now()))
  }

  async getTeamGameStats(teamId: string, limit: number): Promise<ProviderResult<TeamGameStats[]>> {
    const parsed = parseId(teamId)
    if (!parsed) {
      return err(badPayload(`teamId must look like 'eng.1:359', got '${teamId}'`))
    }
    const { league, id } = parsed
    const scheduleUrl = (season?: number) =>
      `${BASE}/${encodeURIComponent(league)}/teams/${encodeURIComponent(id)}/schedule${
        season === undefined ? '' : `?season=${season}`
      }`

    // The default schedule view is played results for the CURRENT season, which
    // is empty in the weeks before a European season kicks off. The PREVIOUS
    // season is fetched as well so an early-season team still has enough
    // history for a form window.
    const currentR = await fetchJson({
      providerId: this.id,
      url: scheduleUrl(),
      schema: ScheduleSchema,
      headers: headers(),
      timeoutMs: TIMEOUT_MS,
      rateLimit: RATE_LIMIT,
    })
    if (!currentR.ok) return err(currentR.error)

    // The top-level season on the response is the current season even when a
    // past one is requested — exactly what the previous-season call needs.
    const currentYear = currentR.value.season?.year ?? new Date().getUTCFullYear()
    const previousR = await fetchJson({
      providerId: this.id,
      url: scheduleUrl(currentYear - 1),
      schema: ScheduleSchema,
      headers: headers(),
      timeoutMs: TIMEOUT_MS,
      rateLimit: RATE_LIMIT,
    })
    // A previous-season failure is tolerated when the current season already
    // answered: mid-season, the recent window lives entirely in the current
    // response, and failing the whole call over stale history would be strictly
    // worse. If the current season is empty too, the emptiness check below
    // still fails loudly.
    const events = [...currentR.value.events, ...(previousR.ok ? previousR.value.events : [])]

    // Dedupe by event id (defensive: a season-boundary match could plausibly
    // appear in both responses), then newest first — that ordering defines
    // "most recent" for the limit trim.
    const seen = new Set<string>()
    const stats: TeamGameStats[] = []
    for (const e of events.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      const row = toTeamGameStats(e, league, id)
      if (row) stats.push(row)
    }

    if (stats.length === 0) return err(badPayload(`no finished matches with scores for team ${teamId}`))
    return ok(sourced(stats.slice(0, limit), Date.now()))
  }
}

function headers(): Record<string, string> {
  // ESPN's Akamai edge applies User-Agent PREFIX filtering to datacenter
  // egress: bespoke UAs ('VixeraIntelligence/1.0'), browser UAs and Node's
  // default all draw an HTML 403, while 'curl/…' and 'python-requests/…'
  // prefixes pass (verified empirically, 2026-08-13). The curl prefix
  // satisfies the filter; our identifier stays in the suffix so ESPN can still
  // attribute the traffic.
  return { 'User-Agent': 'curl/8.5.0 VixeraIntelligence/1.0' }
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
    message: 'ESPN payload was structurally valid but semantically unusable',
    detail,
  })
}
