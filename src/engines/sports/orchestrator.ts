/**
 * SportsIntelligenceOrchestrator — the impure edge of the Phase-2 football
 * stack.
 *
 * The engines under engines/sports/ are pure: they consume finished games and
 * an `asOf` instant and return probabilities. Everything they must never touch
 * — the network, the clock, caching, provenance — lives here, mirroring the
 * crypto path in engines/orchestrator.ts:
 *
 *   collect (registry.resolve, provenance recorded) → derive windows →
 *   run predictMatch / vixeraTeamStrength → measure data quality at the
 *   boundary → build the VixeraPrediction via the one sanctioned constructor.
 *
 * Route handlers and the Sports screens call this service and contain no
 * logic of their own. If the provider chain fails, the error is returned and
 * the screen renders "Data unavailable" — never a fabricated fixture.
 */

import { randomUUID } from 'node:crypto'
import { DAY_MS, HOUR_MS, MINUTE_MS, isoNow, systemClock, type Clock } from '@/core/clock'
import { err, ok, type Result } from '@/core/result'
import {
  computeAdaptiveWeights,
  type ModelWeightRationale,
} from '@/core/learning/adaptive-weights'
import { buildPrediction } from '@/core/prediction/builder'
import { computeConfidence } from '@/core/prediction/confidence'
import type {
  ReliabilityClass,
  SourceRef,
  VixeraPrediction,
} from '@/core/prediction/types'
import { computeDataQuality, type DatasetQuality } from '@/core/quality/data-quality'
import { isServiceRoleConfigured } from '@/db/client'
import {
  getModelPerformance,
  getUnsettled,
  listResolvedPredictions,
  recordPredictionHistory,
  savePrediction,
  settleOutcome,
} from '@/db/repositories'
import { getRegistry } from '@/providers'
import { missingCapabilityMarker, type ProviderRegistry } from '@/providers/registry'
import type {
  Capability,
  Game,
  GameOdds,
  OddsProvider,
  Provenance,
  SportsProvider,
  Team,
  TeamGameStats,
} from '@/providers/types'
import { ESPN_LEAGUES } from '@/providers/sports/espn'
import { calibrationReport, type CalibrationReport } from '@/core/metrics/calibration'
import type { WalkForwardResult } from '@/core/learning/walk-forward'
import { deriveBetMarkets, type BetMarkets } from './bet-markets'
import { MODEL_VERSION } from './config/football'
import {
  buildLearnedTrainingSet,
  evaluateLearnedWalkForward,
  LEARNED_MODEL_VERSION,
} from './learned'
import {
  compareWithMarket,
  matchGameToOdds,
  type MatchMarketComparison,
} from './odds-edge'
import { actualKeyFromScore, gameIdFromSubject, leagueOfGameId } from './settlement'
import { eloExpectedScore, fitElo, type EloTable, type FinishedGame } from './elo'
import { formRawComposite, formScore, type FormScoreConfig, type VixeraFormScore } from './form'
import {
  DEFAULT_MATCH_PREDICTION_CONFIG,
  fairOddsFor,
  predictMatch,
  type MatchMarkets,
  type MatchPredictionResult,
} from './match-prediction'
import { vixeraTeamStrength, type StrengthLeagueContext, type VixeraStrengthProfile } from './strength'

// ---------------------------------------------------------------------------
// Freshness policy + dataset shape
// ---------------------------------------------------------------------------

/** How stale each sports dataset may be before quality degrades. Fixture
 *  lists and finished results move on a scale of hours, not seconds. */
const MAX_AGE = {
  'sports.games': 6 * HOUR_MS,
  'sports.teamStats': 12 * HOUR_MS,
} as const

/**
 * How far back the league dataset reaches: the current season PLUS the bulk
 * of the previous one. 420 days covers a full European cycle (previous
 * season kicked off ~12.5 months ago) and most of an MLS calendar season;
 * anything older is worth almost nothing anyway — the Dixon–Coles ξ decay
 * has a ~107-day half-life, so a 14-month-old result carries under 7% of a
 * fresh one's weight.
 */
const DATASET_LOOKBACK_MS = 420 * DAY_MS

/**
 * Dataset cache TTL. Finished results only change on matchdays, and the
 * fitters that consume this dataset care about season-scale structure, so a
 * 6-hour window trades a bounded amount of staleness (visible in the
 * prediction's dataTimestamp — never hidden) for not re-issuing ~14
 * scoreboard requests per league per page view against an unkeyed API with
 * unknown rate limits. The freshness policy above uses the same 6h so the
 * quality score starts degrading exactly when the cache is allowed to.
 */
const DATASET_TTL_MS = 6 * HOUR_MS

/** The assembled finished-games substrate the fitters consume. */
export interface LeagueDataset {
  readonly leagueId: string
  /** Finished games with real scores, kickoff ascending. */
  readonly games: readonly Game[]
  /** teamId → display name, harvested from the same payloads. */
  readonly teamNames: ReadonlyMap<string, string>
  /** Provenance of the underlying fetches (worst-case/oldest values). */
  readonly provenance: Provenance
  /** Fraction of monthly chunks that fetched successfully, 0..1. */
  readonly chunkSuccessRatio: number
  readonly failures: readonly string[]
}

// ---------------------------------------------------------------------------
// Pure derivation helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Month-aligned [from, to) windows covering the range.
 *
 * Probed 2026-08-13: ESPN's /scoreboard?dates=A-B silently CAPS the response
 * at 100 events (a 6-month EPL range returned exactly 100, ending in
 * November) and rejects ranges beyond ~a year with HTTP 400. A single big
 * range would therefore silently truncate the dataset — the worst kind of
 * failure, an incomplete fit that looks complete. Monthly chunks stay far
 * under the cap (a league plays ≤ ~60 games/month) and are merged with
 * dedupe by event id.
 */
export function monthlyChunks(fromMs: number, toMs: number): { from: number; to: number }[] {
  const chunks: { from: number; to: number }[] = []
  let cursor = fromMs
  while (cursor < toMs) {
    const d = new Date(cursor)
    const nextMonthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    const to = Math.min(nextMonthStart, toMs)
    chunks.push({ from: cursor, to })
    cursor = to
  }
  return chunks
}

/** Game[] → the scores-only shape the fitters consume. */
export function toFinishedGames(games: readonly Game[]): FinishedGame[] {
  const out: FinishedGame[] = []
  for (const g of games) {
    if (g.status !== 'finished' || g.homeScore === null || g.awayScore === null) continue
    out.push({
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      kickoff: g.kickoff,
    })
  }
  return out
}

/** One team's box-score window derived from the dataset, most-recent-first,
 *  with real game ids so opponents can be looked up for the form composite. */
export function teamWindow(
  games: readonly Game[],
  teamId: string,
): { stats: TeamGameStats[]; opponentByGameId: Map<string, string> } {
  const involved = games
    .filter(
      (g) =>
        g.status === 'finished' &&
        g.homeScore !== null &&
        g.awayScore !== null &&
        (g.homeTeamId === teamId || g.awayTeamId === teamId),
    )
    .sort((a, b) => b.kickoff - a.kickoff)

  const opponentByGameId = new Map<string, string>()
  const stats = involved.map((g): TeamGameStats => {
    const isHome = g.homeTeamId === teamId
    const scored = (isHome ? g.homeScore : g.awayScore) ?? 0
    const conceded = (isHome ? g.awayScore : g.homeScore) ?? 0
    opponentByGameId.set(g.externalId, isHome ? g.awayTeamId : g.homeTeamId)
    return {
      gameId: g.externalId,
      teamId,
      isHome,
      scored,
      conceded,
      result: scored > conceded ? 'W' : scored === conceded ? 'D' : 'L',
      // Scores-only feeds: these stay null and downstream models abstain on
      // them rather than pricing an invented number as evidence.
      shots: null,
      shotsOnTarget: null,
      possession: null,
      expectedGoalsFor: null,
      expectedGoalsAgainst: null,
      extra: {},
    }
  })
  return { stats, opponentByGameId }
}

