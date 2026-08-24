import { describe, expect, it } from 'vitest'

import {
  assessLiquidity,
  depthScore,
  estimateSlippage,
  gradeFromScore,
  spreadScore,
  volumeScore,
} from '@/engines/markets/liquidity'

import { makeBook } from './fixtures'

describe('spread score', () => {
  it('is strictly decreasing in spread', () => {
    const spreads = [0.005, 0.01, 0.02, 0.04, 0.08, 0.15]
    const scores = spreads.map(spreadScore)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i] as number).toBeLessThan(scores[i - 1] as number)
    }
  })

  it('grades a 1pp spread excellent and a 10pp spread nearly untradeable', () => {
    expect(spreadScore(0.01)).toBeGreaterThan(90)
    expect(spreadScore(0.1)).toBeLessThan(20)
    expect(spreadScore(0.04)).toBeCloseTo(50, 8) // half-score anchor
  })
})

describe('volume score — log behaviour', () => {
  it('the step from $1k to $100k matters far more than $10M to $20M', () => {
    const smallStep = volumeScore(100_000, null, null) - volumeScore(1_000, null, null)
    const bigStep = volumeScore(20_000_000, null, null) - volumeScore(10_000_000, null, null)
    expect(smallStep).toBeGreaterThan(30)
    expect(bigStep).toBeCloseTo(0, 5)
    expect(smallStep).toBeGreaterThan(bigStep)
  })

  it('clamps garbage volumes to zero contribution instead of exploding', () => {
    expect(volumeScore(-500, null, null)).toBe(0)
    expect(volumeScore(Number.NaN, Number.POSITIVE_INFINITY, null)).toBeGreaterThanOrEqual(0)
    expect(volumeScore(Number.POSITIVE_INFINITY, null, null)).toBeLessThanOrEqual(100)
  })
})

describe('depth score — symmetric grading', () => {
  it('scores mirrored books identically: depth is side-agnostic', () => {
    const bidHeavy = makeBook({
      bids: [{ price: 0.48, size: 5000 }],
      asks: [{ price: 0.52, size: 100 }],
    })
    const askHeavy = makeBook({
      bids: [{ price: 0.48, size: 100 }],
      asks: [{ price: 0.52, size: 5000 }],
    })
    expect(depthScore(bidHeavy)).toBeCloseTo(depthScore(askHeavy) as number, 10)
    expect(assessLiquidity({ spread: 0.02, volume: 100_000, volume24h: null, liquidity: null, book: bidHeavy }).score).toBeCloseTo(
      assessLiquidity({ spread: 0.02, volume: 100_000, volume24h: null, liquidity: null, book: askHeavy }).score,
      10,
    )
  })

  it('only counts size within ±5pp of the mid', () => {
    const nearOnly = makeBook({ bids: [{ price: 0.48, size: 1000 }], asks: [{ price: 0.52, size: 1000 }] })
    const farAdded = makeBook({
      bids: [
        { price: 0.48, size: 1000 },
        { price: 0.2, size: 50_000 }, // far outside the band — must not count
      ],
      asks: [{ price: 0.52, size: 1000 }],
    })
    expect(depthScore(farAdded)).toBeCloseTo(depthScore(nearOnly) as number, 10)
  })

  it('an empty book scores 0 ("we looked, nothing there"); a missing book is null', () => {
    expect(depthScore(makeBook({ bids: [], asks: [] }))).toBe(0)
    expect(depthScore(null)).toBeNull()
    expect(depthScore(undefined)).toBeNull()
  })
})

describe('assessLiquidity — null-book ceiling', () => {
  const great = { spread: 0.005, volume: 5_000_000, volume24h: 500_000, liquidity: 1_000_000 }

  it('a missing book caps the score at 70 — never excellent without visible depth', () => {
    const noBook = assessLiquidity({ ...great, book: null })
    expect(noBook.score).toBeLessThanOrEqual(70)
    expect(noBook.grade).not.toBe('excellent')
    expect(noBook.depthScore).toBeNull()
    expect(noBook.notes.some((n) => n.includes('Order book unavailable'))).toBe(true)
  })

  it('the same market WITH a deep book scores higher and can grade excellent', () => {
    const withBook = assessLiquidity({ ...great, book: makeBook() })
    const noBook = assessLiquidity({ ...great, book: null })
    expect(withBook.score).toBeGreaterThan(noBook.score)
    expect(withBook.grade).toBe('excellent')
  })
})

