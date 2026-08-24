/**
 * Story clustering WITHOUT embeddings.
 *
 * Twelve outlets covering the same Fed decision must collapse into ONE story
 * whose independent-source count is a credibility input (plan §11) — not
 * twelve separate "important events". With no embedding model available
 * (see ./seam.ts), similarity is TF-IDF-weighted token cosine: IDF is computed
 * over the current article window, so a token like "bitcoin" that appears in
 * a third of the crypto feed carries little weight while "halving" carries a
 * lot. Paraphrase recall is worse than embeddings would give — two rewordings
 * with disjoint vocabulary will not merge — and that is an accepted, stated
 * limitation until the seam is filled.
 *
 * The whole window is re-clustered per refresh. At our volumes (≤ ~500
 * articles per 48h window) that is a few million cosine terms — microseconds,
 * not a scaling problem. The incremental upgrade path, should volume ever
 * demand it: persist cluster centroids + the IDF table, assign only NEW
 * articles against existing centroids, and rebuild fully on a slow cadence to
 * heal drift. The pure-function contract here (articles in → clusters out)
 * is exactly what makes that swap invisible to callers.
 *
 * Pure: no I/O, no Date.now — time enters only through article timestamps.
 */

import { HOUR_MS } from '@/core/clock'
import type { ReliabilityClass } from '@/core/prediction/types'
import type { EntityMatch } from './entities'
import type { NormalizedArticle } from './normalize'
import type { SentimentResult } from './sentiment'
import { confidenceFor } from './sentiment'
import { stableHash } from './normalize'

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/** Per-entity sentiment attached to one article. */
export interface EntitySentiment {
  readonly entityId: string
  readonly mentions: number
  readonly sentiment: SentimentResult
}

/** An article with its per-article analysis attached (by the orchestrator). */
export interface AnalyzedArticle {
  readonly article: NormalizedArticle
  readonly entities: readonly EntityMatch[]
  readonly entitySentiments: readonly EntitySentiment[]
  readonly articleSentiment: SentimentResult
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface ClusterEntity {
  readonly entityId: string
  /** Total mentions across all member articles. */
  readonly mentions: number
  /** Hit-weighted mean of the members' entity sentiments; NO_SENTIMENT-like
   *  zero-confidence result when no member had lexicon hits near the entity. */
  readonly sentiment: SentimentResult
}

export interface StoryCluster {
  /** Stable across refreshes while the earliest member stays the same. */
  readonly id: string
  /** Members, publishedAt ascending — members[0] is the first detection. */
  readonly members: readonly AnalyzedArticle[]
  /** DISTINCT source ids — five CoinDesk copies count once. */
  readonly sourceIds: readonly string[]
  readonly sourceCount: number
  readonly earliestPublishedAt: number
  readonly latestPublishedAt: number
  /** Highest reliability class present among members. */
  readonly bestReliability: ReliabilityClass
  /** Member count per reliability class. */
  readonly reliabilityMix: Readonly<Partial<Record<ReliabilityClass, number>>>
  /** Merged entities, most-mentioned first. */
  readonly entities: readonly ClusterEntity[]
  /** TF-IDF centroid (mean member vector, L2-normalized) — kept on the
   *  cluster so the importance scorer can measure novelty between clusters. */
  readonly centroid: ReadonlyMap<string, number>
}

export interface ClusterConfig {
  /** Cosine similarity required to join a cluster. Tuned on live feed data
   *  2026-08-13: 0.45 merges syndicated rewrites of one story while keeping
   *  same-beat-different-story articles ("Bitcoin rises" vs "Bitcoin ETF
   *  ruling") apart. */
  readonly similarityThreshold: number
  /** Max |publishedAt − cluster centroid time| for membership. Two takes on
   *  one event land within hours; a 48h gate stops a slow-burn topic from
   *  chaining into one endless mega-cluster. */
  readonly maxGapMs: number
}

export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  similarityThreshold: 0.45,
  maxGapMs: 48 * HOUR_MS,
}

// ---------------------------------------------------------------------------
// TF-IDF machinery (exported for tests)
// ---------------------------------------------------------------------------

