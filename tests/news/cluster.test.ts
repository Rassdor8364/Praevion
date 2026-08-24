import { describe, expect, it } from 'vitest'

import { HOUR_MS } from '@/core/clock'
import {
  clusterArticles,
  computeIdf,
  cosineSimilarity,
  tfidfVector,
} from '@/engines/news/cluster'
import { makeAnalyzed, T0 } from './fixtures'

describe('tf-idf machinery', () => {
  it('down-weights window-common tokens and up-weights rare ones', () => {
    const idf = computeIdf([
      { tokens: ['bitcoin', 'rally'] },
      { tokens: ['bitcoin', 'hack'] },
      { tokens: ['bitcoin', 'etf'] },
    ])
    const common = idf.get('bitcoin')
    const rare = idf.get('hack')
    expect(common).toBeDefined()
    expect(rare).toBeDefined()
    expect(rare ?? 0).toBeGreaterThan(common ?? 0)
  })

  it('cosine of identical vectors is 1, of disjoint vectors is 0', () => {
    const idf = computeIdf([{ tokens: ['a', 'b'] }, { tokens: ['c', 'd'] }])
    const v1 = tfidfVector(['a', 'b'], idf)
    const v2 = tfidfVector(['c', 'd'], idf)
    expect(cosineSimilarity(v1, v1)).toBeCloseTo(1, 9)
    expect(cosineSimilarity(v1, v2)).toBe(0)
  })
})

describe('clusterArticles', () => {
  it('merges two rewordings of the same story; keeps an unrelated one apart', () => {
    const clusters = clusterArticles([
      makeAnalyzed({
        title: 'Federal Reserve holds interest rates steady signals September cut',
        publishedAt: T0,
        sourceId: 'wire-a',
      }),
      makeAnalyzed({
        title: 'Fed holds interest rates steady hints at September cut',
        publishedAt: T0 + HOUR_MS,
        sourceId: 'wire-b',
      }),
      makeAnalyzed({
        title: 'Arsenal beat Manchester City in Premier League opener',
        publishedAt: T0,
        sourceId: 'wire-c',
      }),
    ])

    expect(clusters).toHaveLength(2)
    const fedCluster = clusters.find((c) => c.members.length === 2)
    expect(fedCluster).toBeDefined()
    expect(fedCluster?.sourceCount).toBe(2)
  })

  it('does not merge same-beat but different stories', () => {
    const clusters = clusterArticles([
      makeAnalyzed({ title: 'Bitcoin surges past 70,000 dollars on ETF inflows', publishedAt: T0 }),
      makeAnalyzed({
        title: 'Exchange hack drains 300 million from derivatives platform',
        publishedAt: T0,
      }),
    ])
    expect(clusters).toHaveLength(2)
  })

  it('enforces the 48h window even for identical text', () => {
    const clusters = clusterArticles([
      makeAnalyzed({
        title: 'Nvidia earnings beat expectations on data center growth',
        publishedAt: T0,
        sourceId: 'wire-a',
      }),
      makeAnalyzed({
        title: 'Nvidia earnings beat expectations on data center growth',
        publishedAt: T0 + 60 * HOUR_MS,
        sourceId: 'wire-b',
        url: 'https://example.com/nvda-late',
      }),
    ])
    expect(clusters).toHaveLength(2)
  })

  it('counts DISTINCT sources, not members', () => {
    const clusters = clusterArticles([
      makeAnalyzed({
        title: 'Tesla recalls vehicles over software fault',
        publishedAt: T0,
        sourceId: 'outlet-a',
        url: 'https://a.com/1',
      }),
      makeAnalyzed({
        title: 'Tesla recalls vehicles over software fault',
        publishedAt: T0 + HOUR_MS,
        sourceId: 'outlet-a', // same outlet again
        url: 'https://a.com/2',
      }),
      makeAnalyzed({
        title: 'Tesla recalls vehicles over software fault',
        publishedAt: T0 + 2 * HOUR_MS,
        sourceId: 'outlet-b',
        url: 'https://b.com/1',
      }),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.members).toHaveLength(3)
    expect(clusters[0]?.sourceCount).toBe(2)
    expect([...(clusters[0]?.sourceIds ?? [])].sort()).toEqual(['outlet-a', 'outlet-b'])
  })

  it('tracks earliest/latest publish and merges entities with summed mentions', () => {
    const clusters = clusterArticles([
      makeAnalyzed({
        title: 'Fed cuts interest rates in surprise move',
        publishedAt: T0,
        sourceId: 'wire-a',
      }),
      makeAnalyzed({
        title: 'Fed cuts interest rates in surprise easing move',
        publishedAt: T0 + 3 * HOUR_MS,
        sourceId: 'wire-b',
        url: 'https://example.com/fed-2',
      }),
    ])
    expect(clusters).toHaveLength(1)
    const c = clusters[0]
    expect(c?.earliestPublishedAt).toBe(T0)
    expect(c?.latestPublishedAt).toBe(T0 + 3 * HOUR_MS)
    const fed = c?.entities.find((e) => e.entityId === 'fed')
    expect(fed).toBeDefined()
    expect(fed?.mentions).toBe(2)
  })

  it('reliability mix and best class reflect the members', () => {
    const clusters = clusterArticles([
      makeAnalyzed(
        { title: 'Exchange token rumor spreads across social platforms', publishedAt: T0, sourceId: 's1' },
        'SOCIAL',
      ),
      makeAnalyzed(
        {
          title: 'Exchange token rumor spreads across social platforms',
          publishedAt: T0 + HOUR_MS,
          sourceId: 's2',
          url: 'https://example.com/rumor-2',
        },
        'ESTABLISHED_MEDIA',
      ),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.bestReliability).toBe('ESTABLISHED_MEDIA')
    expect(clusters[0]?.reliabilityMix).toEqual({ SOCIAL: 1, ESTABLISHED_MEDIA: 1 })
  })

  it('cluster ids are stable across re-clustering of the same window', () => {
    const build = () =>
      clusterArticles([
        makeAnalyzed({
          title: 'Oil prices climb after supply disruption',
          publishedAt: T0,
          url: 'https://example.com/oil-fixed',
        }),
      ])
    expect(build()[0]?.id).toBe(build()[0]?.id)
  })
})
