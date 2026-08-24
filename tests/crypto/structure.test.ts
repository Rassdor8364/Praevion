import { describe, expect, it } from 'vitest'

import {
  consolidationScore,
  detectBreakout,
  fibonacciLevels,
  supportResistance,
  swingPoints,
  trendStructure,
  volumeProfile,
} from '@/engines/crypto/structure'
import type { PriceLevel } from '@/engines/crypto/structure'
import type { Candle } from '@/providers/types'

import {
  candlesFromCloses,
  flatCandles,
  makeCandle,
  randomWalkCandles,
  randomWalkCloses,
} from './fixtures'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Candles built directly from a high series (low = high − 1, body in between).
 *
 * Built explicitly rather than derived from closes because `candlesFromCloses`
 * makes high[i] = max(open, close), which puts an identical high on the bar
 * before and the bar after every turn. `swingPoints` rejects plateaus by design,
 * so such a series legitimately contains no swings at all — a fine property for
 * the engine, a useless one for a fixture that needs known turning points.
 */
function candlesFromHighs(highs: readonly number[], lowFactor = 0.99, volume = 1_000): Candle[] {
  return highs.map((high, i) => {
    const low = high * lowFactor
    const mid = (high + low) / 2
    return makeCandle({ open: mid, high, low, close: mid, volume }, i)
  })
}

/**
 * A clean zigzag with strictly unique turning points: peaks at 2, 6, 10 and
 * troughs at 4, 8 (index 0 and 12 are troughs too but sit inside the lookback
 * margin, so they cannot be confirmed).
 */
const ZIGZAG_HIGHS = [10, 11, 12, 11, 10, 11, 12, 11, 10, 11, 12, 11, 10]

/**
 * A repeating five-bar wave whose base is set per cycle, giving strictly
 * ordered swing highs and lows across cycles.
 */
function waveCandles(bases: readonly number[], wave: readonly number[]): Candle[] {
  const highs: number[] = []
  for (const base of bases) for (const off of wave) highs.push(base * (1 + off))
  return candlesFromHighs(highs)
}

/** Repeats one relative shape at an arbitrary price scale. */
function scaled(shape: readonly number[], scale: number): number[] {
  return shape.map((v) => v * scale)
}

/**
 * Four approaches to `level` from below, each rejected. Peaks land within 0.05%
 * of each other, so a 1% cluster tolerance merges them into one level; the
 * intervening bars stay 1.5%+ away, comfortably outside the band.
 */
function levelTestCandles(level: number): Candle[] {
  const peakOffsets = [-0.0012, -0.0008, -0.001, -0.0009]
  const highs: number[] = []
  for (const peak of peakOffsets) {
    for (const off of [-0.03, -0.015, peak, -0.015, -0.03]) highs.push(level * (1 + off))
  }
  return candlesFromHighs(highs, 0.95)
}

// ---------------------------------------------------------------------------
// Swing points
// ---------------------------------------------------------------------------

describe('swingPoints', () => {
  it('finds the fractal highs and lows of a clean zigzag', () => {
    const swings = swingPoints(candlesFromHighs(ZIGZAG_HIGHS), 2)
    const highs = swings.filter((s) => s.type === 'high').map((s) => s.index)
    const lows = swings.filter((s) => s.type === 'low').map((s) => s.index)
    expect(highs).toEqual([2, 6, 10])
    expect(lows).toEqual([4, 8])
  })

  it('rejects plateaus: an equal neighbouring high is not a swing', () => {
    // The bar before and after the peak share its high, so nothing qualifies.
    const plateau = candlesFromHighs([10, 11, 12, 12, 12, 11, 10])
    expect(swingPoints(plateau, 2)).toEqual([])
  })

  it('never marks the last `lookback` bars (right-hand confirmation missing)', () => {
    const candles = candlesFromHighs(ZIGZAG_HIGHS)
    for (const lookback of [1, 2, 3]) {
      for (const s of swingPoints(candles, lookback)) {
        expect(s.index).toBeGreaterThanOrEqual(lookback)
        expect(s.index).toBeLessThan(candles.length - lookback)
      }
    }
  })

  it('finds no swings on a flat series (strict comparison rejects plateaus)', () => {
    expect(swingPoints(flatCandles(40), 2)).toEqual([])
  })

  it('returns an empty list when there are not enough bars', () => {
    expect(swingPoints(candlesFromCloses([1, 2, 3]), 2)).toEqual([])
  })

  it('reports the swing price from the high/low, not the close', () => {
    const candles = candlesFromHighs(ZIGZAG_HIGHS)
    for (const s of swingPoints(candles, 2)) {
      const c = candles[s.index]
      expect(c).toBeDefined()
      expect(s.price).toBe(s.type === 'high' ? c?.high : c?.low)
    }
  })

  it('rejects a non-positive lookback', () => {
    expect(() => swingPoints(flatCandles(10), 0)).toThrow(/positive integer/)
  })
})