/** token → smoothed IDF over the article window: ln((N+1)/(df+1)) + 1. */
export function computeIdf(articles: readonly { tokens: readonly string[] }[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const a of articles) {
    for (const token of new Set(a.tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }
  const n = articles.length
  const idf = new Map<string, number>()
  for (const [token, count] of df) {
    idf.set(token, Math.log((n + 1) / (count + 1)) + 1)
  }
  return idf
}

/** L2-normalized tf·idf vector for one article. */
export function tfidfVector(
  tokens: readonly string[],
  idf: ReadonlyMap<string, number>,
): Map<string, number> {
  const tf = new Map<string, number>()
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)

  const vec = new Map<string, number>()
  let normSq = 0
  for (const [token, count] of tf) {
    const weight = count * (idf.get(token) ?? 1)
    vec.set(token, weight)
    normSq += weight * weight
  }
  if (normSq > 0) {
    const norm = Math.sqrt(normSq)
    for (const [token, weight] of vec) vec.set(token, weight / norm)
  }
  return vec
}

/** Cosine similarity of two L2-normalized sparse vectors (= dot product). */
export function cosineSimilarity(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): number {
  // Iterate the smaller map.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let dot = 0
  for (const [token, weight] of small) {
    const other = large.get(token)
    if (other !== undefined) dot += weight * other
  }
  return dot
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

interface MutableCluster {
  members: AnalyzedArticle[]
  /** Sum (not yet normalized) of member vectors. */
  vectorSum: Map<string, number>
  /** Mean publishedAt of members — the temporal centroid. */
  publishedSum: number
}

/**
 * Greedy incremental agglomeration over the window: articles are processed
 * oldest-first, each joining the most-similar existing cluster that passes
 * both gates (cosine ≥ threshold AND within maxGapMs of the cluster's mean
 * publish time), or founding a new cluster. Oldest-first makes the pass
 * deterministic and means a cluster's identity anchors on the story's first
 * report, which is also what "first detected" should mean.
 */
export function clusterArticles(
  articles: readonly AnalyzedArticle[],
  config: ClusterConfig = DEFAULT_CLUSTER_CONFIG,
): StoryCluster[] {
  const ordered = [...articles].sort(
    (a, b) => a.article.publishedAt - b.article.publishedAt || (a.article.id < b.article.id ? -1 : 1),
  )
  const idf = computeIdf(ordered.map((a) => a.article))
  const vectors = new Map<string, Map<string, number>>()
  for (const a of ordered) vectors.set(a.article.id, tfidfVector(a.article.tokens, idf))

  const clusters: MutableCluster[] = []

  for (const a of ordered) {
    const vec = vectors.get(a.article.id)
    if (vec === undefined) continue

    let best: MutableCluster | null = null
    let bestSim = 0
    for (const c of clusters) {
      const centroidTime = c.publishedSum / c.members.length
      if (Math.abs(a.article.publishedAt - centroidTime) > config.maxGapMs) continue
      const sim = cosineSimilarity(vec, normalized(c.vectorSum))
      if (sim >= config.similarityThreshold && sim > bestSim) {
        best = c
        bestSim = sim
      }
    }

    if (best !== null) {
      best.members.push(a)
      best.publishedSum += a.article.publishedAt
      for (const [token, weight] of vec) {
        best.vectorSum.set(token, (best.vectorSum.get(token) ?? 0) + weight)
      }
    } else {
      clusters.push({
        members: [a],
        vectorSum: new Map(vec),
        publishedSum: a.article.publishedAt,
      })
    }
  }

  return clusters.map(finalizeCluster)
}

function normalized(vec: ReadonlyMap<string, number>): Map<string, number> {
  let normSq = 0
  for (const w of vec.values()) normSq += w * w
  const out = new Map<string, number>()
  if (normSq === 0) return out
  const norm = Math.sqrt(normSq)
  for (const [token, w] of vec) out.set(token, w / norm)
  return out
}

const RELIABILITY_ORDER: readonly ReliabilityClass[] = [
  'OFFICIAL',
  'PRIMARY_SOURCE',
  'HIGH_RELIABILITY',
  'ESTABLISHED_MEDIA',
  'SECONDARY',
  'SOCIAL',
  'UNVERIFIED',
]

function bestReliabilityOf(classes: readonly ReliabilityClass[]): ReliabilityClass {
  for (const cls of RELIABILITY_ORDER) {
    if (classes.includes(cls)) return cls
  }
  return 'UNVERIFIED'
}

function finalizeCluster(c: MutableCluster): StoryCluster {
  const members = [...c.members].sort((x, y) => x.article.publishedAt - y.article.publishedAt)
  const first = members[0]

  const sourceIds = [...new Set(members.map((m) => m.article.sourceId))]
  const reliabilityMix: Partial<Record<ReliabilityClass, number>> = {}
  for (const m of members) {
    reliabilityMix[m.article.reliability] = (reliabilityMix[m.article.reliability] ?? 0) + 1
  }

  // Merge entities: mention totals summed; sentiment merged as a hit-weighted
  // mean over members that actually had lexicon hits near the entity.
  const mentionTotals = new Map<string, number>()
  const sentimentSums = new Map<string, { weighted: number; hits: number }>()
  for (const m of members) {
    for (const e of m.entities) {
      mentionTotals.set(e.entityId, (mentionTotals.get(e.entityId) ?? 0) + e.count)
    }
    for (const es of m.entitySentiments) {
      if (es.sentiment.hits === 0) continue
      const acc = sentimentSums.get(es.entityId) ?? { weighted: 0, hits: 0 }
      acc.weighted += es.sentiment.score * es.sentiment.hits
      acc.hits += es.sentiment.hits
      sentimentSums.set(es.entityId, acc)
    }
  }
  const entities: ClusterEntity[] = [...mentionTotals.entries()]
    .map(([entityId, mentions]): ClusterEntity => {
      const acc = sentimentSums.get(entityId)
      const sentiment: SentimentResult =
        acc === undefined || acc.hits === 0
          ? { score: 0, hits: 0, confidence: 0 }
          : {
              score: Math.max(-100, Math.min(100, Math.round(acc.weighted / acc.hits))),
              hits: acc.hits,
              confidence: confidenceFor(acc.hits),
            }
      return { entityId, mentions, sentiment }
    })
    .sort((a, b) => b.mentions - a.mentions || (a.entityId < b.entityId ? -1 : 1))

  return {
    // Anchored on the first member's identity: stable across refreshes as long
    // as the earliest article stays in the window.
    id: `cluster-${stableHash(first === undefined ? 'empty' : first.article.urlHash)}`,
    members,
    sourceIds,
    sourceCount: sourceIds.length,
    earliestPublishedAt: first === undefined ? 0 : first.article.publishedAt,
    latestPublishedAt:
      members.length === 0 ? 0 : (members[members.length - 1]?.article.publishedAt ?? 0),
    bestReliability: bestReliabilityOf(members.map((m) => m.article.reliability)),
    reliabilityMix,
    entities,
    centroid: normalized(c.vectorSum),
  }
}
