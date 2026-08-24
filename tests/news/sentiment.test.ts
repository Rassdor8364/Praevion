import { describe, expect, it } from 'vitest'

import {
  articleSentiment,
  confidenceFor,
  entitySentiment,
  scoreWindow,
  sentimentTokenize,
} from '@/engines/news/sentiment'

describe('articleSentiment — hand-computed scores', () => {
  it('single strong positive: "surges" (+3) → mean 3 × 25 = 75', () => {
    const r = articleSentiment('Bitcoin surges')
    expect(r.score).toBe(75)
    expect(r.hits).toBe(1)
    expect(r.confidence).toBeCloseTo(0.25, 5) // 1/(1+3)
  })

  it('single max negative: "crash" (-4) → -100', () => {
    expect(articleSentiment('Bitcoin crash deepens').score).toBe(-100)
  })

  it('mean over hits: gains (+2) and losses (-2) cancel to 0 WITH hits', () => {
    const r = articleSentiment('gains offset losses')
    expect(r.score).toBe(0)
    expect(r.hits).toBe(2)
    expect(r.confidence).toBeCloseTo(0.4, 5) // 2/(2+3)
  })

  it('no lexicon hits → zero score AND zero confidence (no signal ≠ neutral)', () => {
    const r = articleSentiment('The committee met on Tuesday afternoon')
    expect(r).toEqual({ score: 0, hits: 0, confidence: 0 })
  })
})

describe('negation', () => {
  it('flips within 3 tokens: "did not rally" (+3 → -3) = -75', () => {
    expect(articleSentiment('Bitcoin did not rally').score).toBe(-75)
  })

  it('flips negatives positive: "no losses reported" (-2 → +2) = +50', () => {
    expect(articleSentiment('no losses reported').score).toBe(50)
  })

  it('does NOT flip beyond the 3-token lookback', () => {
    // "not" sits 4 tokens before "rally": out of range, so +75 stands.
    expect(articleSentiment('not the best day to rally').score).toBe(75)
  })

  it('contractions negate: "isn\'t approved" (+3 → -3)', () => {
    expect(articleSentiment("the ETF isn't approved").score).toBe(-75)
  })
})

describe('intensity modifiers', () => {
  it('amplifier: "sharply dropped" (-2 × 1.5) = -75', () => {
    expect(articleSentiment('stocks sharply dropped').score).toBe(-75)
  })

  it('dampener: "slightly dropped" (-2 × 0.5) = -25', () => {
    expect(articleSentiment('stocks slightly dropped').score).toBe(-25)
  })
})

describe('confidence scaling', () => {
  it('1 hit is labelled noise-grade (0.25); more hits earn more', () => {
    expect(confidenceFor(0)).toBe(0)
    expect(confidenceFor(1)).toBeCloseTo(0.25, 5)
    expect(confidenceFor(3)).toBeCloseTo(0.5, 5)
    expect(confidenceFor(9)).toBeCloseTo(0.75, 5)
    expect(confidenceFor(1000)).toBe(0.95) // cap
  })
})

describe('entitySentiment — windowing', () => {
  const text =
    'Coinbase stock surged after strong earnings while regulators sued Binance over compliance failures'
  const coinbaseOffset = text.indexOf('Coinbase')
  const binanceOffset = text.indexOf('Binance')

  it('scores each entity from its own window, not the whole article', () => {
    const coinbase = entitySentiment({ text, mentionOffsets: [coinbaseOffset], windowTokens: 3 })
    const binance = entitySentiment({ text, mentionOffsets: [binanceOffset], windowTokens: 3 })
    expect(coinbase.score).toBe(75) // "surged" (+3) only
    expect(binance.score).toBe(-75) // "sued" (-3) only
  })

  it('excludes lexicon hits outside the window', () => {
    const far =
      'Bitcoin was unchanged one two three four five six seven eight nine ten eleven twelve markets crashed late'
    const r = entitySentiment({ text: far, mentionOffsets: [0] }) // default ±12
    expect(r.hits).toBe(0)
    expect(r.confidence).toBe(0)
  })

  it('merges overlapping windows so a shared hit counts once', () => {
    const r = entitySentiment({ text: 'Bitcoin and Bitcoin surged', mentionOffsets: [0, 12] })
    expect(r.hits).toBe(1)
    expect(r.score).toBe(75)
  })

  it('no mentions → no signal', () => {
    expect(entitySentiment({ text, mentionOffsets: [] })).toEqual({
      score: 0,
      hits: 0,
      confidence: 0,
    })
  })
})

describe('scoreWindow plumbing', () => {
  it('clamps out-of-range windows instead of throwing', () => {
    const tokens = sentimentTokenize('markets rally today')
    expect(scoreWindow(tokens, -10, 100).score).toBe(75)
  })
})