// ---------------------------------------------------------------------------
// Trend structure
// ---------------------------------------------------------------------------

describe('trendStructure', () => {
  const RISING_BASES = [100, 104, 108.16, 112.4864, 116.985_856]
  const FALLING_BASES = [100, 96, 92.16, 88.4736, 84.934_656]
  const UP_WAVE = [0, 0.03, 0.06, 0.03, 0.01]
  const DOWN_WAVE = [0, -0.03, -0.06, -0.03, -0.01]

  it('labels a rising staircase HH-HL', () => {
    // Each cycle steps the whole wave 4% higher, so both the peaks (offset
    // +0.06, one per cycle) and the troughs (offset +0.01) step up in lockstep.
    const result = trendStructure(waveCandles(RISING_BASES, UP_WAVE), 2)
    expect(result.pattern).toBe('HH-HL')
    expect(result.strength).toBeGreaterThan(0.5)
    expect(result.lastSwingHigh).not.toBeNull()
    expect(result.lastSwingLow).not.toBeNull()
  })

  it('labels a falling staircase LH-LL', () => {
    const result = trendStructure(waveCandles(FALLING_BASES, DOWN_WAVE), 2)
    expect(result.pattern).toBe('LH-LL')
    expect(result.strength).toBeGreaterThan(0.5)
  })

  it('labels a tight, directionless oscillation as ranging', () => {
    // Bases wander by tenths of a percent with no direction; the wave gives
    // genuine swings, but they neither rise nor fall consistently.
    const bases = [100, 100.5, 100.2, 100.6, 100.1, 100.4]
    const result = trendStructure(waveCandles(bases, [0, 0.002, 0.004, 0.002, 0.001]), 2)
    expect(result.pattern).toBe('ranging')
    expect(result.strength).toBeGreaterThan(0)
  })

  it('reports ranging with zero confidence when there are too few swings', () => {
    const result = trendStructure(candlesFromHighs([1, 2, 3, 2, 1, 2, 3]), 2)
    expect(result.pattern).toBe('ranging')
    expect(result.strength).toBe(0)
  })

  it('separates a wide, mixed structure (transition) from a tight one (ranging)', () => {
    // Same mixed swing ORDER as the ranging case, but spanning ~20% of price.
    const bases = [100, 118, 104, 122, 101, 116]
    const result = trendStructure(waveCandles(bases, [0, 0.002, 0.004, 0.002, 0.001]), 2)
    expect(result.pattern).toBe('transition')
  })

  it('always returns a strength within [0, 1]', () => {
    for (const seed of [51, 52, 53, 54]) {
      const result = trendStructure(randomWalkCandles(200, { seed, stepPct: 0.05 }), 2)
      expect(result.strength).toBeGreaterThanOrEqual(0)
      expect(result.strength).toBeLessThanOrEqual(1)
      expect(['HH-HL', 'LH-LL', 'ranging', 'transition']).toContain(result.pattern)
    }
  })

  it('classifies identically at any price scale', () => {
    const shape = randomWalkCloses(200, { seed: 55, start: 1, stepPct: 0.03 })
    const cheap = trendStructure(candlesFromCloses(scaled(shape, 0.15)), 2)
    const rich = trendStructure(candlesFromCloses(scaled(shape, 118_000)), 2)
    expect(cheap.pattern).toBe(rich.pattern)
    expect(cheap.strength).toBeCloseTo(rich.strength, 6)
  })
})

// ---------------------------------------------------------------------------
// Support / resistance
// ---------------------------------------------------------------------------

