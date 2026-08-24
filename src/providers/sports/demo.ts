/**
 * ============================================================================
 * DEMO FOOTBALL PROVIDER — SYNTHETIC FIXTURES AND RESULTS. NOT REAL MATCHES.
 * ============================================================================
 *
 * Six fictional clubs in a fictional league, so the sports engine — form,
 * home advantage, goal expectancy, the whole match model — can be exercised
 * end to end without a football-data.org key.
 *
 * The teams are invented on purpose. Using real club names with fabricated
 * results would produce screenshots that look like genuine predictions about
 * genuine matches, which is exactly the confusion this project must never
 * create.
 *
 * Every payload is stamped `isDemo: true`, which forces `dataMode: 'demo'` on
 * any prediction that touches it and excludes that prediction from ALL accuracy
 * statistics. The registry only registers this provider when VIXERA_ALLOW_DEMO
 * is set — see `demoAllowed()` in registry.ts.
 *
 * Generation is DETERMINISTIC (seeded mulberry32, never Math.random) so the same
 * league table appears on every machine and every run, which is what makes demo
 * output usable in snapshot tests and reproducible in bug reports.
 * ============================================================================
 */

import { ProviderError } from '@/core/errors'
import { err, ok } from '@/core/result'
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

const PROVIDER_ID = 'demo-football'
const COMPETITION_ID = 'DEMO-VL'
const WEEK_MS = 7 * 86_400_000
/** Football matches settle well inside two hours including stoppage. */
const MATCH_DURATION_MS = 2 * 3_600_000

interface DemoTeam {
  readonly id: string
  readonly name: string
  readonly shortName: string
  /** Attack/defence ratings drive goal expectancy; ~1.0 is league average. */
  readonly attack: number
  readonly defence: number
}

/**
 * Ratings are spread deliberately (a clear title favourite, a clear bottom club)
 * so the model's probability outputs vary enough to be visually meaningful in
 * the UI rather than clustering around a flat 33/33/33.
 */
const TEAMS: readonly DemoTeam[] = [
  { id: 'DEMO-T1', name: 'Northgate United', shortName: 'Northgate', attack: 1.55, defence: 0.72 },
  { id: 'DEMO-T2', name: 'Riverton City', shortName: 'Riverton', attack: 1.38, defence: 0.85 },
  { id: 'DEMO-T3', name: 'Ashford Rovers', shortName: 'Ashford', attack: 1.2, defence: 1.0 },
  { id: 'DEMO-T4', name: 'Kingsbridge Athletic', shortName: 'Kingsbridge', attack: 1.05, defence: 1.1 },
  { id: 'DEMO-T5', name: 'Westmoor Wanderers', shortName: 'Westmoor', attack: 0.92, defence: 1.22 },
  { id: 'DEMO-T6', name: 'Elmswood Town', shortName: 'Elmswood', attack: 0.78, defence: 1.4 },
]

/** Roughly the long-run empirical edge in top European leagues. */
const HOME_ADVANTAGE = 1.28

