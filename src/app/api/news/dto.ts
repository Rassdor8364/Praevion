/**
 * Wire shapes for the /api/news routes.
 *
 * A ScoredCluster carries full member articles including token vectors; the
 * API strips that down to what a client can render. `summaryMechanism` is
 * part of the contract on purpose: the summary is the lead paragraph of the
 * best-reliability member (extractive), and the payload says so rather than
 * letting a client caption it "AI summary".
 */

import type { ScoredCluster } from '@/engines/news/orchestrator'
import { getEntity } from '@/engines/news/entities'

export interface ClusterEntityDto {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly mentions: number
  /** Null when sentiment confidence is below the display threshold — the
   *  honest alternative to shipping a fake neutral zero. */
  readonly sentiment: { readonly score: number; readonly confidence: number } | null
}

export interface ClusterArticleDto {
  readonly title: string
  readonly url: string
  readonly sourceName: string
  readonly reliability: string
  readonly publishedAt: string
}

export interface ClusterDto {
  readonly id: string
  readonly headline: string
  readonly summary: string | null
  readonly summaryMechanism: 'extractive'
  readonly category: string
  readonly importance: number
  readonly isBreaking: boolean
  readonly unverified: boolean
  readonly sourcesPerHour: number
  readonly sourceCount: number
  readonly sourceNames: readonly string[]
  readonly firstDetectedAt: string
  readonly lastUpdatedAt: string
  readonly entities: readonly ClusterEntityDto[]
  readonly articles: readonly ClusterArticleDto[]
}

/** Sentiment chips require ≥ 2 lexicon hits (confidence 0.4); a single hit
 *  (0.25) is noise by the sentiment engine's own definition. */
export const SENTIMENT_DISPLAY_CONFIDENCE = 0.3

export function toClusterDto(scored: ScoredCluster): ClusterDto {
  const { cluster, importance } = scored
  return {
    id: cluster.id,
    headline: scored.headline,
    summary: scored.extractiveSummary,
    summaryMechanism: 'extractive',
    category: scored.category,
    importance: importance.importance,
    isBreaking: importance.isBreaking,
    unverified: importance.unverified,
    sourcesPerHour: Number(importance.sourcesPerHour.toFixed(2)),
    sourceCount: cluster.sourceCount,
    sourceNames: [...new Set(cluster.members.map((m) => m.article.sourceName))],
    firstDetectedAt: new Date(cluster.earliestPublishedAt).toISOString(),
    lastUpdatedAt: new Date(cluster.latestPublishedAt).toISOString(),
    entities: cluster.entities.flatMap((e): ClusterEntityDto[] => {
      const definition = getEntity(e.entityId)
      if (definition === null) return []
      return [
        {
          id: e.entityId,
          name: definition.name,
          type: definition.type,
          mentions: e.mentions,
          sentiment:
            e.sentiment.confidence >= SENTIMENT_DISPLAY_CONFIDENCE
              ? { score: e.sentiment.score, confidence: Number(e.sentiment.confidence.toFixed(2)) }
              : null,
        },
      ]
    }),
    articles: cluster.members.map(
      (m): ClusterArticleDto => ({
        title: m.article.title,
        url: m.article.url,
        sourceName: m.article.sourceName,
        reliability: m.article.reliability,
        publishedAt: new Date(m.article.publishedAt).toISOString(),
      }),
    ),
  }
}
