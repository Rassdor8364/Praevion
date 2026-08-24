import { describe, expect, it } from 'vitest'

import { NEWS_ENTITIES, extractEntities, getEntity } from '@/engines/news/entities'

function ids(text: string): string[] {
  return extractEntities(text).map((m) => m.entityId)
}

describe('dictionary shape', () => {
  it('holds the promised 80-120 curated entries', () => {
    expect(NEWS_ENTITIES.length).toBeGreaterThanOrEqual(80)
    expect(NEWS_ENTITIES.length).toBeLessThanOrEqual(120)
  })

  it('ids are unique', () => {
    const unique = new Set(NEWS_ENTITIES.map((e) => e.id))
    expect(unique.size).toBe(NEWS_ENTITIES.length)
  })
})

describe('alias matching', () => {
  it('matches canonical names and tickers', () => {
    expect(ids('Bitcoin rallied as ETH followed')).toEqual(expect.arrayContaining(['btc', 'eth']))
    expect(ids('The Federal Reserve held rates steady')).toContain('fed')
    expect(ids('Manchester City beat Arsenal')).toEqual(
      expect.arrayContaining(['man-city', 'arsenal']),
    )
  })

  it("'fed up' does NOT match the Federal Reserve (case-sensitive alias)", () => {
    expect(ids('Investors are fed up with the delays')).not.toContain('fed')
    expect(ids('The cattle were fed this morning')).not.toContain('fed')
    // ...but the capitalized institution does match.
    expect(ids('The Fed signalled a pause')).toContain('fed')
  })

  it("'sec'/'us' lowercase words do not match SEC / United States", () => {
    expect(ids('wait a sec before you decide')).not.toContain('sec')
    expect(ids('The SEC opened a probe')).toContain('sec')
    expect(ids('they told us everything')).not.toContain('usa')
    expect(ids('the US economy grew')).toContain('usa')
  })

  it('respects word boundaries: BTC does not match inside BTCUSDT', () => {
    expect(ids('BTCUSDT perpetual funding flipped')).not.toContain('btc')
    expect(ids('BTC funding flipped')).toContain('btc')
    expect(ids('Solar power is not SOL')).toContain('sol')
    expect(ids('solar power expands')).not.toContain('sol')
  })

  it('counts mentions across aliases and dedupes overlapping offsets', () => {
    const matches = extractEntities('Bitcoin rose. Later, bitcoin fell. BTC ended flat.')
    const btc = matches.find((m) => m.entityId === 'btc')
    expect(btc).toBeDefined()
    expect(btc?.count).toBe(3)
    expect(btc?.offsets).toHaveLength(3)
  })

  it('multi-word aliases match case-insensitively', () => {
    expect(ids('the european central bank cut rates')).toContain('ecb')
    expect(ids('major league soccer expands again')).toContain('mls')
  })
})

describe('related assets', () => {
  it('macro entities carry their market read-through', () => {
    expect(getEntity('fed')?.relatedAssets).toEqual(expect.arrayContaining(['BTC', 'USD']))
    expect(getEntity('sec')?.relatedAssets).toContain('BTC')
    expect(getEntity('nvidia')?.relatedAssets).toContain('NVDA')
  })

  it('lookup returns null for unknown ids', () => {
    expect(getEntity('not-an-entity')).toBeNull()
  })
})

describe('determinism', () => {
  it('same text always yields identical matches', () => {
    const text = 'The Fed held rates as Bitcoin surged and Nvidia rallied'
    expect(extractEntities(text)).toEqual(extractEntities(text))
  })
})