export class DemoFootballProvider implements SportsProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'Demo Football (synthetic)'
  readonly sport = 'football' as const
  readonly reliability = 'UNVERIFIED' as const
  readonly isDemo = true
  readonly capabilities: readonly Capability[] = [
    'sports.competitions',
    'sports.teams',
    'sports.games',
    'sports.teamStats',
  ]

  isConfigured(): boolean {
    return true // nothing to configure; generation is local
  }

  async health(): Promise<ProviderHealth> {
    return { healthy: true, latencyMs: 0, message: 'synthetic provider' }
  }

  async getCompetitions(): Promise<ProviderResult<Competition[]>> {
    const now = Date.now()
    return ok(
      sourced<Competition[]>(
        [
          {
            externalId: COMPETITION_ID,
            name: 'Vixera Demo League',
            sport: 'football',
            country: 'Demoland',
            currentSeason: seasonLabel(seasonStart(now)),
          },
        ],
        now,
      ),
    )
  }

  async getTeams(competitionId: string): Promise<ProviderResult<Team[]>> {
    if (competitionId !== COMPETITION_ID) return err(unknownCompetition(competitionId))
    const teams: Team[] = TEAMS.map((t) => ({
      externalId: t.id,
      name: t.name,
      shortName: t.shortName,
      competitionId: COMPETITION_ID,
      // No crest: a broken image URL is worse than an empty slot, and inventing
      // a logo for a fictional club serves nothing.
      crestUrl: null,
    }))
    return ok(sourced(teams, Date.now()))
  }

  async getGames(params: {
    competitionId: string
    from?: number
    to?: number
    status?: GameStatus
  }): Promise<ProviderResult<Game[]>> {
    if (params.competitionId !== COMPETITION_ID) return err(unknownCompetition(params.competitionId))

    const now = Date.now()
    const games = season(now).filter((g) => {
      if (params.from !== undefined && g.kickoff < params.from) return false
      if (params.to !== undefined && g.kickoff > params.to) return false
      if (params.status !== undefined && g.status !== params.status) return false
      return true
    })
    return ok(sourced(games, now))
  }

  async getTeamGameStats(teamId: string, limit: number): Promise<ProviderResult<TeamGameStats[]>> {
    const team = TEAMS.find((t) => t.id === teamId)
    if (!team) return err(unknownTeam(teamId))

    const now = Date.now()
    const played = season(now).filter(
      (g) =>
        g.status === 'finished' &&
        (g.homeTeamId === teamId || g.awayTeamId === teamId) &&
        g.homeScore !== null &&
        g.awayScore !== null,
    )

    const stats: TeamGameStats[] = []
    for (const g of played) {
      const isHome = g.homeTeamId === teamId
      const scored = (isHome ? g.homeScore : g.awayScore) ?? 0
      const conceded = (isHome ? g.awayScore : g.homeScore) ?? 0
      const rand = mulberry32(hash32(`${g.externalId}|${teamId}|boxscore`))

      // Unlike football-data.org (whose free tier has none of these), the demo
      // DOES populate shots/possession/xG — the point of this provider is to
      // give every downstream feature a live code path to run through. They are
      // generated coherently with the scoreline so an xG-vs-goals panel does not
      // look absurd, but they remain entirely fabricated.
      const shots = 6 + Math.round(rand() * 12) + scored * 2
      const shotsOnTarget = Math.max(scored, Math.round(shots * (0.28 + rand() * 0.18)))
      const possession = Math.round(38 + rand() * 24 + (isHome ? 3 : 0))

      stats.push({
        gameId: g.externalId,
        teamId,
        isHome,
        scored,
        conceded,
        result: scored > conceded ? 'W' : scored === conceded ? 'D' : 'L',
        shots,
        shotsOnTarget,
        possession,
        expectedGoalsFor: round2(shotsOnTarget * (0.28 + rand() * 0.1)),
        expectedGoalsAgainst: round2(conceded * (0.75 + rand() * 0.5)),
        extra: { corners: 2 + Math.round(rand() * 9), fouls: 6 + Math.round(rand() * 10) },
      })
    }

    if (stats.length === 0) {
      return err(
        new ProviderError({
          kind: 'not_found',
          providerId: PROVIDER_ID,
          message: `Demo season has no finished matches yet for ${teamId}`,
        }),
      )
    }

    // Newest last, trimmed from the end — same ordering contract as the live
    // sports adapter so consumers cannot tell them apart structurally.
    return ok(sourced(stats.slice(Math.max(0, stats.length - limit)), Date.now()))
  }
}

// ---------------------------------------------------------------------------
// Deterministic season generation
// ---------------------------------------------------------------------------

/** Cached per season anchor so repeated calls in one request are free and identical. */
let cache: { anchor: number; games: readonly Game[] } | null = null

/**
 * The season is anchored six weeks BEFORE the current week boundary.
 *
 * That places matchdays 1–6 in the past (finished, with results, so the form
 * model has history) and 7–10 in the future (scheduled, so there is something
 * to actually predict). Anchoring to a week boundary rather than to `now` keeps
 * the fixture list stable for seven days at a time instead of sliding every
 * time it is read.
 */
function seasonStart(now: number): number {
  return Math.floor(now / WEEK_MS) * WEEK_MS - 6 * WEEK_MS
}

function season(now: number): readonly Game[] {
  const anchor = seasonStart(now)
  if (cache && cache.anchor === anchor) {
    // Statuses depend on `now`, so they are re-derived even on a cache hit;
    // scores and kickoffs are fixed for the anchor.
    return cache.games.map((g) => withStatus(g, now))
  }
  const games = buildSeason(anchor)
  cache = { anchor, games }
  return games.map((g) => withStatus(g, now))
}

function withStatus(g: Game, now: number): Game {
  const status: GameStatus =
    now >= g.kickoff + MATCH_DURATION_MS ? 'finished' : now >= g.kickoff ? 'live' : 'scheduled'
  // Before kick-off a scoreline does not exist yet; exposing the pre-generated
  // result early would let the demo "predict" a match it has already decided.
  const homeScore = status === 'finished' ? g.homeScore : null
  const awayScore = status === 'finished' ? g.awayScore : null
  return { ...g, status, homeScore, awayScore }
}