describe('supportResistance', () => {
  it('recovers a repeatedly-rejected level', () => {
    const levels = supportResistance(levelTestCandles(100), { tolerancePct: 0.01 })
    expect(levels.length).toBeGreaterThan(0)
    const near = levels.find((l) => Math.abs(l.price - 100) / 100 < 0.01)
    expect(near).toBeDefined()
    expect(near?.touches ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('clusters by RELATIVE distance, so the same shape resolves identically at any price', () => {
    // This is the whole justification for percentage tolerance: an absolute
    // tolerance that works at $118,000 merges every level at $0.15 into one, and
    // one that works at $0.15 splits every level at $118,000 into fragments.
    const cheap = supportResistance(levelTestCandles(0.15), { tolerancePct: 0.01 })
    const rich = supportResistance(levelTestCandles(118_000), { tolerancePct: 0.01 })
    expect(cheap.length).toBe(rich.length)
    for (let i = 0; i < cheap.length; i++) {
      expect(cheap[i]?.touches).toBe(rich[i]?.touches)
      expect(cheap[i]?.strength ?? 0).toBeCloseTo(rich[i]?.strength ?? 1, 6)
      // Level prices scale exactly with the asset price.
      const ratio = (rich[i]?.price ?? 1) / (cheap[i]?.price ?? 1)
      expect(ratio).toBeCloseTo(118_000 / 0.15, 0)
    }
  })

  it('keeps every strength within [0,1] and every index inside the series', () => {
    const candles = randomWalkCandles(300, { seed: 61, stepPct: 0.03 })
    for (const level of supportResistance(candles)) {
      expect(level.strength).toBeGreaterThanOrEqual(0)
      expect(level.strength).toBeLessThanOrEqual(1)
      expect(level.lastTouchIndex).toBeGreaterThanOrEqual(0)
      expect(level.lastTouchIndex).toBeLessThan(candles.length)
      expect(level.touches).toBeGreaterThanOrEqual(2)
      expect(Number.isFinite(level.price)).toBe(true)
    }
  })

  it('labels levels below the last close as support and above it as resistance', () => {
    const candles = randomWalkCandles(300, { seed: 62, stepPct: 0.04 })
    const last = candles[candles.length - 1]
    expect(last).toBeDefined()
    for (const level of supportResistance(candles)) {
      expect(level.type).toBe(level.price < (last?.close ?? 0) ? 'support' : 'resistance')
    }
  })

  it('returns levels sorted by descending strength, capped at maxLevels', () => {
    const levels = supportResistance(randomWalkCandles(400, { seed: 63, stepPct: 0.03 }), {
      maxLevels: 4,
    })
    expect(levels.length).toBeLessThanOrEqual(4)
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i - 1]?.strength ?? 0).toBeGreaterThanOrEqual(levels[i]?.strength ?? 1)
    }
  })

  it('returns nothing for a flat series or an empty one', () => {
    expect(supportResistance(flatCandles(50))).toEqual([])
    expect(supportResistance([])).toEqual([])
  })

  it('honours minTouches', () => {
    const candles = randomWalkCandles(300, { seed: 64, stepPct: 0.03 })
    for (const level of supportResistance(candles, { minTouches: 3 })) {
      expect(level.touches).toBeGreaterThanOrEqual(3)
    }
  })
})

// ---------------------------------------------------------------------------
// Fibonacci
// ---------------------------------------------------------------------------

describe('fibonacciLevels', () => {
  it('places up-leg retracements below the high and extensions above it', () => {
    const levels = fibonacciLevels(200, 100, 'up')
    const retracements = levels.filter((l) => l.kind === 'retracement')
    const extensions = levels.filter((l) => l.kind === 'extension')

    expect(retracements.map((l) => l.ratio)).toEqual([0.236, 0.382, 0.5, 0.618, 0.786])
    // range = 100, so the 0.5 retracement of a 100→200 leg is exactly 150.
    expect(retracements.find((l) => l.ratio === 0.5)?.price).toBeCloseTo(150, 10)
    expect(retracements.find((l) => l.ratio === 0.236)?.price).toBeCloseTo(176.4, 10)
    expect(retracements.find((l) => l.ratio === 0.618)?.price).toBeCloseTo(138.2, 10)

    for (const l of retracements) {
      expect(l.price).toBeGreaterThan(100)
      expect(l.price).toBeLessThan(200)
    }
    expect(extensions.find((l) => l.ratio === 1.272)?.price).toBeCloseTo(227.2, 10)
    expect(extensions.find((l) => l.ratio === 1.618)?.price).toBeCloseTo(261.8, 10)
  })

  it('mirrors exactly for a down leg', () => {
    const levels = fibonacciLevels(200, 100, 'down')
    expect(levels.find((l) => l.ratio === 0.5)?.price).toBeCloseTo(150, 10)
    expect(levels.find((l) => l.ratio === 0.236)?.price).toBeCloseTo(123.6, 10)
    expect(levels.find((l) => l.ratio === 1.618 && l.kind === 'extension')?.price).toBeCloseTo(
      200 - 161.8,
      10,
    )
  })

  it('collapses to a single price when high == low', () => {
    for (const l of fibonacciLevels(50, 50, 'up')) expect(l.price).toBe(50)
  })

  it('rejects an inverted range', () => {
    expect(() => fibonacciLevels(100, 200, 'up')).toThrow(/high must be >= low/)
  })
})