/**
 * Epoch ms of a season's start, derived from the DATA: the earliest kickoff
 * (finished or scheduled) carrying that season label. This is what feeds the
 * engine's regime-stability term — early in a season most evidence predates
 * the boundary and confidence is honestly reduced. Falls back to July 1 of
 * the season year (European convention; MLS runs Feb–Dec but a July boundary
 * still splits its season history conservatively).
 */
export function seasonStartOf(
  seasonLabel: string,
  pools: readonly (readonly Game[])[],
): number {
  let earliest = Infinity
  for (const pool of pools) {
    for (const g of pool) {
      if (g.season === seasonLabel && g.kickoff < earliest) earliest = g.kickoff
    }
  }
  if (Number.isFinite(earliest)) return earliest
  const year = Number.parseInt(seasonLabel, 10)
  return Number.isFinite(year) ? Date.UTC(year, 6, 1) : 0
}

/** The season label of the newest game in the pools (by kickoff). */
export function latestSeasonLabel(pools: readonly (readonly Game[])[]): string | null {
  let latest: Game | null = null
  for (const pool of pools) {
    for (const g of pool) {
      if (latest === null || g.kickoff > latest.kickoff) latest = g
    }
  }
  return latest === null ? null : latest.season
}

/**
 * The league-distribution context the percentile-based strength profile is
 * measured against, plus the Elo-derived opponent-quality callback shared
 * with the form engine. Venue-aware: the venuePointsPerGame distribution is
 * the HOME ppg of every league team when `venue` is 'home', away otherwise.
 */
function strengthContext(params: {
  dataset: LeagueDataset
  eloTable: EloTable
  venue: 'home' | 'away'
  formConfig: FormScoreConfig
}): StrengthLeagueContext {
  const { dataset, eloTable, venue } = params
  const teamIds = [...new Set(dataset.games.flatMap((g) => [g.homeTeamId, g.awayTeamId]))]

  const goalsForRates: number[] = []
  const goalsAgainstRates: number[] = []
  const venuePointsPerGame: number[] = []
  const formRaws: number[] = []

  for (const teamId of teamIds) {
    const { stats, opponentByGameId } = teamWindow(dataset.games, teamId)
    if (stats.length === 0) continue
    goalsForRates.push(mean(stats.map((s) => s.scored)))
    goalsAgainstRates.push(mean(stats.map((s) => s.conceded)))
    const atVenue = stats.filter((s) => (venue === 'home' ? s.isHome : !s.isHome))
    if (atVenue.length > 0) {
      venuePointsPerGame.push(
        mean(atVenue.map((s) => (s.result === 'W' ? 3 : s.result === 'D' ? 1 : 0))),
      )
    }
    formRaws.push(
      formRawComposite(stats, opponentStrengthFn(eloTable, opponentByGameId)).raw,
    )
  }

  return { goalsForRates, goalsAgainstRates, venuePointsPerGame, formRaws }
}

/** Opponent quality 0..1 for the form composite: the fitted Elo table's view
 *  of the opponent vs a league-average side at a neutral venue. Unknown or
 *  unrated opponents read exactly 0.5 — "we know nothing" is the median. */
function opponentStrengthFn(
  eloTable: EloTable,
  opponentByGameId: ReadonlyMap<string, string>,
): (gameId: string) => number {
  return (gameId) => {
    const opponentId = opponentByGameId.get(gameId)
    if (opponentId === undefined || !eloTable.isRated(opponentId)) return 0.5
    return eloExpectedScore(eloTable.rating(opponentId), 1500, 0)
  }
}

function mean(values: readonly number[]): number {
  let sum = 0
  for (const v of values) sum += v
  return values.length === 0 ? 0 : sum / values.length
}

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

export interface FixturesPayload {
  readonly leagueId: string
  /** Scheduled/live games in the next 14 days, kickoff ascending. */
  readonly upcoming: readonly Game[]
  /** Finished games from the last 7 days, kickoff descending. */
  readonly results: readonly Game[]
  readonly provenance: Provenance
}

/** One upcoming fixture with its board-level prediction. */
export interface FixturePrediction {
  readonly game: Game
  readonly prediction: VixeraPrediction
  readonly markets: MatchMarkets | null
  readonly fairOdds: Readonly<Record<string, number>>
}

export interface LeagueBoard {
  readonly leagueId: string
  readonly leagueName: string
  readonly upcoming: readonly FixturePrediction[]
  /** Upcoming fixtures beyond the prediction budget, listed without bars. */
  readonly upcomingUnpredicted: readonly Game[]
  readonly results: readonly Game[]
  readonly crests: Readonly<Record<string, string>>
  /** True when the latest season has < 3 finished rounds behind it — the
   *  screens surface that predictions lean on last season's history. */
  readonly earlySeason: boolean
  readonly currentSeasonFinishedGames: number
  readonly provenance: Provenance
}

export interface TeamComparisonSide {
  readonly teamId: string
  readonly name: string
  readonly crestUrl: string | null
  /**
   * Null when the team has NO finished games in the league dataset (a newly
   * promoted side before its first round). Every component would be
   * uncomputable, and per the abstention pattern the profile is absent
   * rather than a fabricated set of 50s.
   */
  readonly strength: VixeraStrengthProfile | null
  readonly form: Pick<VixeraFormScore, 'score' | 'sampleSize' | 'insufficient'>
  readonly elo: { readonly rating: number; readonly games: number; readonly rated: boolean }
}

export interface TeamComparison {
  readonly leagueId: string
  readonly home: TeamComparisonSide
  readonly away: TeamComparisonSide
  /** predictMatch run as a hypothetical fixture (home venue) as of now. */
  readonly hypothetical: {
    readonly outcomes: MatchPredictionResult['outcomes']
    readonly confidence: number
    readonly modelAgreement: number
    readonly markets: MatchMarkets | null
    readonly fairOdds: Readonly<Record<string, number>>
  }
  readonly provenance: Provenance
  readonly generatedAt: string
}

