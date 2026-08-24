/**
 * AnalystOrchestrator — the impure edge of the AI Analyst.
 *
 * Gathers every domain's already-orchestrated output CONCURRENTLY via
 * Promise.allSettled — a failed domain becomes a risk flag inside the
 * briefing, never a crash and never a fabricated section — then hands the
 * projected inputs to the pure composer in ./briefing.ts.
 *
 * Plan §12 note: this is the QUANT side of the AI architecture. The composer
 * is deterministic templates over computed numbers; the LLM seam (phrasing
 * upgrades, cross-domain narrative) attaches later WITHOUT touching any
 * probability — exactly the same pattern as engines/news/seam.ts. No LLM key
 * exists in this deployment and nothing here pretends otherwise.
 *
 * Caching: 120s with inflight dedup (same pattern as the news orchestrator).
 * The PREVIOUS completed briefing is kept in module memory so whatChanged
 * (plan §65 at briefing level) can diff against it; it survives cache expiry
 * but not process restarts — an honest "since" timestamp is attached either
 * way.
 */

import { isoNow, systemClock, type Clock } from '@/core/clock'
import { err, ok, type Result } from '@/core/result'
import { getIntelligenceEngine, type VixeraIntelligenceEngine } from '@/engines/orchestrator'
import { getNewsOrchestrator, type NewsIntelligenceOrchestrator } from '@/engines/news/orchestrator'
import { getSportsOrchestrator, type SportsIntelligenceOrchestrator } from '@/engines/sports/orchestrator'
import {
  composeBriefing,
  whatChanged,
  type AnalystBriefing,
  type BriefingDelta,
  type BriefingInputs,
  type CryptoStateInput,
  type DomainFailure,
  type NewsClusterInput,
  type SportsFixtureInput,
} from './briefing'

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** The majors the pulse reads. Same set as the Command Center market state. */
const SYMBOLS = [
  { pair: 'BTCUSDT', asset: 'BTC' },
  { pair: 'ETHUSDT', asset: 'ETH' },
  { pair: 'SOLUSDT', asset: 'SOL' },
] as const

/** Leagues scanned for watch_next. Bounded: each league dataset is a cached
 *  6h assembly (see sports orchestrator); two leagues keep a cold briefing
 *  under control while covering the flagship European windows. */
const LEAGUES = ['eng.1', 'esp.1'] as const

/** Horizon for the pulse. One timeframe, matching the Command Center read. */
const PULSE_TIMEFRAME = '24h' as const

const BRIEFING_TTL_MS = 120_000

// ---------------------------------------------------------------------------
// Cache + previous-briefing memory
// ---------------------------------------------------------------------------

export interface AnalystReport {
  readonly briefing: AnalystBriefing
  /** Diff vs the previously completed briefing; since=null on the first run. */
  readonly delta: BriefingDelta
}

interface CacheEntry {
  readonly promise: Promise<Result<AnalystBriefing, Error>>
  readonly expiresAt: number
}

let briefingCache: CacheEntry | null = null
let previousBriefing: AnalystBriefing | null = null
let latestBriefing: AnalystBriefing | null = null