// ---------------------------------------------------------------------------
// Volume profile
// ---------------------------------------------------------------------------

describe('volumeProfile', () => {
  const candles = randomWalkCandles(300, { seed: 71, stepPct: 0.03 })

  it('conserves total volume across the bins', () => {
    const profile = volumeProfile(candles, 24)
    const binned = profile.bins.reduce((acc, b) => acc + b.volume, 0)
    expect(binned).toBeCloseTo(profile.totalVolume, 6)
  })

  it('produces contiguous, equal-width bins covering the full range', () => {
    const profile = volumeProfile(candles, 24)
    expect(profile.bins).toHaveLength(24)
    for (let i = 1; i < profile.bins.length; i++) {
      expect(profile.bins[i]?.priceLow ?? 0).toBeCloseTo(profile.bins[i - 1]?.priceHigh ?? 1, 8)
    }
  })

  it('puts the point of control inside the value area', () => {
    const profile = volumeProfile(candles, 24)
    expect(profile.valueAreaLow).toBeLessThanOrEqual(profile.pointOfControl)
    expect(profile.valueAreaHigh).toBeGreaterThanOrEqual(profile.pointOfControl)
  })

  it('encloses at least 70% of volume in the value area', () => {
    const profile = volumeProfile(candles, 24)
    let inside = 0
    for (const b of profile.bins) {
      if (b.priceLow >= profile.valueAreaLow - 1e-9 && b.priceHigh <= profile.valueAreaHigh + 1e-9) {
        inside += b.volume
      }
    }
    expect(inside / profile.totalVolume).toBeGreaterThanOrEqual(0.7)
  })

  it('locates the point of control where trading actually concentrated', () => {
    // 60 bars pinned around 100 and 10 bars visiting 130: the POC must sit at 100.
    const path = [...new Array<number>(60).fill(100), ...new Array<number>(10).fill(130)]
    const profile = volumeProfile(candlesFromCloses(path, { wickPct: 0.001 }), 20)
    expect(Math.abs(profile.pointOfControl - 100) / 100).toBeLessThan(0.03)
  })

  it('handles a perfectly flat market with one degenerate bin', () => {
    const profile = volumeProfile(flatCandles(20, 100, 500), 24)
    expect(profile.bins).toHaveLength(1)
    expect(profile.pointOfControl).toBe(100)
    expect(profile.valueAreaHigh).toBe(100)
    expect(profile.valueAreaLow).toBe(100)
    expect(profile.totalVolume).toBe(10_000)
  })

  it('returns an empty profile for no candles', () => {
    const profile = volumeProfile([], 24)
    expect(profile.bins).toEqual([])
    expect(profile.totalVolume).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Breakouts
// ---------------------------------------------------------------------------

describe('detectBreakout', () => {
  const LEVEL: PriceLevel = {
    price: 100,
    strength: 0.8,
    type: 'resistance',
    touches: 4,
    lastTouchIndex: 10,
  }

  /** 20 quiet bars below 100, then whatever the test appends. */
  function baseCandles(): Candle[] {
    const out: Candle[] = []
    for (let i = 0; i < 20; i++) {
      out.push(makeCandle({ open: 98, high: 99, low: 97, close: 98, volume: 1_000 }, i))
    }
    return out
  }

  it('reports a breakout on a close beyond the level with volume', () => {
    const candles = [
      ...baseCandles(),
      makeCandle({ open: 98, high: 103, low: 98, close: 102, volume: 4_000 }, 20),
    ]
    const signal = detectBreakout(candles, [LEVEL])
    expect(signal.type).toBe('breakout')
    expect(signal.confirmedByVolume).toBe(true)
    expect(signal.level?.price).toBe(100)
    expect(signal.strength).toBeGreaterThan(0)
    expect(signal.strength).toBeLessThanOrEqual(1)
  })

  it('does NOT report a breakout on a wick that closes back below the level', () => {
    // This is the false-positive case wick-based detection fires on constantly:
    // price pokes 3% through resistance on huge volume and closes below it. It
    // is a rejection — often a stop run in the opposite direction — not a break.
    const candles = [
      ...baseCandles(),
      makeCandle({ open: 98, high: 103, low: 97.5, close: 98.5, volume: 6_000 }, 20),
    ]
    const signal = detectBreakout(candles, [LEVEL])
    expect(signal.type).toBe('rejection')
    expect(signal.type).not.toBe('breakout')
  })

  it('downgrades an unconfirmed break to none but still names the level probed', () => {
    const candles = [
      ...baseCandles(),
      makeCandle({ open: 98, high: 103, low: 98, close: 102, volume: 900 }, 20),
    ]
    const signal = detectBreakout(candles, [LEVEL])
    expect(signal.type).toBe('none')
    expect(signal.confirmedByVolume).toBe(false)
    expect(signal.level?.price).toBe(100)
  })

  it('reports the same break when volume confirmation is explicitly disabled', () => {
    const candles = [
      ...baseCandles(),
      makeCandle({ open: 98, high: 103, low: 98, close: 102, volume: 900 }, 20),
    ]
    const signal = detectBreakout(candles, [LEVEL], { requireVolumeConfirmation: false })
    expect(signal.type).toBe('breakout')
    expect(signal.confirmedByVolume).toBe(false)
  })

  it('reports a breakdown when price closes below a support level on volume', () => {
    const support: PriceLevel = { ...LEVEL, price: 100, type: 'support' }
    const above: Candle[] = []
    for (let i = 0; i < 20; i++) {
      above.push(makeCandle({ open: 102, high: 103, low: 101, close: 102, volume: 1_000 }, i))
    }
    const candles = [
      ...above,
      makeCandle({ open: 102, high: 102, low: 96, close: 97, volume: 5_000 }, 20),
    ]
    const signal = detectBreakout(candles, [support])
    expect(signal.type).toBe('breakdown')
    expect(signal.confirmedByVolume).toBe(true)
  })

  it('reports none when price stays inside the level', () => {
    const candles = [
      ...baseCandles(),
      makeCandle({ open: 98, high: 99.5, low: 97, close: 98.5, volume: 5_000 }, 20),
    ]
    expect(detectBreakout(candles, [LEVEL]).type).toBe('none')
  })

  it('reports none with no levels or too little history', () => {
    expect(detectBreakout(baseCandles(), []).type).toBe('none')
    expect(detectBreakout(baseCandles().slice(0, 3), [LEVEL]).type).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

describe('consolidationScore', () => {
  it('scores a tight oscillation higher than a clean trend', () => {
    const chop: number[] = []
    for (let i = 0; i < 80; i++) chop.push(100 + (i % 2 === 0 ? 0.4 : -0.4))
    const trend = Array.from({ length: 80 }, (_, i) => 100 * 1.015 ** i)

    const chopScore = consolidationScore(candlesFromCloses(chop, { wickPct: 0 }), 20)
    const trendScore = consolidationScore(candlesFromCloses(trend, { wickPct: 0 }), 20)
    expect(chopScore).toBeGreaterThan(trendScore)
    expect(chopScore).toBeGreaterThan(0.5)
    expect(trendScore).toBeLessThan(0.5)
  })

  it('always returns a value within [0, 1]', () => {
    for (const seed of [81, 82, 83, 84]) {
      const score = consolidationScore(randomWalkCandles(200, { seed, stepPct: 0.05 }), 20)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  it('scores a perfectly flat market as maximally consolidated on the range term', () => {
    // 0.75, not 1.0, and deliberately so: the path-to-range term saturates at 1
    // (zero range), while the bandwidth PERCENTILE is self-referential — a market
    // that has been flat forever is exactly average by its own history, which the
    // midpoint tie convention scores 0.5. 0.5·1 + 0.5·(1 − 0.5) = 0.75.
    expect(consolidationScore(flatCandles(60), 20)).toBeCloseTo(0.75, 9)
  })

  it('returns 0 rather than throwing when history is too short', () => {
    expect(consolidationScore(randomWalkCandles(5, { seed: 85 }), 20)).toBe(0)
  })

  it('is invariant to price scale', () => {
    const shape = randomWalkCloses(150, { seed: 86, start: 1, stepPct: 0.03 })
    const cheap = consolidationScore(candlesFromCloses(scaled(shape, 0.15)), 20)
    const rich = consolidationScore(candlesFromCloses(scaled(shape, 118_000)), 20)
    expect(cheap).toBeCloseTo(rich, 6)
  })
})