export interface GamePrediction {
  readonly game: Game
  readonly prediction: VixeraPrediction
  /** Dixon–Coles joint-distribution markets — null when the DC model abstained. */
  readonly markets: MatchMarkets | null
  /** The FULL derived market set (totals ladder, DNB, double chance, correct
   *  scores, Asian/European handicaps) — null when the DC model abstained.
   *  All read off the same joint distribution, coherent by construction. */
  readonly betMarkets: BetMarkets | null
  readonly lambdas: MatchPredictionResult['lambdas']
  /** Margin-free decimal odds per pooled outcome. */
  readonly fairOdds: Readonly<Record<string, number>>
  readonly comparison: { readonly home: TeamComparisonSide; readonly away: TeamComparisonSide }
  readonly confidenceBreakdown: MatchPredictionResult['confidenceBreakdown']
  /** Training games available to football.learned for this league. */
  readonly learnedTrainingSamples: number
  /** Measured-performance ensemble weights in force, null before any history. */
  readonly adaptiveWeights: AdaptiveWeightsState | null
  /**
   * Sportsbook comparison. 'unconfigured' = no odds provider key;
   * 'unavailable' = provider errored; 'unmatched' = the fixture could not be
   * matched to an odds event with the required conservatism. Only 'ok'
   * carries numbers — every other status renders its honest empty state.
   */
  readonly marketOdds: {
    readonly status: 'ok' | 'unconfigured' | 'unavailable' | 'unmatched'
    readonly comparison: MatchMarketComparison | null
    readonly detail: string | null
  }
  readonly earlySeason: boolean
  readonly currentSeasonFinishedGames: number
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  readonly promise: Promise<Result<T, Error>>
  readonly expiresAt: number
}

/**
 * Module-level caches with inflight dedup: the PROMISE is stored before the
 * first await, so N concurrent requests for the same league share one
 * assembly instead of stampeding ~14 chunk fetches each. Failed assemblies
 * are evicted immediately (a cached error would pin "Data unavailable" for
 * 6 hours). Module-level rather than per-instance for the same reason the
 * provider registry is memoised: route handlers construct freely, and the
 * cost being amortised is per-process network traffic.
 */
const datasetCache = new Map<string, CacheEntry<LeagueDataset>>()
const teamsCache = new Map<string, CacheEntry<ReadonlyMap<string, Team>>>()
const fixturesCache = new Map<string, CacheEntry<FixturesPayload>>()
const oddsCache = new Map<string, CacheEntry<{ data: GameOdds[]; provenance: Provenance }>>()

/**
 * Odds TTL. The free odds tier is request-budgeted (~500/month), and a
 * minutes-stale price is fine for an ANALYTICAL model-vs-market comparison —
 * the collected-at timestamp is shown wherever the numbers are.
 */
const ODDS_TTL_MS = 15 * MINUTE_MS

/**
 * Fixtures TTL. Short — a fixture list changes when games kick off, finish
 * or get postponed, and DataFreshness shows the age either way — but long
 * enough that the board, the command-center panel and a burst of concurrent
 * page renders share one upstream request instead of tripping the unkeyed
 * provider's rate limits (observed as upstream 503s under bursts).
 */
const FIXTURES_TTL_MS = 60_000

/** Test hook. */
export function resetSportsCaches(): void {
  datasetCache.clear()
  teamsCache.clear()
  fixturesCache.clear()
  oddsCache.clear()
  adaptiveWeightsCache = null
  lastPersistBySubject.clear()
  persistenceStats.saved = 0
  persistenceStats.failed = 0
  persistenceStats.throttled = 0
  persistenceStats.lastError = null
  persistenceStats.lastSavedAt = null
}

// ---------------------------------------------------------------------------
// Prediction persistence + adaptive-weights state
// ---------------------------------------------------------------------------

export interface SportsPersistenceStats {
  readonly saved: number
  readonly failed: number
  readonly throttled: number
  readonly lastError: string | null
  readonly lastSavedAt: string | null
}

/** Process-lifetime counters the health endpoint reports. Honest telemetry:
 *  a persistence path that fails silently would make the learning loop
 *  quietly dead, so every write outcome is counted somewhere visible. */
const persistenceStats = {
  saved: 0,
  failed: 0,
  throttled: 0,
  lastError: null as string | null,
  lastSavedAt: null as string | null,
}

export function getSportsPersistenceStats(): SportsPersistenceStats {
  return { ...persistenceStats }
}

/**
 * Per-subject persistence throttle. Predictions regenerate on every board
 * view, and the natural key includes generated_at — without a throttle each
 * page view would append a near-identical row. One snapshot per subject per
 * interval preserves the probability time-series at a sane density; the
 * pre-kickoff snapshot used for evaluation is whichever row was last
 * persisted before kickoff, which this cadence always provides.
 */
const PERSIST_MIN_INTERVAL_MS = 30 * MINUTE_MS
const lastPersistBySubject = new Map<string, number>()

export interface AdaptiveWeightsState {
  readonly weights: Readonly<Record<string, number>>
  readonly rationale: readonly ModelWeightRationale[]
  readonly totalSettled: number
  readonly computedAt: string
}

const ADAPTIVE_WEIGHTS_TTL_MS = 30 * MINUTE_MS
let adaptiveWeightsCache: {
  promise: Promise<AdaptiveWeightsState | null>
  expiresAt: number
} | null = null

export interface ModelLabReport {
  readonly leagueId: string
  readonly leagueName: string
  /** Finished games in the fitted dataset window. */
  readonly datasetGames: number
  /** Training samples available to football.learned (after cold-start skips). */
  readonly trainingSamples: number
  readonly skippedColdStart: number
  /** Chronological validation of the learned model vs the base-rate
   *  benchmark on identical folds; null when history is too thin. */
  readonly walkForward: {
    readonly learned: WalkForwardResult
    readonly baseRate: WalkForwardResult
  } | null
  /** Measured leaderboard from settled predictions; null before any settle. */
  readonly settledPerformance: {
    readonly totalSettled: number
    readonly ensemble: import('@/db/repositories').ModelScoreRow | null
    readonly perModel: readonly import('@/db/repositories').ModelScoreRow[]
  } | null
  readonly calibration: CalibrationReport | null
  readonly adaptiveWeights: AdaptiveWeightsState | null
  readonly persistence: SportsPersistenceStats
  readonly databaseConfigured: boolean
  readonly modelVersions: Readonly<Record<string, string>>
  readonly provenance: Provenance
  readonly generatedAt: string
}

export interface LearningStatus {
  readonly databaseConfigured: boolean
  readonly persistence: SportsPersistenceStats
  /** Open (unresolved) sports predictions, capped at the 500-row scan. */
  readonly unsettledCount: number | null
  readonly settledTotal: number | null
  readonly ensembleScore: import('@/db/repositories').ModelScoreRow | null
  readonly adaptiveWeights: AdaptiveWeightsState | null
  readonly recentResolved: readonly import('@/db/repositories').ResolvedPredictionRow[] | null
  readonly modelVersions: Readonly<Record<string, string>>
  readonly generatedAt: string
}