/**
 * Double round robin over six clubs: 5 rounds per half × 2 halves = 10
 * matchdays, 3 matches each, 30 fixtures — a complete season.
 *
 * Built with the circle method (one club fixed, the rest rotating), which
 * guarantees every club plays exactly once per matchday.
 */
function buildSeason(anchor: number): readonly Game[] {
  const label = seasonLabel(anchor) ?? 'demo'
  const ids = TEAMS.map((t) => t.id)
  const fixed = ids[0]
  if (fixed === undefined) return []
  const rotating = ids.slice(1)
  const half = ids.length / 2

  const games: Game[] = []
  for (let leg = 0; leg < 2; leg++) {
    for (let round = 0; round < rotating.length; round++) {
      const matchday = leg * rotating.length + round + 1
      // Rotate the non-fixed clubs by `round` positions.
      const order = [fixed, ...rotating.slice(round), ...rotating.slice(0, round)]

      for (let i = 0; i < half; i++) {
        const a = order[i]
        const b = order[order.length - 1 - i]
        if (a === undefined || b === undefined) continue

        // Reverse the venue in the second leg AND on alternating rounds, so no
        // club ends the season with a lopsided home count.
        const flip = leg === 1 ? round % 2 === 0 : round % 2 === 1
        const homeId = flip ? b : a
        const awayId = flip ? a : b

        const home = TEAMS.find((t) => t.id === homeId)
        const away = TEAMS.find((t) => t.id === awayId)
        if (!home || !away) continue

        // Three matches per matchday, staggered across the Saturday.
        const kickoff = anchor + (matchday - 1) * WEEK_MS + 5 * 86_400_000 + (12 + i * 3) * 3_600_000
        const externalId = `demo-${label.replace('/', '-')}-md${String(matchday).padStart(2, '0')}-${homeId}-${awayId}`
        const [homeScore, awayScore] = simulate(home, away, externalId)

        games.push({
          externalId,
          competitionId: COMPETITION_ID,
          season: label,
          kickoff,
          // Overwritten by withStatus against the caller's clock.
          status: 'scheduled',
          homeTeamId: homeId,
          awayTeamId: awayId,
          homeTeamName: home.name,
          awayTeamName: away.name,
          homeScore,
          awayScore,
          matchday,
          venue: `${home.shortName} Park`,
        })
      }
    }
  }

  games.sort((x, y) => x.kickoff - y.kickoff)
  return games
}

/**
 * Independent Poisson goal counts from the two clubs' ratings plus home
 * advantage — the standard Dixon-Coles style skeleton (without the low-score
 * correction, which would be overkill for display data). Real football is close
 * enough to Poisson that the resulting league table looks like a league table.
 */
function simulate(home: DemoTeam, away: DemoTeam, gameId: string): [number, number] {
  const rand = mulberry32(hash32(`${gameId}|score`))
  const homeLambda = home.attack * away.defence * HOME_ADVANTAGE
  const awayLambda = away.attack * home.defence
  return [poisson(homeLambda, rand), poisson(awayLambda, rand)]
}

/** Knuth's inverse-transform sampler. Fine for the small lambdas football produces. */
function poisson(lambda: number, rand: () => number): number {
  const limit = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k++
    p *= rand()
  } while (p > limit && k < 12) // hard cap: a 12-goal demo scoreline helps nobody
  return k - 1
}

/**
 * mulberry32 — 32-bit PRNG, reproducible from an integer seed. Math.random()
 * would give every reload a different league table, which would make the demo
 * useless for snapshot tests and impossible to describe in a bug report.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a string→u32, so each fixture seeds its own independent stream. */
function hash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Epoch ms → '2026/27', matching the live football adapter's season labels. */
function seasonLabel(anchor: number): string | null {
  const year = new Date(anchor).getUTCFullYear()
  if (!Number.isFinite(year)) return null
  return `${year}/${String((year + 1) % 100).padStart(2, '0')}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function sourced<T>(data: T, dataAsOf: number): Sourced<T> {
  return {
    data,
    // isDemo: true is the entire contract of this file.
    provenance: { sourceId: PROVIDER_ID, fetchedAt: Date.now(), dataAsOf, isDemo: true },
  }
}

function unknownCompetition(id: string): ProviderError {
  return new ProviderError({
    kind: 'not_found',
    providerId: PROVIDER_ID,
    message: `Demo provider only serves competition "${COMPETITION_ID}", got "${id}"`,
  })
}

function unknownTeam(id: string): ProviderError {
  return new ProviderError({
    kind: 'not_found',
    providerId: PROVIDER_ID,
    message: `Unknown demo team "${id}"`,
  })
}