/** Test hook. */
export function resetAnalystCaches(): void {
  briefingCache = null
  previousBriefing = null
  latestBriefing = null
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class AnalystOrchestrator {
  private readonly engine: VixeraIntelligenceEngine
  private readonly news: NewsIntelligenceOrchestrator
  private readonly sports: SportsIntelligenceOrchestrator
  private readonly clock: Clock

  constructor(deps?: {
    engine?: VixeraIntelligenceEngine
    news?: NewsIntelligenceOrchestrator
    sports?: SportsIntelligenceOrchestrator
    clock?: Clock
  }) {
    this.engine = deps?.engine ?? getIntelligenceEngine()
    this.news = deps?.news ?? getNewsOrchestrator()
    this.sports = deps?.sports ?? getSportsOrchestrator()
    this.clock = deps?.clock ?? systemClock
  }

  /** The briefing plus its diff against the previous one (120s cache). */
  async getBriefing(): Promise<Result<AnalystReport, Error>> {
    const now = this.clock.now()
    let promise: Promise<Result<AnalystBriefing, Error>>
    if (briefingCache !== null && briefingCache.expiresAt > now) {
      promise = briefingCache.promise
    } else {
      promise = this.assemble()
      briefingCache = { promise, expiresAt: now + BRIEFING_TTL_MS }
    }
    const result = await promise
    if (!result.ok) {
      if (briefingCache !== null && briefingCache.promise === promise) briefingCache = null // never cache a failure
      return err(result.error)
    }
    return ok({
      briefing: result.value,
      delta: whatChanged(
        previousBriefing !== null && previousBriefing.generatedAt !== result.value.generatedAt
          ? previousBriefing
          : null,
        result.value,
      ),
    })
  }

  // -- Assembly ---------------------------------------------------------------

  private async assemble(): Promise<Result<AnalystBriefing, Error>> {
    const failures: DomainFailure[] = []

    // Every domain gathered concurrently; each settles independently.
    const [cryptoSettled, edgeSettled, sportsSettled, newsSettled] = await Promise.all([
      Promise.allSettled(
        SYMBOLS.map((s) => this.engine.predictCryptoAllTimeframes(s.pair, [PULSE_TIMEFRAME])),
      ),
      Promise.allSettled([this.engine.scanMarkets({ limitPerVenue: 50, category: 'crypto' })]),
      Promise.allSettled(LEAGUES.map((id) => this.sports.getLeagueBoard(id, { predictLimit: 12 }))),
      Promise.allSettled([this.news.getNewsBoard()]),
    ])

    // ---- Crypto --------------------------------------------------------------
    const marketState: CryptoStateInput[] = []
    cryptoSettled.forEach((settled, i) => {
      const { pair, asset } = SYMBOLS[i] as (typeof SYMBOLS)[number]
      if (settled.status === 'rejected') {
        failures.push({ domain: 'crypto', message: `${asset}: ${String(settled.reason)}` })
        return
      }
      if (!settled.value.ok) {
        failures.push({ domain: 'crypto', message: `${asset}: ${settled.value.error.message}` })
        return
      }
      const bundle = settled.value.value
      const prediction = bundle.predictions[PULSE_TIMEFRAME]
      if (prediction === undefined) {
        failures.push({ domain: 'crypto', message: `${asset}: no ${PULSE_TIMEFRAME} prediction produced` })
        return
      }
      const up = prediction.outcomes.find((o) => o.key === 'up')
      marketState.push({
        symbol: asset,
        predictionId: pair,
        timeframe: PULSE_TIMEFRAME,
        pUp: up?.probability ?? null,
        confidence: prediction.confidence,
        modelAgreement: prediction.modelAgreement,
        dataQuality: prediction.dataQuality,
        dataMode: prediction.dataMode,
        dataTimestamp: prediction.dataTimestamp,
        spot: bundle.market?.price ?? null,
      })
    })

    // ---- Edge ----------------------------------------------------------------
    let edgeOpportunities: BriefingInputs['edgeOpportunities'] = []
    const edge = edgeSettled[0]
    if (edge === undefined || edge.status === 'rejected') {
      failures.push({ domain: 'edge', message: String(edge?.status === 'rejected' ? edge.reason : 'scan missing') })
    } else if (!edge.value.ok) {
      failures.push({ domain: 'edge', message: edge.value.error.message })
    } else {
      edgeOpportunities = edge.value.value.opportunities
      for (const f of edge.value.value.failures) {
        failures.push({ domain: 'edge', message: `venue: ${f}` })
      }
    }

    // ---- Sports --------------------------------------------------------------
    const sportsFixtures: SportsFixtureInput[] = []
    sportsSettled.forEach((settled, i) => {
      const leagueId = LEAGUES[i] as string
      if (settled.status === 'rejected') {
        failures.push({ domain: 'sports', message: `${leagueId}: ${String(settled.reason)}` })
        return
      }
      if (!settled.value.ok) {
        failures.push({ domain: 'sports', message: `${leagueId}: ${settled.value.error.message}` })
        return
      }
      const board = settled.value.value
      for (const f of board.upcoming) {
        sportsFixtures.push({
          gameId: f.game.externalId,
          league: board.leagueName,
          home: f.game.homeTeamName,
          away: f.game.awayTeamName,
          kickoffMs: f.game.kickoff,
          outcomes: f.prediction.outcomes.map((o) => ({
            key: o.key,
            label: o.label,
            probability: o.probability,
          })),
          confidence: f.prediction.confidence,
          earlySeason: board.earlySeason,
        })
      }
    })

    // ---- News ----------------------------------------------------------------
    const newsClusters: NewsClusterInput[] = []
    const news = newsSettled[0]
    if (news === undefined || news.status === 'rejected') {
      failures.push({ domain: 'news', message: String(news?.status === 'rejected' ? news.reason : 'board missing') })
    } else if (!news.value.ok) {
      failures.push({ domain: 'news', message: news.value.error.message })
    } else {
      for (const c of news.value.value.clusters) {
        newsClusters.push({
          id: c.cluster.id,
          headline: c.headline,
          importance: c.importance.importance,
          isBreaking: c.importance.isBreaking,
          unverified: c.importance.unverified,
          sourceCount: c.cluster.sourceCount,
          entities: c.cluster.entities.map((e) => ({
            entityId: e.entityId,
            mentions: e.mentions,
            sentimentScore: e.sentiment.score,
            sentimentConfidence: e.sentiment.confidence,
          })),
        })
      }
    }

    // A briefing with EVERY domain down is not a briefing — surface the error
    // rather than composing five empty sections around a risk-flag list.
    const anyData =
      marketState.length > 0 ||
      edgeOpportunities.length > 0 ||
      sportsFixtures.length > 0 ||
      newsClusters.length > 0
    if (!anyData) {
      return err(
        new Error(
          `No domain produced data for the briefing: ${failures.map((f) => `${f.domain}: ${f.message}`).join('; ')}`,
        ),
      )
    }

    const briefing = composeBriefing({
      marketState,
      edgeOpportunities,
      sportsFixtures,
      newsClusters,
      failures,
      generatedAt: isoNow(this.clock),
    })

    // Rotate the whatChanged memory: the briefing we are replacing becomes
    // the diff baseline for this one.
    if (latestBriefing !== null && latestBriefing.generatedAt !== briefing.generatedAt) {
      previousBriefing = latestBriefing
    }
    latestBriefing = briefing

    return ok(briefing)
  }
}

/** Module-level singleton for route handlers and server components. */
let orchestrator: AnalystOrchestrator | null = null

export function getAnalystOrchestrator(): AnalystOrchestrator {
  if (orchestrator === null) orchestrator = new AnalystOrchestrator()
  return orchestrator
}