export interface SettlementReport {
  /** Unsettled sports predictions inspected. */
  readonly checked: number
  readonly settled: number
  /** Game not finished (or not yet visible in the dataset window). */
  readonly pending: number
  /** Malformed subject, unknown league, or a post-kickoff prediction. */
  readonly skipped: number
  readonly failures: readonly string[]
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class SportsIntelligenceOrchestrator {
  private readonly registry: ProviderRegistry
  private readonly clock: Clock

  constructor(deps?: { registry?: ProviderRegistry; clock?: Clock }) {
    this.registry = deps?.registry ?? getRegistry()
    this.clock = deps?.clock ?? systemClock
  }

  // -- Dataset ---------------------------------------------------------------

  async getLeagueDataset(leagueId: string): Promise<Result<LeagueDataset, Error>> {
    const now = this.clock.now()
    const cached = datasetCache.get(leagueId)
    if (cached !== undefined && cached.expiresAt > now) return cached.promise

    const promise = this.assembleDataset(leagueId)
    datasetCache.set(leagueId, { promise, expiresAt: now + DATASET_TTL_MS })
    const result = await promise
    if (!result.ok) datasetCache.delete(leagueId) // never cache a failure
    return result
  }

  private async assembleDataset(leagueId: string): Promise<Result<LeagueDataset, Error>> {
    const now = this.clock.now()
    const chunks = monthlyChunks(now - DATASET_LOOKBACK_MS, now)

    const failures: string[] = []
    const byId = new Map<string, Game>()
    let providerId: string | null = null
    let oldestFetchedAt = Infinity
    let oldestDataAsOf = Infinity
    let anyDemo = false
    let okChunks = 0

    // Sequential on purpose: the chunks all hit the same unkeyed provider,
    // whose client-side token bucket (4 req/s) would just queue a parallel
    // burst anyway — sequencing keeps this a polite background fill.
    for (const chunk of chunks) {
      const fetched = await this.registry.resolve('sports.games', (p) =>
        (p as SportsProvider).getGames({ competitionId: leagueId, from: chunk.from, to: chunk.to }),
      )
      if (!fetched.result.ok) {
        failures.push(
          `${new Date(chunk.from).toISOString().slice(0, 10)}: ${fetched.result.error.message}`,
        )
        continue
      }
      okChunks += 1
      const { data, provenance } = fetched.result.value
      providerId = providerId ?? provenance.sourceId
      oldestFetchedAt = Math.min(oldestFetchedAt, provenance.fetchedAt)
      oldestDataAsOf = Math.min(oldestDataAsOf, provenance.dataAsOf)
      anyDemo = anyDemo || provenance.isDemo
      for (const g of data) byId.set(g.externalId, g)
    }

    const games = [...byId.values()]
      .filter((g) => g.status === 'finished' && g.homeScore !== null && g.awayScore !== null)
      .sort((a, b) => a.kickoff - b.kickoff)

    if (games.length === 0 || providerId === null) {
      return err(
        new Error(
          `No finished games could be assembled for ${leagueId}: ${
            failures.length > 0 ? failures.join('; ') : 'providers returned empty datasets'
          }`,
        ),
      )
    }

    const teamNames = new Map<string, string>()
    for (const g of byId.values()) {
      teamNames.set(g.homeTeamId, g.homeTeamName)
      teamNames.set(g.awayTeamId, g.awayTeamName)
    }

    return ok({
      leagueId,
      games,
      teamNames,
      provenance: {
        sourceId: providerId,
        fetchedAt: oldestFetchedAt,
        dataAsOf: oldestDataAsOf,
        isDemo: anyDemo,
      },
      chunkSuccessRatio: okChunks / Math.max(1, chunks.length),
      failures,
    })
  }

  // -- Teams / crests --------------------------------------------------------

  async getTeams(leagueId: string): Promise<Result<ReadonlyMap<string, Team>, Error>> {
    const now = this.clock.now()
    const cached = teamsCache.get(leagueId)
    if (cached !== undefined && cached.expiresAt > now) return cached.promise

    const promise = (async (): Promise<Result<ReadonlyMap<string, Team>, Error>> => {
      const fetched = await this.registry.resolve('sports.teams', (p) =>
        (p as SportsProvider).getTeams(leagueId),
      )
      if (!fetched.result.ok) return err(fetched.result.error)
      const map = new Map<string, Team>()
      for (const t of fetched.result.value.data) map.set(t.externalId, t)
      return ok(map)
    })()
    teamsCache.set(leagueId, { promise, expiresAt: now + DATASET_TTL_MS })
    const result = await promise
    if (!result.ok) teamsCache.delete(leagueId)
    return result
  }

  // -- Fixtures --------------------------------------------------------------

  /** Upcoming 14 days plus the last 7 days of results (60s cache, deduped). */
  async getFixtures(leagueId: string): Promise<Result<FixturesPayload, Error>> {
    const now = this.clock.now()
    const cached = fixturesCache.get(leagueId)
    if (cached !== undefined && cached.expiresAt > now) return cached.promise

    const promise = this.fetchFixtures(leagueId)
    fixturesCache.set(leagueId, { promise, expiresAt: now + FIXTURES_TTL_MS })
    const result = await promise
    if (!result.ok) fixturesCache.delete(leagueId) // never cache a failure
    return result
  }

  private async fetchFixtures(leagueId: string): Promise<Result<FixturesPayload, Error>> {
    const now = this.clock.now()
    const fetched = await this.registry.resolve('sports.games', (p) =>
      (p as SportsProvider).getGames({
        competitionId: leagueId,
        from: now - 7 * DAY_MS,
        to: now + 14 * DAY_MS,
      }),
    )
    if (!fetched.result.ok) return err(fetched.result.error)

    const { data, provenance } = fetched.result.value
    const upcoming = data
      .filter((g) => g.status === 'scheduled' || g.status === 'live')
      .sort((a, b) => a.kickoff - b.kickoff)
    const results = data
      .filter((g) => g.status === 'finished')
      .sort((a, b) => b.kickoff - a.kickoff)

    return ok({ leagueId, upcoming, results, provenance })
  }

  // -- Board (list screen + command center) ----------------------------------

  /**
   * Fixtures + per-fixture predictions for the list screens.
   *
   * Board predictions run on the CACHED league dataset alone (both teams'
   * histories are league games, which the dataset already contains), so a
   * board of N fixtures costs one fixtures fetch — not 4·N schedule fetches.
   * The full per-game path (predictGame) additionally fetches each side's own
   * schedule for provenance-measured teamStats; the board's sources honestly
   * omit that capability and its quality score takes the corresponding hit.
   */
  async getLeagueBoard(
    leagueId: string,
    opts?: { predictLimit?: number },
  ): Promise<Result<LeagueBoard, Error>> {
    const predictLimit = opts?.predictLimit ?? 12

    const [fixturesR, datasetR, teamsR] = await Promise.all([
      this.getFixtures(leagueId),
      this.getLeagueDataset(leagueId),
      this.getTeams(leagueId),
    ])
    if (!fixturesR.ok) return err(fixturesR.error)
    if (!datasetR.ok) return err(datasetR.error)

    const fixtures = fixturesR.value
    const dataset = datasetR.value

    // Crests are decoration — a failed teams fetch degrades to no crests
    // rather than failing the board.
    const crests: Record<string, string> = {}
    if (teamsR.ok) {
      for (const [id, team] of teamsR.value) {
        if (team.crestUrl !== null) crests[id] = team.crestUrl
      }
    }

    const season = latestSeasonLabel([fixtures.upcoming, dataset.games])
    const seasonStart =
      season === null ? this.clock.now() : seasonStartOf(season, [fixtures.upcoming, dataset.games])
    const currentSeasonFinishedGames =
      season === null ? 0 : dataset.games.filter((g) => g.season === season).length

    const adaptive = await this.getAdaptiveWeights()

    const toPredict = fixtures.upcoming.filter((g) => g.status === 'scheduled').slice(0, predictLimit)
    const upcoming: FixturePrediction[] = []
    for (const game of toPredict) {
      const p = this.buildFixturePrediction({
        game,
        dataset,
        seasonStart,
        teamStats: null,
        modelWeights: adaptive?.weights ?? null,
      })
      if (p !== null) {
        upcoming.push({ game, prediction: p.prediction, markets: p.markets, fairOdds: p.fairOdds })
      }
    }
    const predictedIds = new Set(upcoming.map((f) => f.game.externalId))

    return ok({
      leagueId,
      leagueName:
        (ESPN_LEAGUES as Record<string, { name: string }>)[leagueId]?.name ?? leagueId,
      upcoming,
      upcomingUnpredicted: fixtures.upcoming.filter((g) => !predictedIds.has(g.externalId)),
      results: fixtures.results,
      crests,
      earlySeason: currentSeasonFinishedGames < 30,
      currentSeasonFinishedGames,
      provenance: fixtures.provenance,
    })
  }

  // -- Full per-game prediction ----------------------------------------------

  async predictGame(gameExternalId: string): Promise<Result<GamePrediction, Error>> {
    const at = gameExternalId.lastIndexOf(':')
    if (at <= 0) {
      return err(new Error(`gameExternalId must look like 'eng.1:401879301', got '${gameExternalId}'`))
    }
    const leagueId = gameExternalId.slice(0, at)

    const [fixturesR, datasetR, teamsR] = await Promise.all([
      this.getFixtures(leagueId),
      this.getLeagueDataset(leagueId),
      this.getTeams(leagueId),
    ])
    if (!fixturesR.ok) return err(fixturesR.error)
    if (!datasetR.ok) return err(datasetR.error)

    const dataset = datasetR.value
    const game =
      fixturesR.value.upcoming.find((g) => g.externalId === gameExternalId) ??
      fixturesR.value.results.find((g) => g.externalId === gameExternalId) ??
      null
    if (game === null) {
      return err(
        new Error(
          `Game ${gameExternalId} is not in the current ${leagueId} window (last 7 days to next 14 days)`,
        ),
      )
    }

    // Both teams' own box scores from the provider. These are fetched for
    // MEASURED provenance (the teamStats capability with its own freshness
    // and field completeness) — the engine's game histories come from the
    // league dataset, which carries the kickoff timestamps the fitters need.
    const [homeStatsR, awayStatsR] = await Promise.all([
      this.registry.resolve('sports.teamStats', (p) =>
        (p as SportsProvider).getTeamGameStats(game.homeTeamId, 40),
      ),
      this.registry.resolve('sports.teamStats', (p) =>
        (p as SportsProvider).getTeamGameStats(game.awayTeamId, 40),
      ),
    ])

    const teamStats =
      homeStatsR.result.ok && awayStatsR.result.ok
        ? {
            home: homeStatsR.result.value,
            away: awayStatsR.result.value,
          }
        : null

    const seasonStart = seasonStartOf(game.season, [fixturesR.value.upcoming, dataset.games])
    const adaptive = await this.getAdaptiveWeights()
    const built = this.buildFixturePrediction({
      game,
      dataset,
      seasonStart,
      teamStats,
      modelWeights: adaptive?.weights ?? null,
    })
    if (built === null) {
      return err(new Error(`Prediction could not be produced for ${gameExternalId}`))
    }

    // §57 comparison sides, venue-aware, from the same dataset.
    const comparison = this.comparisonSides({ dataset, game, teamsR: teamsR.ok ? teamsR.value : null })

    const season = latestSeasonLabel([fixturesR.value.upcoming, dataset.games])
    const currentSeasonFinishedGames =
      season === null ? 0 : dataset.games.filter((g) => g.season === season).length

    return ok({
      game,
      prediction: built.prediction,
      markets: built.markets,
      betMarkets: built.engine.matrix === null ? null : deriveBetMarkets(built.engine.matrix),
      lambdas: built.engine.lambdas,
      fairOdds: built.fairOdds,
      comparison,
      confidenceBreakdown: built.engine.confidenceBreakdown,
      learnedTrainingSamples: built.engine.learnedTrainingSamples,
      adaptiveWeights: adaptive,
      marketOdds: await this.marketOddsFor(leagueId, game, built.prediction),
      earlySeason: currentSeasonFinishedGames < 30,
      currentSeasonFinishedGames,
    })
  }

  // -- Team comparison ---------------------------------------------------------

  async compareTeams(
    leagueId: string,
    homeTeamId: string,
    awayTeamId: string,
  ): Promise<Result<TeamComparison, Error>> {
    const [datasetR, teamsR] = await Promise.all([
      this.getLeagueDataset(leagueId),
      this.getTeams(leagueId),
    ])
    if (!datasetR.ok) return err(datasetR.error)
    const dataset = datasetR.value

    const known = (teamId: string): boolean =>
      dataset.games.some((g) => g.homeTeamId === teamId || g.awayTeamId === teamId)
    if (!known(homeTeamId) || !known(awayTeamId)) {
      const missing = [homeTeamId, awayTeamId].filter((t) => !known(t)).join(', ')
      return err(new Error(`No finished games in the ${leagueId} dataset for: ${missing}`))
    }

    const now = this.clock.now()
    const season = latestSeasonLabel([dataset.games])
    const seasonStart = season === null ? now : seasonStartOf(season, [dataset.games])

    const sides = this.comparisonSides({
      dataset,
      game: {
        homeTeamId,
        awayTeamId,
        homeTeamName: dataset.teamNames.get(homeTeamId) ?? homeTeamId,
        awayTeamName: dataset.teamNames.get(awayTeamId) ?? awayTeamId,
      },
      teamsR: teamsR.ok ? teamsR.value : null,
    })

    const finished = toFinishedGames(dataset.games)
    const engine = predictMatch({
      homeTeamId,
      awayTeamId,
      homeTeamName: sides.home.name,
      awayTeamName: sides.away.name,
      homeGames: finished.filter((g) => g.homeTeamId === homeTeamId || g.awayTeamId === homeTeamId),
      awayGames: finished.filter((g) => g.homeTeamId === awayTeamId || g.awayTeamId === awayTeamId),
      leagueGames: finished,
      asOf: now,
      seasonStart,
    })

    return ok({
      leagueId,
      home: sides.home,
      away: sides.away,
      hypothetical: {
        outcomes: engine.outcomes,
        confidence: engine.confidence,
        modelAgreement: engine.modelAgreement,
        markets: engine.markets,
        fairOdds: fairOddsFor(engine),
      },
      provenance: dataset.provenance,
      generatedAt: isoNow(this.clock),
    })
  }

  // -- Sportsbook odds ---------------------------------------------------------

  /** League odds, cached on the request-budget-friendly TTL. */
  private async getLeagueOdds(
    leagueId: string,
  ): Promise<Result<{ data: GameOdds[]; provenance: Provenance }, Error>> {
    const now = this.clock.now()
    const cached = oddsCache.get(leagueId)
    if (cached !== undefined && cached.expiresAt > now) return cached.promise

    const promise = (async (): Promise<Result<{ data: GameOdds[]; provenance: Provenance }, Error>> => {
      const fetched = await this.registry.resolve('sports.odds', (p) =>
        (p as OddsProvider).getOdds({ competitionId: leagueId }),
      )
      if (!fetched.result.ok) return err(fetched.result.error)
      return ok(fetched.result.value)
    })()
    oddsCache.set(leagueId, { promise, expiresAt: now + ODDS_TTL_MS })
    const result = await promise
    if (!result.ok) oddsCache.delete(leagueId) // never cache a failure
    return result
  }

  /** Build the marketOdds block for one fixture — every failure mode maps to
   *  a named status the UI renders honestly instead of a silent absence. */
  private async marketOddsFor(
    leagueId: string,
    game: Game,
    prediction: VixeraPrediction,
  ): Promise<GamePrediction['marketOdds']> {
    const oddsR = await this.getLeagueOdds(leagueId)
    if (!oddsR.ok) {
      const message = oddsR.error.message
      const unconfigured =
        message.includes('ODDS_API_KEY') || message.includes('No provider registered')
      return {
        status: unconfigured ? 'unconfigured' : 'unavailable',
        comparison: null,
        detail: message,
      }
    }

    const matched = matchGameToOdds(game, oddsR.value.data)
    if (matched === null) {
      return {
        status: 'unmatched',
        comparison: null,
        detail: 'No unambiguous odds event matched this fixture',
      }
    }

    const comparison = compareWithMarket({
      modelOutcomes: prediction.outcomes.map((o) => ({
        key: o.key,
        label: o.label,
        probability: o.probability,
      })),
      odds: matched,
    })
    if (comparison === null) {
      return {
        status: 'unmatched',
        comparison: null,
        detail: 'The matched event carries no complete 1X2 quote',
      }
    }
    return { status: 'ok', comparison, detail: null }
  }

  // -- Adaptive weights (the learning loop's output) --------------------------

  /**
   * Learned ensemble weights from MEASURED settled performance, or null when
   * no database is configured or nothing has settled yet. Null means every
   * model keeps its designed weight — the system without history behaves
   * exactly like the system before this feature existed, which is the
   * correct cold-start posture.
   */
  async getAdaptiveWeights(): Promise<AdaptiveWeightsState | null> {
    if (!isServiceRoleConfigured()) return null
    const now = this.clock.now()
    const cached = adaptiveWeightsCache
    if (cached !== null && cached.expiresAt > now) return cached.promise

    const promise = (async (): Promise<AdaptiveWeightsState | null> => {
      const perf = await getModelPerformance('sports', { limit: 500 })
      if (!perf.ok || perf.value.totalSettled === 0) return null
      const { weights, rationale } = computeAdaptiveWeights(perf.value.perModel)
      return {
        weights,
        rationale,
        totalSettled: perf.value.totalSettled,
        computedAt: isoNow(this.clock),
      }
    })()
    adaptiveWeightsCache = { promise, expiresAt: now + ADAPTIVE_WEIGHTS_TTL_MS }
    const result = await promise
    if (result === null) adaptiveWeightsCache = null // retry next call, not in 30min
    return result
  }

  // -- Prediction persistence --------------------------------------------------

  /**
   * Persist a freshly generated pre-kickoff prediction, fire-and-forget.
   *
   * Deliberately NON-BLOCKING: a slow or absent database must never delay a
   * prediction response — the write happens after the response is on its way
   * and failures land in the stats counter rather than the request path.
   * Only scheduled, pre-kickoff, non-demo predictions are written: §32's
   * lock rule (the evaluated snapshot predates kickoff) is enforced at write
   * time, which is the only place it can be enforced cheaply.
   */
  private maybePersist(game: Game, prediction: VixeraPrediction): void {
    if (!isServiceRoleConfigured()) return
    if (prediction.dataMode === 'demo') return
    if (game.status !== 'scheduled') return
    const now = this.clock.now()
    if (game.kickoff <= now) return

    const last = lastPersistBySubject.get(prediction.subject)
    if (last !== undefined && now - last < PERSIST_MIN_INTERVAL_MS) {
      persistenceStats.throttled += 1
      return
    }
    lastPersistBySubject.set(prediction.subject, now)

    void (async () => {
      const saved = await savePrediction(prediction)
      if (!saved.ok) {
        persistenceStats.failed += 1
        persistenceStats.lastError = saved.error.message
        // Let the next attempt through — the throttle must not pin a failure.
        lastPersistBySubject.delete(prediction.subject)
        return
      }
      persistenceStats.saved += 1
      persistenceStats.lastSavedAt = isoNow(this.clock)

      const history = await recordPredictionHistory(
        prediction.outcomes.map((o) => ({
          predictionId: saved.value.id,
          domain: prediction.domain,
          subject: prediction.subject,
          timeframe: prediction.timeframe,
          outcomeKey: o.key,
          probability: o.probability,
          confidence: prediction.confidence,
          dataQuality: prediction.dataQuality,
          eventType: 'SCHEDULED' as const,
          recordedAt: prediction.generatedAt,
        })),
      )
      if (!history.ok) {
        persistenceStats.lastError = history.error.message
      }
    })().catch((cause) => {
      persistenceStats.failed += 1
      persistenceStats.lastError = cause instanceof Error ? cause.message : String(cause)
    })
  }

  // -- Settlement ---------------------------------------------------------------

  /**
   * Resolve every settleable sports prediction against verified final scores.
   *
   * Idempotent by construction: settleOutcome upserts on prediction_id, and
   * getUnsettled only returns rows without an outcome link, so running this
   * twice converges. Results come from the same provider datasets that feed
   * predictions — fixtures (fresh, last 7 days) first, then the 420-day
   * league dataset for stragglers. A game that is not finished yet simply
   * stays pending; nothing here ever invents a result.
   */
  async settleFinishedGames(): Promise<Result<SettlementReport, Error>> {
    if (!isServiceRoleConfigured()) {
      return err(new Error('Settlement requires the service-role database configuration'))
    }

    const unsettled = await getUnsettled(500, { domain: 'sports' })
    if (!unsettled.ok) return err(unsettled.error)

    const failures: string[] = []
    let settled = 0
    let pending = 0
    let skipped = 0

    // Group by league so each league's game lookup is fetched once.
    const byLeague = new Map<string, { row: (typeof unsettled.value)[number]; gameId: string }[]>()
    for (const row of unsettled.value) {
      const gameId = gameIdFromSubject(row.subject)
      const leagueId = gameId === null ? null : leagueOfGameId(gameId)
      if (gameId === null || leagueId === null || !(leagueId in ESPN_LEAGUES)) {
        skipped += 1
        continue
      }
      const list = byLeague.get(leagueId) ?? []
      list.push({ row, gameId })
      byLeague.set(leagueId, list)
    }

    for (const [leagueId, entries] of byLeague) {
      // Fresh results first, long dataset as fallback for older games.
      const gamesById = new Map<string, Game>()
      const datasetR = await this.getLeagueDataset(leagueId)
      if (datasetR.ok) {
        for (const g of datasetR.value.games) gamesById.set(g.externalId, g)
      }
      const fixturesR = await this.getFixtures(leagueId)
      if (fixturesR.ok) {
        for (const g of fixturesR.value.results) gamesById.set(g.externalId, g)
      }
      if (!datasetR.ok && !fixturesR.ok) {
        failures.push(`${leagueId}: ${datasetR.ok ? '' : datasetR.error.message}`)
        pending += entries.length
        continue
      }

      for (const { row, gameId } of entries) {
        const game = gamesById.get(gameId)
        if (
          game === undefined ||
          game.status !== 'finished' ||
          game.homeScore === null ||
          game.awayScore === null
        ) {
          pending += 1
          continue
        }
        // The lock rule, re-checked at settlement: a prediction generated
        // after kickoff is not a forecast and must never enter the accuracy
        // record. The persist guard should make this unreachable; if it ever
        // fires, skipping is the honest response.
        if (Date.parse(row.generated_at) > game.kickoff) {
          skipped += 1
          continue
        }
        const key = actualKeyFromScore(game.homeScore, game.awayScore)
        const outcome = await settleOutcome(row.id, key, {
          settledBy: 'sports_settlement',
          evidence: {
            gameExternalId: gameId,
            homeScore: game.homeScore,
            awayScore: game.awayScore,
            kickoff: new Date(game.kickoff).toISOString(),
          },
        })
        if (outcome.ok) settled += 1
        else failures.push(`${gameId}: ${outcome.error.message}`)
      }
    }

    // Fresh results settled → the learned weights are stale by definition.
    if (settled > 0) adaptiveWeightsCache = null

    return ok({ checked: unsettled.value.length, settled, pending, skipped, failures })
  }

  // -- Model Lab ---------------------------------------------------------------

  /**
   * Everything the Model Lab shows, computed from real data at request time:
   * walk-forward validation of the learned model on the league's own history
   * (against a base-rate benchmark on identical folds), plus — when a
   * database is configured and predictions have settled — the measured
   * per-model leaderboard, calibration report and the adaptive weights in
   * force. Sections that lack their data return null with the reason, and
   * the UI renders the honest empty state.
   */
  async getModelLabReport(leagueId: string): Promise<Result<ModelLabReport, Error>> {
    const datasetR = await this.getLeagueDataset(leagueId)
    if (!datasetR.ok) return err(datasetR.error)
    const dataset = datasetR.value
    const now = this.clock.now()

    const finished = toFinishedGames(dataset.games)
    const trainingSet = buildLearnedTrainingSet(finished, now)
    const walkForward = evaluateLearnedWalkForward(trainingSet.samples)

    let settledPerformance: ModelLabReport['settledPerformance'] = null
    let calibration: ModelLabReport['calibration'] = null
    if (isServiceRoleConfigured()) {
      const perf = await getModelPerformance('sports', { limit: 500 })
      if (perf.ok && perf.value.totalSettled > 0) {
        settledPerformance = {
          totalSettled: perf.value.totalSettled,
          ensemble: perf.value.ensemble,
          perModel: perf.value.perModel,
        }
        calibration = calibrationReport(perf.value.calibration)
      }
    }

    const adaptive = await this.getAdaptiveWeights()

    return ok({
      leagueId,
      leagueName:
        (ESPN_LEAGUES as Record<string, { name: string }>)[leagueId]?.name ?? leagueId,
      datasetGames: dataset.games.length,
      trainingSamples: trainingSet.samples.length,
      skippedColdStart: trainingSet.skippedColdStart,
      walkForward,
      settledPerformance,
      calibration,
      adaptiveWeights: adaptive,
      persistence: getSportsPersistenceStats(),
      databaseConfigured: isServiceRoleConfigured(),
      modelVersions: {
        ensemble: MODEL_VERSION,
        learned: LEARNED_MODEL_VERSION,
      },
      provenance: dataset.provenance,
      generatedAt: isoNow(this.clock),
    })
  }

  // -- Learning status -----------------------------------------------------------

  /**
   * The live state of the learning loop for the Learning dashboard. Every
   * numeric field is measured; fields whose backing store is not configured
   * come back null and the UI says so instead of showing a zero that would
   * read as "we checked and there is nothing".
   */
  async getLearningStatus(): Promise<LearningStatus> {
    const configured = isServiceRoleConfigured()
    if (!configured) {
      return {
        databaseConfigured: false,
        persistence: getSportsPersistenceStats(),
        unsettledCount: null,
        settledTotal: null,
        ensembleScore: null,
        adaptiveWeights: null,
        recentResolved: null,
        modelVersions: { ensemble: MODEL_VERSION, learned: LEARNED_MODEL_VERSION },
        generatedAt: isoNow(this.clock),
      }
    }

    const [unsettled, performance, resolved, adaptive] = await Promise.all([
      getUnsettled(500, { domain: 'sports' }),
      getModelPerformance('sports', { limit: 500 }),
      listResolvedPredictions('sports', { limit: 10 }),
      this.getAdaptiveWeights(),
    ])

    return {
      databaseConfigured: true,
      persistence: getSportsPersistenceStats(),
      unsettledCount: unsettled.ok ? unsettled.value.length : null,
      settledTotal: performance.ok ? performance.value.totalSettled : null,
      ensembleScore: performance.ok ? performance.value.ensemble : null,
      adaptiveWeights: adaptive,
      recentResolved: resolved.ok ? resolved.value : null,
      modelVersions: { ensemble: MODEL_VERSION, learned: LEARNED_MODEL_VERSION },
      generatedAt: isoNow(this.clock),
    }
  }

  // -- Internals ---------------------------------------------------------------

  /**
   * Run the pure engine for one fixture and wrap the result into a
   * VixeraPrediction with boundary-measured provenance.
   *
   * Data quality is the MINIMUM of two independent lenses: the engine's own
   * feature-sufficiency score (does the maths have enough games/signals) and
   * the provenance score from computeDataQuality (was the data fresh, from a
   * reliable source, covering the expected capabilities). A prediction's
   * quality is no better than its weakest lens — taking a mean would let
   * fresh provenance launder a starved feature set, and vice versa.
   * Confidence is then recomputed from the engine's own audited inputs with
   * the combined quality substituted in.
   */
  private buildFixturePrediction(params: {
    game: Game
    dataset: LeagueDataset
    seasonStart: number
    teamStats: {
      home: { data: TeamGameStats[]; provenance: Provenance }
      away: { data: TeamGameStats[]; provenance: Provenance }
    } | null
    /** Learned ensemble weights from settled performance; null = designed weights. */
    modelWeights?: Readonly<Record<string, number>> | null
  }): { prediction: VixeraPrediction; engine: MatchPredictionResult; markets: MatchMarkets | null; fairOdds: Readonly<Record<string, number>> } | null {
    const { game, dataset, seasonStart, teamStats } = params
    const now = this.clock.now()
    const finished = toFinishedGames(dataset.games)

    let engine: MatchPredictionResult
    try {
      engine = predictMatch({
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId,
        homeTeamName: game.homeTeamName,
        awayTeamName: game.awayTeamName,
        homeGames: finished.filter(
          (g) => g.homeTeamId === game.homeTeamId || g.awayTeamId === game.homeTeamId,
        ),
        awayGames: finished.filter(
          (g) => g.homeTeamId === game.awayTeamId || g.awayTeamId === game.awayTeamId,
        ),
        leagueGames: finished,
        asOf: now,
        seasonStart,
        ...(params.modelWeights != null ? { config: { modelWeights: params.modelWeights } } : {}),
      })
    } catch {
      // A structural engine failure (not an abstention — those are handled
      // inside) means this fixture gets NO row rather than a fabricated one.
      return null
    }

    // --- Boundary-measured data quality -----------------------------------
    const nowIso = isoNow(this.clock)
    const gamesReliability = this.reliabilityOf(dataset.provenance.sourceId)
    const datasets: DatasetQuality[] = [
      {
        capability: 'sports.games',
        dataAsOf: new Date(dataset.provenance.dataAsOf).toISOString(),
        maxAgeMs: MAX_AGE['sports.games'],
        completeness: dataset.chunkSuccessRatio,
        sourceCount: 1,
        reliability: gamesReliability,
        disagreement: null,
        isDemo: dataset.provenance.isDemo,
      },
    ]
    const sources: SourceRef[] = [
      {
        providerId: dataset.provenance.sourceId,
        capability: 'sports.games',
        reliability: gamesReliability,
        fetchedAt: new Date(dataset.provenance.fetchedAt).toISOString(),
        dataAsOf: new Date(dataset.provenance.dataAsOf).toISOString(),
        isDemo: dataset.provenance.isDemo,
      },
    ]

    if (teamStats !== null) {
      const rows = [...teamStats.home.data, ...teamStats.away.data]
      const statsProvenance = teamStats.home.provenance
      const statsReliability = this.reliabilityOf(statsProvenance.sourceId)
      const oldestAsOf = Math.min(teamStats.home.provenance.dataAsOf, teamStats.away.provenance.dataAsOf)
      datasets.push({
        capability: 'sports.teamStats',
        dataAsOf: new Date(oldestAsOf).toISOString(),
        maxAgeMs: MAX_AGE['sports.teamStats'],
        // Measured, not asserted: fraction of the optional box-score fields
        // (shots, on-target, possession, xG for/against) actually populated.
        // Scores-only feeds land at the 0.5 floor the mandatory fields earn.
        completeness: boxScoreCompleteness(rows),
        sourceCount: 1,
        reliability: statsReliability,
        disagreement: null,
        isDemo: statsProvenance.isDemo || teamStats.away.provenance.isDemo,
      })
      for (const side of [teamStats.home, teamStats.away]) {
        sources.push({
          providerId: side.provenance.sourceId,
          capability: 'sports.teamStats',
          reliability: this.reliabilityOf(side.provenance.sourceId),
          fetchedAt: new Date(side.provenance.fetchedAt).toISOString(),
          dataAsOf: new Date(side.provenance.dataAsOf).toISOString(),
          isDemo: side.provenance.isDemo,
        })
      }
    }

    // Injuries and lineups are EXPECTED inputs of a football prediction and
    // no provider supplies them (teamStats too, on the dataset-only board
    // path). Each absent capability is recorded as a missing-capability
    // sentinel so deriveDataMode reads 'partial' and the quality score takes
    // the coverage hit — the honest alternative to quietly shrinking the
    // denominator until the data we happen to have looks complete.
    const expected = ['sports.games', 'sports.teamStats', 'sports.injuries', 'sports.lineups']
    const present = new Set(datasets.map((d) => d.capability))
    for (const capability of expected) {
      if (present.has(capability)) continue
      sources.push({
        providerId: 'none',
        capability: missingCapabilityMarker(capability as Capability),
        reliability: 'UNVERIFIED',
        fetchedAt: nowIso,
        dataAsOf: nowIso,
        isDemo: false,
      })
    }

    const provenanceQuality = computeDataQuality({
      datasets,
      expectedCapabilities: expected,
      clock: this.clock,
    })
    const dataQuality = Math.min(provenanceQuality.score, engine.dataQuality)
    const confidence = computeConfidence({ ...engine.confidenceInputs, dataQuality }).confidence

    const prediction = buildPrediction({
      id: randomUUID(),
      domain: 'sports',
      subject: `game:${game.externalId}`,
      subjectLabel: `${game.homeTeamName} vs ${game.awayTeamName}`,
      timeframe: 'event',
      outcomes: engine.outcomes,
      confidence,
      dataQuality,
      modelAgreement: engine.modelAgreement,
      factors: engine.factors,
      modelOutputs: engine.modelOutputs,
      sources,
      scenarios: null,
      volatility: null,
      modelVersion: engine.modelVersion,
      clock: this.clock,
    })

    // The learning loop's first half: remember the forecast (pre-kickoff,
    // non-demo, throttled — see maybePersist) so settlement can score it.
    this.maybePersist(game, prediction)

    return { prediction, engine, markets: engine.markets, fairOdds: fairOddsFor(engine) }
  }

  private comparisonSides(params: {
    dataset: LeagueDataset
    game: Pick<Game, 'homeTeamId' | 'awayTeamId' | 'homeTeamName' | 'awayTeamName'>
    teamsR: ReadonlyMap<string, Team> | null
  }): { home: TeamComparisonSide; away: TeamComparisonSide } {
    const { dataset, game, teamsR } = params
    const now = this.clock.now()
    const finished = toFinishedGames(dataset.games)
    const eloTable = fitElo(finished)

    const side = (teamId: string, name: string, venue: 'home' | 'away'): TeamComparisonSide => {
      const { stats, opponentByGameId } = teamWindow(dataset.games, teamId)
      const opponentStrength = opponentStrengthFn(eloTable, opponentByGameId)
      // Same §9 weights + decay the match engine uses, so the compare screen
      // and the prediction quote the same form number for the same team.
      const formConfig: FormScoreConfig = {
        weights: {
          resultPoints: 0.4,
          normalizedGoalDiff: 0.25,
          opponentStrength: 0.2,
          performanceVsExpected: 0.15,
        },
        decayLambda: DEFAULT_MATCH_PREDICTION_CONFIG.formDecayLambda,
        minGames: DEFAULT_MATCH_PREDICTION_CONFIG.minGames,
        leagueRaws: [],
      }
      const league = strengthContext({ dataset, eloTable, venue, formConfig })
      // Zero league history means zero computable components — the profile
      // is null (see TeamComparisonSide), not a row of invented medians.
      const strength =
        stats.length === 0
          ? null
          : vixeraTeamStrength({
              teamGames: stats,
              opponentStrength,
              venue,
              league,
              asOf: now,
            })
      const form = formScore(
        stats,
        opponentStrength,
        { ...formConfig, leagueRaws: league.formRaws },
        now,
      )
      return {
        teamId,
        name,
        crestUrl: teamsR?.get(teamId)?.crestUrl ?? null,
        strength,
        form: { score: form.score, sampleSize: form.sampleSize, insufficient: form.insufficient },
        elo: {
          rating: eloTable.rating(teamId),
          games: eloTable.gamesRated(teamId),
          rated: eloTable.isRated(teamId),
        },
      }
    }

    return {
      home: side(game.homeTeamId, game.homeTeamName, 'home'),
      away: side(game.awayTeamId, game.awayTeamName, 'away'),
    }
  }

  /** The provider's own declared reliability class, looked up by id. */
  private reliabilityOf(providerId: string): ReliabilityClass {
    for (const capability of ['sports.games', 'sports.teamStats', 'sports.teams'] as const) {
      for (const p of this.registry.chain(capability)) {
        if (p.id === providerId) return p.reliability
      }
    }
    return 'UNVERIFIED'
  }
}

/** Fraction of optional box-score fields populated across the rows, on top of
 *  a 0.5 floor for the always-present score/result fields. */
export function boxScoreCompleteness(rows: readonly TeamGameStats[]): number {
  if (rows.length === 0) return 0
  let populated = 0
  let total = 0
  for (const r of rows) {
    const optional = [r.shots, r.shotsOnTarget, r.possession, r.expectedGoalsFor, r.expectedGoalsAgainst]
    total += optional.length
    populated += optional.filter((v) => v !== null).length
  }
  return 0.5 + 0.5 * (total === 0 ? 0 : populated / total)
}

/** Module-level singleton for route handlers and server components. */
let orchestrator: SportsIntelligenceOrchestrator | null = null

export function getSportsOrchestrator(): SportsIntelligenceOrchestrator {
  if (orchestrator === null) orchestrator = new SportsIntelligenceOrchestrator()
  return orchestrator
}

export { ESPN_LEAGUES, MODEL_VERSION }
