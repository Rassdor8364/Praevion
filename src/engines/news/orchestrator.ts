/**
 * NewsIntelligenceOrchestrator — the impure edge of the Phase-4 news stack.
 *
 * The engines under engines/news/ are pure: normalize, entity extraction,
 * sentiment, clustering and importance all consume plain values plus an
 * explicit `asOf`. Everything they must never touch — the provider registry,
 * the clock, caching, provenance — lives here, mirroring the sports
 * orchestrator:
 *
 *   registry.resolve('news.latest') → normalize (+ per-feed reliability) →
 *   dedup → entities → per-entity sentiment → cluster → importance →
 *   board grouping, all behind a 120s cache with inflight dedup.
 *
 * SUMMARIES ARE EXTRACTIVE. There is no LLM in this deployment (see
 * ./seam.ts): a cluster's "summary" is the lead paragraph of its
 * best-reliability member, labelled as such by the UI ("Cluster of N
 * reports"), never presented as generated analysis.
 */

import { HOUR_MS, isoNow, systemClock, type Clock } from '@/core/clock'
import { err, ok, type Result } from '@/core/result'
import type { ReliabilityClass } from '@/core/prediction/types'
import { getRegistry } from '@/providers'
import type { ProviderRegistry } from '@/providers/registry'
import type { NewsProvider, Provenance } from '@/providers/types'
import { FEEDS } from '@/providers/news/rss'
import {
  clusterArticles,
  type AnalyzedArticle,
  type EntitySentiment,
  type StoryCluster,
} from './cluster'
import { extractEntities, getEntity, type EntityDefinition } from './entities'
import { dedupeArticles, normalizeArticle, type NormalizedArticle } from './normalize'
import { articleSentiment, entitySentiment } from './sentiment'
import { scoreCluster, type ClusterImportance } from './importance'
import type { NewsLanguageModel } from './seam'

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/** Board buckets, mapped from feed categories + entity types (see categoryOf). */
export type BoardCategory = 'markets' | 'crypto' | 'tech' | 'world' | 'sports'

export const BOARD_CATEGORIES: readonly BoardCategory[] = [
  'markets',
  'crypto',
  'tech',
  'world',
  'sports',
]

export interface ScoredCluster {
  readonly cluster: StoryCluster
  readonly importance: ClusterImportance
  readonly category: BoardCategory
  /** Headline of the highest-reliability (earliest among ties) member. */
  readonly headline: string
  /**
   * EXTRACTIVE summary: the headline member's own lead/teaser, verbatim.
   * Not generated, not paraphrased — the UI labels the mechanism honestly.
   */
  readonly extractiveSummary: string | null
  /** The member the headline/summary were extracted from. */
  readonly headlineArticle: NormalizedArticle
}

export interface NewsBoard {
  /** Breaking first (importance desc), then the rest by importance desc. */
  readonly clusters: readonly ScoredCluster[]
  readonly breaking: readonly ScoredCluster[]
  /** Cluster counts per category, for the tab row. */
  readonly categoryCounts: Readonly<Record<BoardCategory, number>>
  readonly articleCount: number
  /** Feeds that failed this refresh — shown, not hidden. */
  readonly provenance: Provenance
  readonly generatedAt: string
}

export interface EntityNews {
  readonly entity: EntityDefinition
  readonly clusters: readonly ScoredCluster[]
  readonly provenance: Provenance
  readonly generatedAt: string
}

// ---------------------------------------------------------------------------
// Cache (same pattern as sports: promise stored before first await → inflight
// dedup; failures evicted immediately so an error is never pinned for the TTL)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  readonly promise: Promise<Result<T, Error>>
  readonly expiresAt: number
}

/** News moves faster than fixtures: 120s trades visible-in-DataFreshness
 *  staleness for not re-fetching ~15 feeds on every render. */
const BOARD_TTL_MS = 120_000

/** How many raw articles to pull per refresh — the full rolling window the
 *  feeds expose, bounded so one misbehaving feed cannot flood the cluster pass. */
const FETCH_LIMIT = 500

let boardCache: CacheEntry<NewsBoard> | null = null

/** Test hook. */
export function resetNewsCaches(): void {
  boardCache = null
}

// ---------------------------------------------------------------------------
// Reliability lookup
// ---------------------------------------------------------------------------