describe('assessLiquidity — grade boundaries and monotonicity', () => {
  it('maps scores to grades at the documented boundaries', () => {
    expect(gradeFromScore(80)).toBe('excellent')
    expect(gradeFromScore(79.99)).toBe('good')
    expect(gradeFromScore(60)).toBe('good')
    expect(gradeFromScore(59.99)).toBe('fair')
    expect(gradeFromScore(40)).toBe('fair')
    expect(gradeFromScore(39.99)).toBe('poor')
    expect(gradeFromScore(20)).toBe('poor')
    expect(gradeFromScore(19.99)).toBe('illiquid')
  })

  it('score strictly decreases as the spread widens, everything else fixed', () => {
    const scores = [0.005, 0.02, 0.05, 0.12].map(
      (spread) =>
        assessLiquidity({ spread, volume: 100_000, volume24h: 10_000, liquidity: null, book: makeBook() }).score,
    )
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i] as number).toBeLessThan(scores[i - 1] as number)
    }
  })
})

describe('estimateSlippage', () => {
  const book = makeBook({
    bids: [{ price: 0.5, size: 100 }],
    asks: [
      { price: 0.52, size: 100 },
      { price: 0.55, size: 100 },
    ],
  })
  // mid = (0.50 + 0.52) / 2 = 0.51

  it('single-level fill: $52 buys 100 contracts at 0.52 → 1pp deviation from mid', () => {
    expect(estimateSlippage(book, 52)).toBeCloseTo(0.01, 8)
  })

  it('multi-level fill: $79.50 → 100 @ 0.52 + 50 @ 0.55 → avg 0.53 → 2pp', () => {
    expect(estimateSlippage(book, 79.5)).toBeCloseTo(0.02, 8)
  })

  it('returns null when the displayed book cannot absorb the notional', () => {
    expect(estimateSlippage(book, 1_000_000)).toBeNull()
  })

  it('returns null for missing books and degenerate notionals', () => {
    expect(estimateSlippage(null, 100)).toBeNull()
    expect(estimateSlippage(undefined, 100)).toBeNull()
    expect(estimateSlippage(book, 0)).toBeNull()
    expect(estimateSlippage(book, -5)).toBeNull()
    expect(estimateSlippage(book, Number.NaN)).toBeNull()
    expect(estimateSlippage(makeBook({ asks: [] }), 100)).toBeNull()
  })

  it('ignores garbage levels instead of producing NaN', () => {
    const dirty = makeBook({
      asks: [
        { price: Number.NaN, size: 100 },
        { price: 0.52, size: Number.POSITIVE_INFINITY },
        { price: 0.53, size: 100 },
      ],
    })
    const slip = estimateSlippage(dirty, 26.5)
    expect(slip).not.toBeNull()
    expect(Number.isFinite(slip as number)).toBe(true)
  })
})

describe('assessLiquidity — adversarial inputs stay bounded', () => {
  it('survives NaN spread, negative volume, Infinity liquidity', () => {
    const out = assessLiquidity({
      spread: Number.NaN,
      volume: -100,
      volume24h: Number.POSITIVE_INFINITY,
      liquidity: Number.NEGATIVE_INFINITY,
      book: makeBook({ bids: [{ price: Number.NaN, size: -5 }], asks: [] }),
    })
    expect(out.score).toBeGreaterThanOrEqual(0)
    expect(out.score).toBeLessThanOrEqual(100)
    expect(['excellent', 'good', 'fair', 'poor', 'illiquid']).toContain(out.grade)
    expect(out.spreadPp).toBeNull()
    expect(out.volumeScore).toBeGreaterThanOrEqual(0)
    expect(out.notes.length).toBeGreaterThan(0)
  })
})
