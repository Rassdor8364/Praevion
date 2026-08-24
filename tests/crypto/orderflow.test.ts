import { describe, expect, it } from 'vitest'

import {
  aggressorImbalance,
  bookDepthScore,
  detectWalls,
  midPrice,
  orderBookImbalance,
} from '@/engines/crypto/orderflow'

import { makeBook, makeCandle, randomWalkCandles, symmetricBook } from './fixtures'

// ---------------------------------------------------------------------------
// Mid price
// ---------------------------------------------------------------------------

describe('midPrice', () => {
  it('is the midpoint of the touch', () => {
    expect(midPrice(makeBook([[99, 1]], [[101, 1]]))).toBe(100)
  })

  it('falls back to the only side present on a one-sided book', () => {
    expect(midPrice(makeBook([[99, 1]], []))).toBe(99)
    expect(midPrice(makeBook([], [[101, 1]]))).toBe(101)
  })

  it('is null only for a genuinely empty book', () => {
    expect(midPrice(makeBook([], []))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Imbalance
// ---------------------------------------------------------------------------

describe('orderBookImbalance', () => {
  it('is exactly 0 for a perfectly symmetric book', () => {
    const result = orderBookImbalance(symmetricBook(100, 10, 0.1, 5), 0.02)
    expect(result.imbalance).toBe(0)
    expect(result.buyPressure).toBe(0.5)
    expect(result.sellPressure).toBe(0.5)
    expect(result.bidVolume).toBe(result.askVolume)
    expect(result.midPrice).toBeCloseTo(100, 10)
  })

  it('is +1 for a bids-only book and −1 for an asks-only book (bid-positive)', () => {
    expect(orderBookImbalance(makeBook([[100, 7]], []), 0.05).imbalance).toBe(1)
    expect(orderBookImbalance(makeBook([], [[100, 7]]), 0.05).imbalance).toBe(-1)
    expect(orderBookImbalance(makeBook([[100, 7]], []), 0.05).buyPressure).toBe(1)
    expect(orderBookImbalance(makeBook([], [[100, 7]]), 0.05).sellPressure).toBe(1)
  })

  it('matches a hand-computed lopsided book', () => {
    // bids 30 total, asks 10 total ⇒ (30 − 10)/40 = 0.5, buyPressure 0.75
    const book = makeBook(
      [
        [99.9, 20],
        [99.8, 10],
      ],
      [
        [100.1, 6],
        [100.2, 4],
      ],
    )
    const result = orderBookImbalance(book, 0.01)
    expect(result.bidVolume).toBe(30)
    expect(result.askVolume).toBe(10)
    expect(result.imbalance).toBeCloseTo(0.5, 12)
    expect(result.buyPressure).toBeCloseTo(0.75, 12)
    expect(result.sellPressure).toBeCloseTo(0.25, 12)
  })

  it('ignores levels beyond depthPct — far resting size is noise, not signal', () => {
    // A 10,000-lot ask 5% away must not swamp the near-touch picture.
    const book = makeBook(
      [[99.9, 10]],
      [
        [100.1, 10],
        [105, 10_000],
      ],
    )
    const near = orderBookImbalance(book, 0.005)
    expect(near.askVolume).toBe(10)
    expect(near.imbalance).toBe(0)

    // Widen the window and the same distant order dominates, which is exactly
    // the failure mode the cutoff exists to prevent.
    const wide = orderBookImbalance(book, 0.1)
    expect(wide.askVolume).toBe(10_010)
    expect(wide.imbalance).toBeLessThan(-0.99)
  })

  it('computes spread and spreadBps correctly', () => {
    const result = orderBookImbalance(makeBook([[99.5, 1]], [[100.5, 1]]), 0.02)
    expect(result.spread).toBeCloseTo(1, 10)
    expect(result.midPrice).toBeCloseTo(100, 10)
    expect(result.spreadBps).toBeCloseTo(100, 10) // 1/100 = 1% = 100 bps
  })

  it('is scale-free: the same relative book reads identically at any price', () => {
    const build = (scale: number) =>
      makeBook(
        [
          [99.9 * scale, 10],
          [99.5 * scale, 5],
        ],
        [
          [100.1 * scale, 4],
          [100.5 * scale, 8],
        ],
      )
    const cheap = orderBookImbalance(build(0.0015), 0.01)
    const rich = orderBookImbalance(build(1_180), 0.01)
    expect(cheap.imbalance).toBeCloseTo(rich.imbalance, 12)
    expect(cheap.spreadBps).toBeCloseTo(rich.spreadBps, 8)
  })

  it('returns a neutral reading for an empty book rather than NaN', () => {
    const result = orderBookImbalance(makeBook([], []))
    expect(result.imbalance).toBe(0)
    expect(result.buyPressure).toBe(0.5)
    expect(Number.isFinite(result.spreadBps)).toBe(true)
  })

  it('always produces an imbalance within [−1, 1] and pressures summing to 1', () => {
    const books = [
      symmetricBook(100, 20, 0.05, 3),
      makeBook([[10, 1_000]], [[10.01, 1]]),
      makeBook([[10, 1]], [[10.01, 1_000]]),
    ]
    for (const book of books) {
      const r = orderBookImbalance(book, 0.01)
      expect(r.imbalance).toBeGreaterThanOrEqual(-1)
      expect(r.imbalance).toBeLessThanOrEqual(1)
      expect(r.buyPressure + r.sellPressure).toBeCloseTo(1, 12)
    }
  })

  it('rejects a non-positive depthPct', () => {
    expect(() => orderBookImbalance(symmetricBook(), 0)).toThrow(/depthPct/)
  })
})

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

describe('detectWalls', () => {
  it('finds a level that dwarfs the local median', () => {
    const bids: [number, number][] = []
    for (let i = 0; i < 10; i++) bids.push([99.9 - i * 0.1, 4])
    bids[5] = [99.4, 40] // 10× the median of 4
    const walls = detectWalls(makeBook(bids, [[100.1, 4]]), { minMultiple: 5, minLevels: 5 })
    expect(walls).toHaveLength(1)
    expect(walls[0]?.price).toBeCloseTo(99.4, 10)
    expect(walls[0]?.side).toBe('bid')
    expect(walls[0]?.multiple).toBeCloseTo(10, 10)
    expect(walls[0]?.distancePct).toBeCloseTo(0.6 / 100, 4)
  })

  it('uses the median so a single giant level cannot hide behind its own mean', () => {
    // With a mean-based threshold, one 100× level lifts the reference enough
    // that its own multiple falls under 5 and it is missed entirely.
    const asks: [number, number][] = []
    for (let i = 0; i < 12; i++) asks.push([100.1 + i * 0.1, 2])
    asks[3] = [100.4, 200] // 100× the median, but only ~11× the mean
    const walls = detectWalls(makeBook([[99.9, 2]], asks), { minMultiple: 5, minLevels: 5 })
    expect(walls.map((w) => w.price)).toContain(100.4)
    expect(walls[0]?.multiple ?? 0).toBeGreaterThan(50)
  })

  it('finds nothing in a uniform book', () => {
    expect(detectWalls(symmetricBook(100, 20, 0.05, 5))).toEqual([])
  })

  it('ignores levels beyond depthPct', () => {
    const bids: [number, number][] = []
    for (let i = 0; i < 10; i++) bids.push([99.9 - i * 0.1, 4])
    bids.push([50, 100_000]) // enormous, but 50% away
    expect(detectWalls(makeBook(bids, [[100.1, 4]]), { depthPct: 0.05 })).toEqual([])
  })

  it('needs enough levels for a median to mean anything', () => {
    expect(detectWalls(makeBook([[99, 1_000]], [[101, 1]]), { minLevels: 5 })).toEqual([])
  })

  it('returns walls sorted nearest-first', () => {
    const bids: [number, number][] = []
    for (let i = 0; i < 12; i++) bids.push([99.9 - i * 0.1, 3])
    bids[1] = [99.8, 60]
    bids[9] = [99.0, 90]
    const walls = detectWalls(makeBook(bids, [[100.1, 3]]), { minLevels: 5 })
    expect(walls).toHaveLength(2)
    expect(walls[0]?.distancePct ?? 1).toBeLessThan(walls[1]?.distancePct ?? 0)
  })

  it('returns nothing for an empty book', () => {
    expect(detectWalls(makeBook([], []))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Depth score
// ---------------------------------------------------------------------------

describe('bookDepthScore', () => {
  it('always lies within [0,1]', () => {
    const books = [
      symmetricBook(100, 40, 0.005, 5),
      symmetricBook(100, 2, 1, 5),
      makeBook([[99, 1]], [[101, 1_000]]),
      makeBook([], []),
    ]
    for (const book of books) {
      const score = bookDepthScore(book)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  it('scores a deep, tight, balanced book above a thin, wide one', () => {
    const deep = symmetricBook(100, 40, 0.005, 5)
    const thin = makeBook(
      [[99, 5]],
      [[101, 5]],
    )
    expect(bookDepthScore(deep)).toBeGreaterThan(bookDepthScore(thin))
  })

  it('penalises depth concentrated in a single level', () => {
    const spread: [number, number][] = []
    const lumpy: [number, number][] = []
    for (let i = 0; i < 20; i++) {
      spread.push([99.99 - i * 0.001, 5])
      lumpy.push([99.99 - i * 0.001, i === 0 ? 100 : 0.01])
    }
    const asks: [number, number][] = []
    for (let i = 0; i < 20; i++) asks.push([100.01 + i * 0.001, 5])
    expect(bookDepthScore(makeBook(spread, asks))).toBeGreaterThan(
      bookDepthScore(makeBook(lumpy, asks)),
    )
  })

  it('scores an empty or one-sided book at 0', () => {
    expect(bookDepthScore(makeBook([], []))).toBe(0)
    expect(bookDepthScore(makeBook([[99, 10]], []))).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Executed flow
// ---------------------------------------------------------------------------

describe('aggressorImbalance', () => {
  it('returns NULL when the venue never reports taker volume', () => {
    // The single most important behaviour in this module: a venue that does not
    // publish taker side yields "unknown", which becomes a model abstention —
    // never a guess reverse-engineered from price.
    const candles = randomWalkCandles(50, { seed: 131, withTaker: false })
    expect(candles.every((c) => c.takerBuyVolume === null)).toBe(true)
    expect(aggressorImbalance(candles)).toBeNull()
  })

  it('returns null for an empty series', () => {
    expect(aggressorImbalance([])).toBeNull()
  })

  it('matches a hand-computed imbalance', () => {
    // volumes 100/200/300 with taker buy 80/50/150
    //   buy  = 280, sell = (20 + 150 + 150) = 320
    //   imbalance = (280 − 320)/600 = −0.0666…, buyRatio = 280/600 = 0.4666…
    const candles = [
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 100, takerBuyVolume: 80 }, 0),
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 200, takerBuyVolume: 50 }, 1),
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 300, takerBuyVolume: 150 }, 2),
    ]
    const flow = aggressorImbalance(candles)
    expect(flow).not.toBeNull()
    expect(flow?.buyVolume).toBe(280)
    expect(flow?.sellVolume).toBe(320)
    expect(flow?.imbalance ?? 0).toBeCloseTo(-40 / 600, 12)
    expect(flow?.buyRatio ?? 0).toBeCloseTo(280 / 600, 12)
    expect(flow?.coverage).toBe(1)
    expect(flow?.candlesUsed).toBe(3)
  })

  it('reads +1 when every trade was buyer-initiated and −1 when none were', () => {
    const allBuy = [
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 100, takerBuyVolume: 100 }, 0),
    ]
    const allSell = [
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 100, takerBuyVolume: 0 }, 0),
    ]
    expect(aggressorImbalance(allBuy)?.imbalance).toBe(1)
    expect(aggressorImbalance(allSell)?.imbalance).toBe(-1)
  })

  it('reports partial coverage instead of rejecting the window', () => {
    const candles = [
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 100, takerBuyVolume: 60 }, 0),
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 100, takerBuyVolume: null }, 1),
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 100, takerBuyVolume: null }, 2),
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 100, takerBuyVolume: 60 }, 3),
    ]
    const flow = aggressorImbalance(candles)
    expect(flow?.coverage).toBe(0.5)
    expect(flow?.candlesUsed).toBe(2)
    expect(flow?.buyVolume).toBe(120)
  })

  it('clamps venue rounding where taker volume exceeds total volume', () => {
    const candles = [
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 100, takerBuyVolume: 140 }, 0),
    ]
    const flow = aggressorImbalance(candles)
    expect(flow?.buyVolume).toBe(100)
    expect(flow?.sellVolume).toBe(0)
    expect(flow?.imbalance).toBe(1)
  })

  it('is neutral rather than NaN when the window traded nothing', () => {
    const candles = [
      makeCandle({ open: 1, high: 1, low: 1, close: 1, volume: 0, takerBuyVolume: 0 }, 0),
    ]
    const flow = aggressorImbalance(candles)
    expect(flow?.imbalance).toBe(0)
    expect(flow?.buyRatio).toBe(0.5)
  })

  it('always produces an imbalance within [−1, 1] on generated data', () => {
    for (const seed of [141, 142, 143]) {
      const flow = aggressorImbalance(randomWalkCandles(200, { seed, withTaker: true }))
      expect(flow).not.toBeNull()
      expect(flow?.imbalance ?? 2).toBeGreaterThanOrEqual(-1)
      expect(flow?.imbalance ?? 2).toBeLessThanOrEqual(1)
      expect(flow?.coverage).toBe(1)
    }
  })
})