/** Feed id → per-outlet reliability, from the feed definitions. */
const FEED_RELIABILITY: ReadonlyMap<string, ReliabilityClass> = new Map(
  FEEDS.map((f) => [f.id, f.reliability]),
)

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class NewsIntelligenceOrchestrator {
  private readonly registry: ProviderRegistry
  private readonly clock: Clock
  /**
   * THE LLM SEAM (plan §12, ./seam.ts): null in this deployment — no key
   * exists. When an adapter is wired in, it upgrades summaries (abstractive,
   * labelled generated), entity recall and cluster similarity; every
   * deterministic path below remains the fallback.
   */
  private readonly llm: NewsLanguageModel | null

  constructor(deps?: {
    registry?: ProviderRegistry
    clock?: Clock
    llm?: NewsLanguageModel | null
  }) {
    this.registry = deps?.registry ?? getRegistry()
    this.clock = deps?.clock ?? systemClock
    this.llm = deps?.llm ?? null
    void this.llm // reserved for the seam; unused until an adapter ships
  }

  // -- Board -----------------------------------------------------------------

  async getNewsBoard(): Promise<Result<NewsBoard, Error>> {
    const now = this.clock.now()
    if (boardCache !== null && boardCache.expiresAt > now) return boardCache.promise

    const promise = this.assembleBoard()
    boardCache = { promise, expiresAt: now + BOARD_TTL_MS }
    const result = await promise
    if (!result.ok) boardCache = null // never cache a failure
    return result
  }

  /** Clusters mentioning one dictionary entity, importance-sorted. */
  async getEntityNews(entityId: string): Promise<Result<EntityNews, Error>> {
    const entity = getEntity(entityId)
    if (entity === null) {
      return err(new Error(`Unknown entity id "${entityId}" — not in the curated dictionary`))
    }
    const board = await this.getNewsBoard()
    if (!board.ok) return err(board.error)

    return ok({
      entity,
      clusters: board.value.clusters.filter((c) =>
        c.cluster.entities.some((e) => e.entityId === entityId),
      ),
      provenance: board.value.provenance,
      generatedAt: board.value.generatedAt,
    })
  }

  // -- Assembly ---------------------------------------------------------------

  private async assembleBoard(): Promise<Result<NewsBoard, Error>> {
    const fetched = await this.registry.resolve('news.latest', (p) =>
      (p as NewsProvider).getLatestNews({ limit: FETCH_LIMIT }),
    )
    if (!fetched.result.ok) return err(fetched.result.error)

    const { data, provenance } = fetched.result.value

    // Normalize with per-feed reliability; unknown source ids (demo provider,
    // future providers) fall back to the answering provider's own class.
    const providerReliability = this.reliabilityOfProvider(provenance.sourceId)
    const normalized: NormalizedArticle[] = []
    for (const raw of [...data].sort((a, b) => b.publishedAt - a.publishedAt)) {
      const article = normalizeArticle(raw, {
        reliability: FEED_RELIABILITY.get(raw.sourceId) ?? providerReliability,
      })
      if (article !== null) normalized.push(article)
    }
    const deduped = dedupeArticles(normalized)

    // Pure per-article analysis, then pure clustering + scoring.
    const analyzed = deduped.map((a) => analyzeArticle(a))
    const clusters = clusterArticles(analyzed)
    const asOf = this.clock.now()

    const scored: ScoredCluster[] = clusters.map((cluster) => {
      const importance = scoreCluster({
        cluster,
        olderClusters: clusters,
        category: rawCategoryOf(cluster),
        asOf,
      })
      const headlineArticle = pickHeadlineArticle(cluster)
      return {
        cluster,
        importance,
        category: boardCategoryOf(cluster),
        headline: headlineArticle.title,
        extractiveSummary: headlineArticle.summary,
        headlineArticle,
      }
    })

    scored.sort(byBreakingThenImportance)
    const breaking = scored.filter((c) => c.importance.isBreaking)

    const categoryCounts = { markets: 0, crypto: 0, tech: 0, world: 0, sports: 0 } as Record<
      BoardCategory,
      number
    >
    for (const c of scored) categoryCounts[c.category] += 1

    return ok({
      clusters: scored,
      breaking,
      categoryCounts,
      articleCount: deduped.length,
      provenance,
      generatedAt: isoNow(this.clock),
    })
  }

  /** The answering provider's own declared reliability class. */
  private reliabilityOfProvider(providerId: string): ReliabilityClass {
    for (const p of this.registry.chain('news.latest')) {
      if (p.id === providerId) return p.reliability
    }
    return 'UNVERIFIED'
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Run the pure per-article pipeline: entities → per-entity sentiment. */
export function analyzeArticle(article: NormalizedArticle): AnalyzedArticle {
  const text = article.summary === null ? article.title : `${article.title}. ${article.summary}`
  const entities = extractEntities(text)
  const entitySentiments: EntitySentiment[] = entities.map((e) => ({
    entityId: e.entityId,
    mentions: e.count,
    sentiment: entitySentiment({ text, mentionOffsets: e.offsets }),
  }))
  return { article, entities, entitySentiments, articleSentiment: articleSentiment(text) }
}

/** The feed-level category the importance prior consumes ('business' kept). */
function rawCategoryOf(cluster: StoryCluster): string {
  const counts = new Map<string, number>()
  for (const m of cluster.members) {
    const c = m.article.feedCategory ?? 'unknown'
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let best = 'unknown'
  let bestCount = 0
  for (const [c, n] of counts) {
    if (n > bestCount) {
      best = c
      bestCount = n
    }
  }
  return best
}

/**
 * Board bucket: majority feed category, with 'business' folded into markets
 * and entity types breaking ties/unknowns — a cluster of unknown-category
 * members that mentions a crypto asset belongs on the Crypto tab.
 */
export function boardCategoryOf(cluster: StoryCluster): BoardCategory {
  const raw = rawCategoryOf(cluster)
  switch (raw) {
    case 'markets':
    case 'business':
      return 'markets'
    case 'crypto':
      return 'crypto'
    case 'tech':
      return 'tech'
    case 'world':
      return 'world'
    case 'sports':
      return 'sports'
    default: {
      // Entity-type fallback for feeds without a category.
      for (const e of cluster.entities) {
        const definition = getEntity(e.entityId)
        if (definition === null) continue
        if (definition.type === 'asset') return 'crypto'
        if (definition.type === 'league' || definition.type === 'team') return 'sports'
        if (definition.type === 'macro' || definition.type === 'company') return 'markets'
      }
      return 'world'
    }
  }
}

const RELIABILITY_RANK: Readonly<Record<ReliabilityClass, number>> = {
  OFFICIAL: 0,
  PRIMARY_SOURCE: 1,
  HIGH_RELIABILITY: 2,
  ESTABLISHED_MEDIA: 3,
  SECONDARY: 4,
  SOCIAL: 5,
  UNVERIFIED: 6,
}

/** Highest-reliability member; earliest publish among ties — the headline
 *  should come from the most trustworthy outlet's first take. */
export function pickHeadlineArticle(cluster: StoryCluster): NormalizedArticle {
  let best: NormalizedArticle | null = null
  for (const m of cluster.members) {
    if (
      best === null ||
      RELIABILITY_RANK[m.article.reliability] < RELIABILITY_RANK[best.reliability] ||
      (RELIABILITY_RANK[m.article.reliability] === RELIABILITY_RANK[best.reliability] &&
        m.article.publishedAt < best.publishedAt)
    ) {
      best = m.article
    }
  }
  // clusterArticles never emits an empty cluster; this satisfies the type.
  if (best === null) throw new Error('pickHeadlineArticle called with an empty cluster')
  return best
}

function byBreakingThenImportance(a: ScoredCluster, b: ScoredCluster): number {
  if (a.importance.isBreaking !== b.importance.isBreaking) {
    return a.importance.isBreaking ? -1 : 1
  }
  return (
    b.importance.importance - a.importance.importance ||
    b.cluster.latestPublishedAt - a.cluster.latestPublishedAt
  )
}

/** Age label input for the UI: hours since first detection. */
export function hoursSinceFirstDetected(cluster: StoryCluster, nowMs: number): number {
  return Math.max(0, nowMs - cluster.earliestPublishedAt) / HOUR_MS
}

/** Module-level singleton for route handlers and server components. */
let orchestrator: NewsIntelligenceOrchestrator | null = null

export function getNewsOrchestrator(): NewsIntelligenceOrchestrator {
  if (orchestrator === null) orchestrator = new NewsIntelligenceOrchestrator()
  return orchestrator
}
