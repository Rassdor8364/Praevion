import { describe, expect, it } from 'vitest'

import type { LinkedMarketQuote } from '@/core/markets/types'
import { detectDislocations, jaccard, linkByTitle, titleTokens } from '@/engines/markets/dislocation'

import { makeMarket } from './fixtures'

function quote(provider: string, marketProbability: number, overrides: Partial<LinkedMarketQuote> = {}): LinkedMarketQuote {
  return {
    provider,
    marketId: `${provider}:X`,
    title: 'Test',
    outcomeName: 'Yes',
    marketProbability,
    liquidity: null,
    ...overrides,
  }
}

function group(quotes: LinkedMarketQuote[], vixeraProbability: number | null = null, key = 'g1') {
  return { eventKey: key, eventTitle: 'Event', quotes, vixeraProbability }
}

describe('detectDislocations — pairwise spread', () => {
  it('max pairwise spread of a probability set is its range', () => {
    const out = detectDislocations([group([quote('a', 0.4), quote('b', 0.52), quote('c', 0.47)])], 0)
    expect(out).toHaveLength(1)
    expect(out[0]?.crossMarketSpreadPp).toBeCloseTo(0.12, 10)
  })

  it('filters groups below the threshold and keeps those at or above it', () => {
    const out = detectDislocations(
      [
        group([quote('a', 0.5), quote('b', 0.53)], null, 'small'), // 3pp
        group([quote('a', 0.4), quote('b', 0.48)], null, 'big'), // 8pp
      ],
      0.05,
    )
    expect(out.map((d) => d.eventKey)).toEqual(['big'])
  })

  it('sorts by spread descending', () => {
    const out = detectDislocations(
      [
        group([quote('a', 0.4), quote('b', 0.45)], null, 'g5'),
        group([quote('a', 0.3), quote('b', 0.5)], null, 'g20'),
        group([quote('a', 0.4), quote('b', 0.5)], null, 'g10'),
      ],
      0,
    )
    expect(out.map((d) => d.eventKey)).toEqual(['g20', 'g10', 'g5'])
  })

  it('locates the largest Vixera edge across venues (magnitude, signed value kept)', () => {
    const out = detectDislocations([group([quote('kalshi', 0.4), quote('polymarket', 0.52)], 0.6)], 0)
    expect(out[0]?.largestEdge).not.toBeNull()
    expect(out[0]?.largestEdge?.provider).toBe('kalshi')
    expect(out[0]?.largestEdge?.edgePp).toBeCloseTo(0.2, 10)
  })

  it('largestEdge is null when Vixera has no probability for the event', () => {
    const out = detectDislocations([group([quote('a', 0.4), quote('b', 0.52)], null)], 0)
    expect(out[0]?.largestEdge).toBeNull()
  })

  it('drops non-finite quotes instead of manufacturing a spread from a feed bug', () => {
    // With the NaN quote dropped only one valid quote remains → no dislocation.
    expect(detectDislocations([group([quote('a', Number.NaN), quote('b', 0.5)])], 0)).toHaveLength(0)
    // Enough valid quotes survive → the spread is measured on them alone.
    const out = detectDislocations([group([quote('a', Number.NaN), quote('b', 0.3), quote('c', 0.5)])], 0)
    expect(out[0]?.crossMarketSpreadPp).toBeCloseTo(0.2, 10)
  })

  it('a NaN threshold degrades to 0 rather than filtering everything out', () => {
    const out = detectDislocations([group([quote('a', 0.4), quote('b', 0.5)])], Number.NaN)
    expect(out).toHaveLength(1)
  })
})

describe('linkByTitle — token Jaccard linking', () => {
  const cutsA = makeMarket({ id: 'kalshi:CUT', title: 'Fed cuts rates by December?' })
  const cutsB = makeMarket({ id: 'poly:CUT', title: 'Will the Fed cut rates by December 2026?' })
  const raises = makeMarket({ id: 'kalshi:RAISE', title: 'Fed raises rates by December?' })
  const btc = makeMarket({ id: 'poly:BTC', title: 'Bitcoin above $100k at year end?' })

  it('links the two phrasings of the Fed-cut market', () => {
    const groups = linkByTitle([cutsA, cutsB, raises, btc])
    const cutGroup = groups.find((g) => g.markets.some((m) => m.id === 'kalshi:CUT'))
    expect(cutGroup).toBeDefined()
    expect(cutGroup?.markets.map((m) => m.id).sort()).toEqual(['kalshi:CUT', 'poly:CUT'])
  })

  it('does NOT link "cuts" with "raises" — one token apart is exactly the antonym trap', () => {
    const groups = linkByTitle([cutsA, cutsB, raises, btc])
    for (const g of groups) {
      const ids = g.markets.map((m) => m.id)
      expect(ids.includes('kalshi:RAISE') && ids.includes('kalshi:CUT')).toBe(false)
      expect(ids.includes('kalshi:RAISE') && ids.includes('poly:CUT')).toBe(false)
    }
  })

  it('returns only groups of two or more — singletons cannot dislocate', () => {
    const groups = linkByTitle([cutsA, cutsB, raises, btc])
    expect(groups).toHaveLength(1)
    for (const g of groups) expect(g.markets.length).toBeGreaterThanOrEqual(2)
  })

  it('normalisation: stopwords, years and plurals unify; content words survive', () => {
    expect(titleTokens('Will the Fed cut rates by December 2026?')).toEqual(
      new Set(['fed', 'cut', 'rate', 'december']),
    )
    // "before"/"after" change the event and must NOT be stripped.
    expect(titleTokens('Resolves before March')).toContain('before')
  })

  it('jaccard is 0 for empty sets and 1 for identical sets', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0)
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
  })

  it('handles empty input and punctuation-only titles without throwing', () => {
    expect(linkByTitle([])).toEqual([])
    const weird = makeMarket({ id: 'x:1', title: '?!?!' })
    const weird2 = makeMarket({ id: 'x:2', title: '...' })
    expect(linkByTitle([weird, weird2])).toEqual([]) // empty token sets never link
  })
})
