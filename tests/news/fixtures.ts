/** Shared builders for the news-engine tests. */

import type { ReliabilityClass } from '@/core/prediction/types'
import type { RawArticle } from '@/providers/types'
import { normalizeArticle, type NormalizedArticle } from '@/engines/news/normalize'
import { analyzeArticle } from '@/engines/news/orchestrator'
import type { AnalyzedArticle } from '@/engines/news/cluster'

/** 2026-08-13T00:00:00Z — every test instant derives from this. */
export const T0 = Date.UTC(2026, 7, 13)

let seq = 0

export function makeRaw(over: Partial<RawArticle> & { title: string }): RawArticle {
  seq += 1
  return {
    externalId: `test-${seq}`,
    url: `https://example.com/articles/${seq}`,
    sourceName: 'Test Wire',
    sourceId: 'test-wire',
    author: null,
    publishedAt: T0,
    summary: null,
    body: null,
    category: 'markets',
    imageUrl: null,
    ...over,
  }
}

export function makeNormalized(
  over: Partial<RawArticle> & { title: string },
  reliability: ReliabilityClass = 'ESTABLISHED_MEDIA',
): NormalizedArticle {
  const n = normalizeArticle(makeRaw(over), { reliability })
  if (n === null) throw new Error(`normalizeArticle returned null for "${over.title}"`)
  return n
}

export function makeAnalyzed(
  over: Partial<RawArticle> & { title: string },
  reliability: ReliabilityClass = 'ESTABLISHED_MEDIA',
): AnalyzedArticle {
  return analyzeArticle(makeNormalized(over, reliability))
}
