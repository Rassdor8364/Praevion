import { describe, expect, it } from 'vitest'

import { HOUR_MS } from '@/core/clock'
import type { ReliabilityClass } from '@/core/prediction/types'
import { clusterArticles, type StoryCluster } from '@/engines/news/cluster'
import { scoreCluster } from '@/engines/news/importance'
import { makeAnalyzed, T0 } from './fixtures'

/** One cluster from N copies of a story, one per distinct source. */
function storyCluster(
  title: string,
  sources: readonly string[],
  opts?: { reliability?: ReliabilityClass; startAt?: number; spacingMs?: number },
): StoryCluster {
  const startAt = opts?.startAt ?? T0
  const spacing = opts?.spacingMs ?? 30 * 60_000
  const clusters = clusterArticles(
    sources.map((sourceId, i) =>
      makeAnalyzed(
        {
          title,
          sourceId,
          publishedAt: startAt + i * spacing,
          url: `https://${sourceId}.example.com/story`,
        },
        opts?.reliability ?? 'ESTABLISHED_MEDIA',
      ),
    ),
  )
  if (clusters.length !== 1 || clusters[0] === undefined) {
    throw new Error(`fixture did not form one cluster (got ${clusters.length})`)
  }
  return clusters[0]
}

describe('scoreCluster — source corroboration', () => {
  it('more independent sources → higher importance', () => {
    const title = 'Fed cuts interest rates by a quarter point'
    const asOf = T0 + 4 * HOUR_MS
    const one = scoreCluster({
      cluster: storyCluster(title, ['wire-a']),
      olderClusters: [],
      category: 'markets',
      asOf,
    })
    const five = scoreCluster({
      cluster: storyCluster(title, ['wire-a', 'wire-b', 'wire-c', 'wire-d', 'wire-e']),
      olderClusters: [],
      category: 'markets',
      asOf,
    })
    expect(five.importance).toBeGreaterThan(one.importance)
    expect(one.components.sourceCount).toBe(0) // log2(1)/log2(8)
  })
})

describe('scoreCluster — rumour handling', () => {
  it('SOCIAL-only cluster is unverified, capped, and never breaking', () => {
    const r = scoreCluster({
      cluster: storyCluster(
        'Exchange rumored to halt withdrawals amid liquidation fears',
        ['acct-1', 'acct-2', 'acct-3', 'acct-4'],
        { reliability: 'SOCIAL' },
      ),
      olderClusters: [],
      category: 'crypto',
      asOf: T0 + 2 * HOUR_MS,
    })
    expect(r.unverified).toBe(true)
    expect(r.importance).toBeLessThanOrEqual(35)
    expect(r.isBreaking).toBe(false)
  })

  it('one ESTABLISHED_MEDIA member lifts the unverified flag', () => {
    const clusters = clusterArticles([
      makeAnalyzed(
        { title: 'Exchange halts withdrawals amid liquidity crunch', sourceId: 'acct-1', publishedAt: T0 },
        'SOCIAL',
      ),
      makeAnalyzed(
        {
          title: 'Exchange halts withdrawals amid liquidity crunch',
          sourceId: 'newsroom',
          publishedAt: T0 + HOUR_MS,
          url: 'https://newsroom.example.com/halt',
        },
        'ESTABLISHED_MEDIA',
      ),
    ])
    expect(clusters).toHaveLength(1)
    const cluster = clusters[0]
    if (cluster === undefined) throw new Error('fixture failed')
    const r = scoreCluster({ cluster, olderClusters: [], category: 'crypto', asOf: T0 + 2 * HOUR_MS })
    expect(r.unverified).toBe(false)
  })
})

describe('scoreCluster — breaking detection', () => {
  it('fires on velocity: ≥3 independent sources within a young window', () => {
    const r = scoreCluster({
      cluster: storyCluster('Major exchange hacked for 500 million dollars', [
        'wire-a',
        'wire-b',
        'wire-c',
        'wire-d',
        'wire-e',
      ]),
      olderClusters: [],
      category: 'crypto',
      asOf: T0 + 2 * HOUR_MS, // 5 sources / 2h = 2.5/h ≥ 1.5
    })
    expect(r.isBreaking).toBe(true)
    expect(r.sourcesPerHour).toBeCloseTo(2.5, 5)
  })

  it('does NOT fire from the word BREAKING in a headline', () => {
    const r = scoreCluster({
      cluster: storyCluster('BREAKING: Bitcoin crashes below 50,000 dollars', ['lone-wire']),
      olderClusters: [],
      category: 'crypto',
      asOf: T0 + HOUR_MS, // 1 source/h, 1 source — fails velocity AND corroboration
    })
    expect(r.isBreaking).toBe(false)
  })

  it('does not fire once the cluster is old, whatever the source count', () => {
    const r = scoreCluster({
      cluster: storyCluster('Major exchange hacked for 500 million dollars', [
        'wire-a',
        'wire-b',
        'wire-c',
        'wire-d',
        'wire-e',
      ]),
      olderClusters: [],
      category: 'crypto',
      asOf: T0 + 30 * HOUR_MS, // > 6h old
    })
    expect(r.isBreaking).toBe(false)
  })
})

describe('scoreCluster — novelty', () => {
  it('a follow-up beat of an older story scores lower novelty than a new story', () => {
    const older = storyCluster('Bitcoin ETF approval decision expected this week', ['wire-a'], {
      startAt: T0,
    })
    // Same vocabulary, 72h later — outside the cluster window, so its own cluster.
    const followUp = storyCluster('Bitcoin ETF approval decision finally arrives this week', ['wire-b'], {
      startAt: T0 + 72 * HOUR_MS,
    })
    const novel = storyCluster('Nvidia earnings beat expectations on data center growth', ['wire-c'], {
      startAt: T0 + 72 * HOUR_MS,
    })

    const asOf = T0 + 73 * HOUR_MS
    const followUpScore = scoreCluster({
      cluster: followUp,
      olderClusters: [older],
      category: 'crypto',
      asOf,
    })
    const novelScore = scoreCluster({ cluster: novel, olderClusters: [older], category: 'crypto', asOf })

    expect(followUpScore.components.novelty).toBeLessThan(0.6)
    expect(novelScore.components.novelty).toBeGreaterThan(0.9)
  })

  it('only clusters that began EARLIER count against novelty', () => {
    const a = storyCluster('Oil prices climb after supply disruption', ['wire-a'], { startAt: T0 })
    const later = storyCluster('Oil prices climb after fresh supply disruption', ['wire-b'], {
      startAt: T0 + 72 * HOUR_MS,
    })
    // Scoring the OLDER cluster against the newer one: the newer one must not
    // reduce its novelty.
    const r = scoreCluster({
      cluster: a,
      olderClusters: [later],
      category: 'markets',
      asOf: T0 + 73 * HOUR_MS,
    })
    expect(r.components.novelty).toBe(1)
  })
})

describe('scoreCluster — entity importance', () => {
  it('macro entities outrank sports entities', () => {
    const asOf = T0 + 4 * HOUR_MS
    const fed = scoreCluster({
      cluster: storyCluster('Federal Reserve signals policy shift ahead', ['wire-a', 'wire-b']),
      olderClusters: [],
      category: 'markets',
      asOf,
    })
    const club = scoreCluster({
      cluster: storyCluster('Arsenal confirm new signing ahead of season', ['wire-a', 'wire-b']),
      olderClusters: [],
      category: 'markets', // same category on purpose: isolate the entity factor
      asOf,
    })
    expect(fed.components.entityImportance).toBeGreaterThan(club.components.entityImportance)
  })
})
