import { describe, expect, it } from 'vitest'

import {
  adx,
  atr,
  bollingerBands,
  cci,
  crossovers,
  ema,
  macd,
  momentum,
  moneyFlowIndex,
  obv,
  roc,
  rollingStdDev,
  rollingVwap,
  rsi,
  sessionVwap,
  sma,
  standardDeviation,
  stochastic,
  stochasticRsi,
  trueRange,
  williamsR,
  wma,
} from '@/engines/crypto/indicators'

import {
  candlesFromCloses,
  flatCandles,
  makeCandle,
  randomWalkCandles,
  randomWalkCloses,
} from './fixtures'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** The worked series used for every hand-computed moving-average expectation. */
const RAMP = [1, 2, 3, 4, 5]

/**
 * Wilder's own worked example (the series reproduced in every RSI reference,
 * including StockCharts' table). Published RSI(14) values begin 70.53, 66.32,
 * 66.55, 69.41 — used here as an independent cross-check that our Wilder
 * smoothing matches the canonical implementation rather than the simple-average
 * impostor.
 */
const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
  46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35,
  44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
]

/**
 * Five candles used for the hand-computed true range / ATR expectations.
 *
 *   i  open  high   low   close
 *   0    9    10     8      9
 *   1   10    11     9     10.5
 *   2   11    12    10     11
 *   3   11    11.5   9.5   10
 *   4   11    13    10     12.5
 *
 * True range (max of high−low, |high−prevClose|, |low−prevClose|):
 *   TR[0] = null   (no previous close — see the trueRange docstring)
 *   TR[1] = max(2, |11−9|=2,      |9−9|=0)      = 2
 *   TR[2] = max(2, |12−10.5|=1.5, |10−10.5|=0.5) = 2
 *   TR[3] = max(2, |11.5−11|=0.5, |9.5−11|=1.5)  = 2
 *   TR[4] = max(3, |13−10|=3,     |10−10|=0)     = 3
 *
 * ATR(3): seed = mean(TR[1..3]) = (2+2+2)/3 = 2 at index 3, then Wilder:
 *   ATR[4] = (2·(3−1) + 3)/3 = 7/3 = 2.333…
 */
const TR_CANDLES = [
  makeCandle({ open: 9, high: 10, low: 8, close: 9 }, 0),
  makeCandle({ open: 10, high: 11, low: 9, close: 10.5 }, 1),
  makeCandle({ open: 11, high: 12, low: 10, close: 11 }, 2),
  makeCandle({ open: 11, high: 11.5, low: 9.5, close: 10 }, 3),
  makeCandle({ open: 11, high: 13, low: 10, close: 12.5 }, 4),
]

/** Counts the leading nulls of an aligned indicator series. */
function nullPrefixLength(series: readonly (number | null)[]): number {
  let i = 0
  while (i < series.length && series[i] === null) i++
  return i
}

function defined(series: readonly (number | null)[]): number[] {
  return series.filter((v): v is number => v !== null)
}

// ---------------------------------------------------------------------------
// Moving averages
// ---------------------------------------------------------------------------

describe('sma', () => {
  it('matches hand-computed values', () => {
    // [1,2,3,4,5] period 3 → (1+2+3)/3=2, (2+3+4)/3=3, (3+4+5)/3=4
    expect(sma(RAMP, 3)).toEqual([null, null, 2, 3, 4])
  })

  it('has a null prefix of exactly period - 1', () => {
    for (const period of [1, 2, 5, 14, 20]) {
      const series = sma(randomWalkCloses(60, { seed: 1 }), period)
      expect(nullPrefixLength(series)).toBe(period - 1)
      expect(series).toHaveLength(60)
    }
  })

  it('is the identity for period 1', () => {
    expect(sma(RAMP, 1)).toEqual(RAMP)
  })

  it('returns all nulls rather than throwing when data is insufficient', () => {
    expect(sma([1, 2], 5)).toEqual([null, null])
    expect(sma([], 5)).toEqual([])
  })

  it('reproduces a constant series exactly', () => {
    expect(sma([7, 7, 7, 7], 2)).toEqual([null, 7, 7, 7])
  })
})

describe('ema', () => {
  it('matches hand-computed values seeded with the SMA', () => {
    // period 3 ⇒ k = 2/(3+1) = 0.5. Seed = SMA([1,2,3]) = 2 at index 2.
    //   index 3: 4·0.5 + 2·0.5 = 3
    //   index 4: 5·0.5 + 3·0.5 = 4
    expect(ema(RAMP, 3)).toEqual([null, null, 2, 3, 4])
  })

  it('seeds with the SMA of the first `period` values, not the first value', () => {
    const values = [10, 20, 30, 40, 50, 60]
    const series = ema(values, 3)
    expect(series[2]).toBeCloseTo(20, 10) // (10+20+30)/3
  })

  it('has a null prefix of exactly period - 1', () => {
    expect(nullPrefixLength(ema(randomWalkCloses(50, { seed: 2 }), 12))).toBe(11)
  })

  it('returns all nulls when data is insufficient', () => {
    expect(ema([1, 2, 3], 10)).toEqual([null, null, null])
  })

  it('converges to the constant of a constant series', () => {
    expect(defined(ema([5, 5, 5, 5, 5], 3)).every((v) => v === 5)).toBe(true)
  })
})

describe('wma', () => {
  it('matches hand-computed values', () => {
    // period 3, weights 1,2,3, denominator 6:
    //   (1·1 + 2·2 + 3·3)/6 = 14/6
    //   (2·1 + 3·2 + 4·3)/6 = 20/6
    //   (3·1 + 4·2 + 5·3)/6 = 26/6
    const series = wma(RAMP, 3)
    expect(series[0]).toBeNull()
    expect(series[1]).toBeNull()
    expect(series[2]).toBeCloseTo(14 / 6, 10)
    expect(series[3]).toBeCloseTo(20 / 6, 10)
    expect(series[4]).toBeCloseTo(26 / 6, 10)
  })

  it('weights the most recent value most heavily', () => {
    // A jump on the last bar must move the WMA more than the SMA.
    const values = [10, 10, 20]
    const w = wma(values, 3)[2]
    const s = sma(values, 3)[2]
    expect(w).not.toBeNull()
    expect(s).not.toBeNull()
    expect(w ?? 0).toBeGreaterThan(s ?? 0)
  })
})

// ---------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------

describe('rsi (Wilder smoothing)', () => {
  it('matches a fully hand-computed example', () => {
    // closes [10, 11, 10.5, 11.5, 12], period 3.
    // changes: +1, −0.5, +1, +0.5
    // seed (first 3 changes): avgGain = (1+0+1)/3 = 2/3, avgLoss = (0+0.5+0)/3 = 1/6
    //   RS = (2/3)/(1/6) = 4 ⇒ RSI = 100 − 100/5 = 80          (index 3)
    // next change +0.5:
    //   avgGain = (2/3·2 + 0.5)/3 = 11/18, avgLoss = (1/6·2 + 0)/3 = 1/9
    //   RS = (11/18)/(1/9) = 5.5 ⇒ RSI = 100 − 100/6.5 = 84.6153846…  (index 4)
    const series = rsi([10, 11, 10.5, 11.5, 12], 3)
    expect(series.slice(0, 3)).toEqual([null, null, null])
    expect(series[3]).toBeCloseTo(80, 10)
    expect(series[4]).toBeCloseTo(100 - 100 / 6.5, 10)
  })

  it("reproduces Wilder's worked example, hand-derived from the seed", () => {
    // Seed window = the 14 changes from close[0] to close[14]:
    //   gains:  0.06, 0.72, 0.50, 0.27, 0.32, 0.42, 0.24, 0.14, 0.67  (sum 3.34)
    //   losses: 0.25, 0.54, 0.19, 0.42                                (sum 1.40)
    //   one unchanged bar (46.28 → 46.28) counts on neither side.
    //   avgGain = 3.34/14 = 0.23857142857, avgLoss = 1.40/14 = 0.1
    //   RSI = 100·avgGain/(avgGain + avgLoss) = 23.857142857/0.33857142857
    //       = 70.464135021…
    const series = rsi(WILDER_CLOSES, 14)
    expect(series[14]).toBeCloseTo((100 * (3.34 / 14)) / (3.34 / 14 + 1.4 / 14), 9)
    expect(series[14]).toBeCloseTo(70.464135, 5)

    // Next bar: change = 46.00 − 46.28 = −0.28.
    //   avgGain = 0.23857142857·13/14            = 0.22153061224
    //   avgLoss = (0.1·13 + 0.28)/14             = 0.11285714286
    //   RSI = 100·0.22153061224/0.33438775510    = 66.249619…
    expect(series[15]).toBeCloseTo(66.249619, 5)
    expect(series[16]).toBeCloseTo(66.480942, 5)
    expect(series[17]).toBeCloseTo(69.346853, 5)

    // The widely republished table for this series prints 70.53 / 66.32 / 66.55
    // / 69.41 — about 0.07 higher, a difference that decays with each Wilder
    // step and therefore comes from a rounded seed average in the reference,
    // not from a different smoothing. Asserted loosely so a genuine departure
    // from the canonical curve (e.g. losing Wilder smoothing entirely, which
    // moves values by whole points) still fails.
    expect(series[14]).toBeCloseTo(70.53, 0)
    expect(series[17]).toBeCloseTo(69.41, 0)
  })

  it('differs from a naive simple-average RSI (guards against the classic bug)', () => {
    // A simple moving average of gains/losses over the same window gives a
    // materially different number; if these ever agree, Wilder smoothing was lost.
    const series = rsi(WILDER_CLOSES, 14)
    const changes = WILDER_CLOSES.slice(1).map((c, i) => c - (WILDER_CLOSES[i] ?? c))
    const last14 = changes.slice(-14)
    const naiveGain = last14.filter((c) => c > 0).reduce((a, b) => a + b, 0) / 14
    const naiveLoss = last14.filter((c) => c < 0).reduce((a, b) => a - b, 0) / 14
    const naive = 100 - 100 / (1 + naiveGain / naiveLoss)
    expect(Math.abs((series[series.length - 1] ?? 0) - naive)).toBeGreaterThan(1)
  })

  it('has a null prefix of exactly `period` (needs period changes, so period+1 prices)', () => {
    for (const period of [2, 5, 14]) {
      expect(nullPrefixLength(rsi(randomWalkCloses(80, { seed: 3 }), period))).toBe(period)
    }
  })

  it('returns 50 for a perfectly constant series (documented flat-market convention)', () => {
    const series = rsi(new Array<number>(30).fill(100), 14)
    expect(defined(series).every((v) => v === 50)).toBe(true)
  })

  it('returns 100 for a monotonically rising series and 0 for a falling one', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i)
    const falling = Array.from({ length: 30 }, (_, i) => 100 - i)
    expect(defined(rsi(rising, 14)).every((v) => v === 100)).toBe(true)
    expect(defined(rsi(falling, 14)).every((v) => v === 0)).toBe(true)
  })

  it('always lies within [0, 100]', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const v of defined(rsi(randomWalkCloses(300, { seed, stepPct: 0.08 }), 14))) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(100)
      }
    }
  })

  it('returns all nulls when data is insufficient', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null])
  })
})

// ---------------------------------------------------------------------------
// MACD
// ---------------------------------------------------------------------------

describe('macd', () => {
  const closes = randomWalkCloses(120, { seed: 11 })

  it('keeps every output aligned to the input length', () => {
    const { macd: line, signal, histogram } = macd(closes)
    expect(line).toHaveLength(closes.length)
    expect(signal).toHaveLength(closes.length)
    expect(histogram).toHaveLength(closes.length)
  })

  it('starts the MACD line at slowPeriod - 1 and the signal signalPeriod - 1 later', () => {
    const { macd: line, signal } = macd(closes, 12, 26, 9)
    expect(nullPrefixLength(line)).toBe(25)
    expect(nullPrefixLength(signal)).toBe(25 + 8)
  })

  it('satisfies histogram = macd - signal wherever both are defined', () => {
    const { macd: line, signal, histogram } = macd(closes)
    for (let i = 0; i < closes.length; i++) {
      const m = line[i]
      const s = signal[i]
      const h = histogram[i]
      if (m === null || m === undefined || s === null || s === undefined) {
        expect(h ?? null).toBeNull()
        continue
      }
      expect(h ?? NaN).toBeCloseTo(m - s, 10)
    }
  })

  it('is identically zero for a constant series', () => {
    const flat = new Array<number>(80).fill(42)
    const { macd: line, histogram } = macd(flat)
    expect(defined(line).every((v) => Math.abs(v) < 1e-12)).toBe(true)
    expect(defined(histogram).every((v) => Math.abs(v) < 1e-12)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Bollinger
// ---------------------------------------------------------------------------

describe('bollingerBands', () => {
  it('matches hand-computed values', () => {
    // [1,2,3,4,5], period 3, multiplier 2. At index 2 the window is [1,2,3]:
    //   mean = 2, population sd = sqrt(((−1)²+0²+1²)/3) = sqrt(2/3) = 0.8164966
    //   upper = 2 + 2·0.8164966 = 3.6329932
    //   lower = 2 − 2·0.8164966 = 0.3670068
    //   bandwidth = (upper − lower)/middle = 4·0.8164966/2 = 1.6329932
    //   %B = (3 − 0.3670068)/(3.6329932 − 0.3670068) = 0.8061862
    const bands = bollingerBands(RAMP, 3, 2)
    const sd = Math.sqrt(2 / 3)
    expect(bands.middle[2]).toBeCloseTo(2, 10)
    expect(bands.upper[2]).toBeCloseTo(2 + 2 * sd, 10)
    expect(bands.lower[2]).toBeCloseTo(2 - 2 * sd, 10)
    expect(bands.bandwidth[2]).toBeCloseTo((4 * sd) / 2, 10)
    expect(bands.percentB[2]).toBeCloseTo((3 - (2 - 2 * sd)) / (4 * sd), 10)
  })

  it('always satisfies upper >= middle >= lower', () => {
    for (const seed of [7, 8, 9]) {
      const bands = bollingerBands(randomWalkCloses(200, { seed, stepPct: 0.05 }), 20, 2)
      for (let i = 0; i < 200; i++) {
        const u = bands.upper[i]
        const m = bands.middle[i]
        const l = bands.lower[i]
        if (u === null || u === undefined) continue
        if (m === null || m === undefined) continue
        if (l === null || l === undefined) continue
        expect(u).toBeGreaterThanOrEqual(m)
        expect(m).toBeGreaterThanOrEqual(l)
      }
    }
  })

  it('collapses to zero bandwidth and %B = 0.5 on a constant series', () => {
    const bands = bollingerBands(new Array<number>(40).fill(250), 20)
    expect(defined(bands.bandwidth).every((v) => v === 0)).toBe(true)
    expect(defined(bands.percentB).every((v) => v === 0.5)).toBe(true)
  })

  it('reports %B above 1 when price closes above the upper band', () => {
    // 19 flat bars then a spike: the last close is far outside the band.
    const values = [...new Array<number>(19).fill(100), 130]
    const bands = bollingerBands(values, 20, 2)
    const pb = bands.percentB[19]
    expect(pb).not.toBeNull()
    expect(pb ?? 0).toBeGreaterThan(1)
  })

  it('produces bandwidth that is comparable across price scales', () => {
    // The same relative price path at $0.15 and at $118,000 must yield the same
    // bandwidth — that is the entire point of normalising by the middle band.
    const shape = randomWalkCloses(60, { seed: 21, start: 1, stepPct: 0.02 })
    const cheap = bollingerBands(shape.map((v) => v * 0.15), 20)
    const rich = bollingerBands(shape.map((v) => v * 118_000), 20)
    for (let i = 0; i < shape.length; i++) {
      const a = cheap.bandwidth[i]
      const b = rich.bandwidth[i]
      if (a === null || a === undefined || b === null || b === undefined) continue
      expect(a).toBeCloseTo(b, 8)
    }
  })
})

// ---------------------------------------------------------------------------
// Range / ATR / ADX
// ---------------------------------------------------------------------------

describe('trueRange', () => {
  it('is null on the first bar (no previous close to gap from)', () => {
    expect(trueRange(TR_CANDLES)[0]).toBeNull()
  })

  it('matches hand-computed values', () => {
    expect(trueRange(TR_CANDLES)).toEqual([null, 2, 2, 2, 3])
  })

  it('is zero for a flat market', () => {
    expect(defined(trueRange(flatCandles(10))).every((v) => v === 0)).toBe(true)
  })
})

describe('atr (Wilder smoothing)', () => {
  it('matches hand-computed values', () => {
    const series = atr(TR_CANDLES, 3)
    expect(series.slice(0, 3)).toEqual([null, null, null])
    expect(series[3]).toBeCloseTo(2, 10) // seed = mean(TR[1..3])
    expect(series[4]).toBeCloseTo(7 / 3, 10) // (2·2 + 3)/3
  })

  it('has a null prefix of exactly `period` (true range starts at index 1)', () => {
    expect(nullPrefixLength(atr(randomWalkCandles(80, { seed: 5 }), 14))).toBe(14)
  })

  it('is exactly zero for a flat market', () => {
    expect(defined(atr(flatCandles(40), 14)).every((v) => v === 0)).toBe(true)
  })

  it('returns all nulls when data is insufficient', () => {
    expect(atr(randomWalkCandles(10, { seed: 6 }), 14).every((v) => v === null)).toBe(true)
  })

  it('is always non-negative', () => {
    for (const v of defined(atr(randomWalkCandles(200, { seed: 7, stepPct: 0.06 }), 14))) {
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('adx', () => {
  it('first defines ADX at index 2·period − 1', () => {
    const { adx: series } = adx(randomWalkCandles(120, { seed: 12 }), 14)
    expect(nullPrefixLength(series)).toBe(27)
  })

  it('keeps ADX and both DI lines within [0, 100]', () => {
    for (const seed of [13, 14, 15]) {
      const out = adx(randomWalkCandles(250, { seed, stepPct: 0.07 }), 14)
      for (const series of [out.adx, out.plusDI, out.minusDI]) {
        for (const v of defined(series)) {
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(100)
        }
      }
    }
  })

  it('puts +DI above −DI in a clean uptrend and reads a strong trend', () => {
    const closeSeries = Array.from({ length: 80 }, (_, i) => 100 * 1.01 ** i)
    const out = adx(candlesFromCloses(closeSeries), 14)
    const last = out.adx.length - 1
    expect(out.plusDI[last] ?? 0).toBeGreaterThan(out.minusDI[last] ?? 100)
    expect(out.adx[last] ?? 0).toBeGreaterThan(40)
  })

  it('is direction agnostic: a mirrored downtrend reads a comparable ADX', () => {
    const up = candlesFromCloses(Array.from({ length: 80 }, (_, i) => 100 * 1.01 ** i))
    const down = candlesFromCloses(Array.from({ length: 80 }, (_, i) => 100 * 0.99 ** i))
    const upAdx = adx(up, 14).adx[79] ?? 0
    const downAdx = adx(down, 14).adx[79] ?? 0
    expect(Math.abs(upAdx - downAdx)).toBeLessThan(10)
    expect(adx(down, 14).minusDI[79] ?? 0).toBeGreaterThan(adx(down, 14).plusDI[79] ?? 100)
  })

  it('returns all nulls when data is insufficient', () => {
    const out = adx(randomWalkCandles(20, { seed: 16 }), 14)
    expect(out.adx.every((v) => v === null)).toBe(true)
    expect(out.plusDI.every((v) => v === null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Stochastics
// ---------------------------------------------------------------------------

describe('stochastic', () => {
  it('reads 100 at the top of the window and 0 at the bottom', () => {
    const rising = candlesFromCloses([1, 2, 3, 4, 5], { wickPct: 0 })
    const { k } = stochastic(rising, 3, 3, 1)
    // Close is the highest high of the window (wickPct 0 ⇒ high == max(open,close)).
    expect(k[4]).toBeCloseTo(100, 6)

    const falling = candlesFromCloses([5, 4, 3, 2, 1], { wickPct: 0 })
    expect(stochastic(falling, 3, 3, 1).k[4]).toBeCloseTo(0, 6)
  })

  it('reads 50 on a flat window (degenerate high == low)', () => {
    const { k, d } = stochastic(flatCandles(20), 14, 3, 1)
    expect(defined(k).every((v) => v === 50)).toBe(true)
    expect(defined(d).every((v) => v === 50)).toBe(true)
  })

  it('always lies within [0, 100]', () => {
    const { k, d } = stochastic(randomWalkCandles(200, { seed: 17, stepPct: 0.05 }), 14, 3, 3)
    for (const v of [...defined(k), ...defined(d)]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    }
  })

  it('has a %K null prefix of kPeriod − 1 when unsmoothed', () => {
    const { k } = stochastic(randomWalkCandles(60, { seed: 18 }), 14, 3, 1)
    expect(nullPrefixLength(k)).toBe(13)
  })

  it('returns all nulls when data is insufficient', () => {
    const { k } = stochastic(randomWalkCandles(5, { seed: 19 }), 14)
    expect(k.every((v) => v === null)).toBe(true)
  })
})

describe('stochasticRsi', () => {
  it('always lies within [0, 100]', () => {
    const { k, d } = stochasticRsi(randomWalkCloses(300, { seed: 20, stepPct: 0.05 }))
    for (const v of [...defined(k), ...defined(d)]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    }
  })

  it('stays aligned to the input length', () => {
    const { k, d } = stochasticRsi(randomWalkCloses(120, { seed: 22 }))
    expect(k).toHaveLength(120)
    expect(d).toHaveLength(120)
  })

  it('reaches extremes more often than plain RSI on the same series', () => {
    const closeSeries = randomWalkCloses(400, { seed: 23, stepPct: 0.03 })
    const plain = defined(rsi(closeSeries, 14)).filter((v) => v > 80 || v < 20).length
    const stoch = defined(stochasticRsi(closeSeries).k).filter((v) => v > 80 || v < 20).length
    expect(stoch).toBeGreaterThan(plain)
  })

  it('returns all nulls when data is insufficient', () => {
    const { k } = stochasticRsi(randomWalkCloses(10, { seed: 24 }))
    expect(k.every((v) => v === null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Rate of change family
// ---------------------------------------------------------------------------

describe('roc and momentum', () => {
  it('match hand-computed values', () => {
    // [10, 11, 12, 15], period 2:
    //   roc[2] = (12−10)/10·100 = 20, roc[3] = (15−11)/11·100 = 36.3636…
    //   momentum[2] = 2, momentum[3] = 4
    const values = [10, 11, 12, 15]
    const r = roc(values, 2)
    expect(r[0]).toBeNull()
    expect(r[1]).toBeNull()
    expect(r[2]).toBeCloseTo(20, 10)
    expect(r[3]).toBeCloseTo((4 / 11) * 100, 10)
    expect(momentum(values, 2)).toEqual([null, null, 2, 4])
  })

  it('is zero for a constant series', () => {
    expect(defined(roc(new Array<number>(10).fill(3), 3)).every((v) => v === 0)).toBe(true)
    expect(defined(momentum(new Array<number>(10).fill(3), 3)).every((v) => v === 0)).toBe(true)
  })

  it('returns null rather than Infinity when the reference price is zero', () => {
    expect(roc([0, 0, 5, 6], 2)[2]).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Dispersion
// ---------------------------------------------------------------------------

describe('standardDeviation and rollingStdDev', () => {
  it('matches hand-computed population and sample deviations', () => {
    // [2,4,4,4,5,5,7,9] — the textbook example. mean = 5,
    // squared deviations sum = 9+1+1+1+0+0+4+16 = 32, population sd = sqrt(32/8) = 2
    const values = [2, 4, 4, 4, 5, 5, 7, 9]
    expect(standardDeviation(values)).toBeCloseTo(2, 10)
    expect(standardDeviation(values, 'sample')).toBeCloseTo(Math.sqrt(32 / 7), 10)
  })

  it('is zero for a constant series', () => {
    expect(standardDeviation([9, 9, 9, 9])).toBe(0)
    expect(defined(rollingStdDev([9, 9, 9, 9], 2)).every((v) => v === 0)).toBe(true)
  })

  it('keeps precision at large price levels (no catastrophic cancellation)', () => {
    // Deliberately BTC-scaled: a naive E[x²] − E[x]² would lose most digits here.
    const base = 118_000
    const values = [base - 1, base, base + 1]
    expect(standardDeviation(values)).toBeCloseTo(Math.sqrt(2 / 3), 9)
  })

  it('has a null prefix of exactly period − 1', () => {
    expect(nullPrefixLength(rollingStdDev(randomWalkCloses(50, { seed: 25 }), 20))).toBe(19)
  })
})

// ---------------------------------------------------------------------------
// CCI / Williams %R / MFI
// ---------------------------------------------------------------------------

describe('cci', () => {
  it('matches a hand-computed example', () => {
    // Typical prices for TR_CANDLES[0..2]: 9, 10.16667, 11
    //   SMA(TP,3) = 10.055556
    //   mean deviation = (1.055556 + 0.111111 + 0.944444)/3 = 0.7037037
    //   CCI = (11 − 10.055556) / (0.015 · 0.7037037) = 89.47368…
    const series = cci(TR_CANDLES.slice(0, 3), 3)
    expect(series[2]).toBeCloseTo(89.47368, 4)
  })

  it('is zero for a flat market rather than NaN', () => {
    expect(defined(cci(flatCandles(30), 20)).every((v) => v === 0)).toBe(true)
  })
})

describe('williamsR', () => {
  it('matches a hand-computed example', () => {
    // Window [0..2]: highest high 12, lowest low 8, close 11
    //   %R = −100 · (12 − 11)/(12 − 8) = −25
    expect(williamsR(TR_CANDLES.slice(0, 3), 3)[2]).toBeCloseTo(-25, 10)
  })

  it('always lies within [−100, 0]', () => {
    for (const v of defined(williamsR(randomWalkCandles(200, { seed: 26, stepPct: 0.06 }), 14))) {
      expect(v).toBeGreaterThanOrEqual(-100)
      expect(v).toBeLessThanOrEqual(0)
    }
  })

  it('reads −50 on a flat window', () => {
    expect(defined(williamsR(flatCandles(30), 14)).every((v) => v === -50)).toBe(true)
  })
})

describe('moneyFlowIndex', () => {
  it('matches a hand-computed example', () => {
    // Typical prices: 9, 10.166667, 11, 10.333333 with volumes 100/200/300/400.
    //   i=1 up   → positive 10.166667·200 = 2033.3333
    //   i=2 up   → positive 11·300         = 3300
    //   i=3 down → negative 10.333333·400  = 4133.3333
    // MFI(3) at index 3 = 100 − 100/(1 + 5333.3333/4133.3333) = 56.33803…
    const candles = [
      makeCandle({ open: 9, high: 10, low: 8, close: 9, volume: 100 }, 0),
      makeCandle({ open: 10, high: 11, low: 9, close: 10.5, volume: 200 }, 1),
      makeCandle({ open: 11, high: 12, low: 10, close: 11, volume: 300 }, 2),
      makeCandle({ open: 11, high: 11.5, low: 9.5, close: 10, volume: 400 }, 3),
    ]
    expect(moneyFlowIndex(candles, 3)[3]).toBeCloseTo(56.33803, 4)
  })

  it('always lies within [0, 100]', () => {
    for (const v of defined(moneyFlowIndex(randomWalkCandles(200, { seed: 27 }), 14))) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    }
  })

  it('reads 50 on a flat market (no money flowing either way)', () => {
    expect(defined(moneyFlowIndex(flatCandles(40), 14)).every((v) => v === 50)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

describe('obv', () => {
  it('matches a hand-computed example', () => {
    // closes 10, 11, 10, 10, 12 with volume 100 each:
    //   +100, −100, unchanged, +100 ⇒ [0, 100, 0, 0, 100]
    const candles = candlesFromCloses([10, 11, 10, 10, 12], { volume: 100 })
    expect(obv(candles)).toEqual([0, 100, 0, 0, 100])
  })

  it('is flat when price never changes', () => {
    expect(defined(obv(flatCandles(20))).every((v) => v === 0)).toBe(true)
  })
})

describe('vwap', () => {
  it('equals the price for a constant market', () => {
    expect(defined(rollingVwap(flatCandles(20), 5)).every((v) => v === 100)).toBe(true)
    expect(defined(sessionVwap(flatCandles(20))).every((v) => v === 100)).toBe(true)
  })

  it('resets the session VWAP at the anchor boundary', () => {
    // 24 hourly candles at 100 then 24 at 200; the daily session resets at 24.
    const first = candlesFromCloses(new Array<number>(24).fill(100), { wickPct: 0 })
    const second = candlesFromCloses(new Array<number>(24).fill(200), { wickPct: 0 }).map(
      (c, i) => ({ ...c, openTime: (24 + i) * 3_600_000, closeTime: (25 + i) * 3_600_000 - 1 }),
    )
    const series = sessionVwap([...first, ...second])
    expect(series[23]).toBeCloseTo(100, 6)
    // First candle of the new session: cumulative sum restarted, so exactly 200.
    expect(series[24]).toBeCloseTo(200, 6)
  })

  it('lies between the window low and high', () => {
    const candles = randomWalkCandles(100, { seed: 28 })
    const series = rollingVwap(candles, 10)
    for (let i = 9; i < candles.length; i++) {
      const v = series[i]
      if (v === null) continue
      let lo = Infinity
      let hi = -Infinity
      for (let j = i - 9; j <= i; j++) {
        const c = candles[j]
        if (c === undefined) continue
        lo = Math.min(lo, c.low)
        hi = Math.max(hi, c.high)
      }
      expect(v).toBeGreaterThanOrEqual(lo)
      expect(v).toBeLessThanOrEqual(hi)
    }
  })

  it('returns null rather than NaN when no volume traded', () => {
    const zeroVolume = candlesFromCloses([1, 2, 3, 4, 5], { volume: 0 })
    expect(rollingVwap(zeroVolume, 3).every((v) => v === null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Crossovers
// ---------------------------------------------------------------------------

describe('crossovers', () => {
  it('signals only on the bar where the relationship flips', () => {
    const fast = [1, 2, 3, 4, 1, 0]
    const slow = [2, 2, 2, 2, 2, 2]
    // i=1: 1<=2 and 2>2? no.  i=2: 2<=2 and 3>2 ⇒ bullish.
    // i=4: 4>=2 and 1<2 ⇒ bearish. i=5: still below, no repeat.
    expect(crossovers(fast, slow)).toEqual([null, null, 'bullish', null, 'bearish', null])
  })

  it('emits nothing while one series is still warming up', () => {
    const fast = [null, null, 3, 4]
    const slow = [null, null, 2, 5]
    expect(crossovers(fast, slow)).toEqual([null, null, null, 'bearish'])
  })

  it('never signals when the series never cross', () => {
    const fast = [5, 6, 7, 8]
    const slow = [1, 2, 3, 4]
    expect(crossovers(fast, slow).every((v) => v === null)).toBe(true)
  })

  it('rejects mismatched lengths', () => {
    expect(() => crossovers([1, 2], [1])).toThrow(/equal-length/)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting properties
// ---------------------------------------------------------------------------

describe('property: every indicator is total over finite input', () => {
  const scenarios: Record<string, ReturnType<typeof randomWalkCandles>> = {
    'random walk': randomWalkCandles(300, { seed: 31, stepPct: 0.05 }),
    'violent walk': randomWalkCandles(300, { seed: 32, stepPct: 0.4 }),
    flat: flatCandles(300),
    'sub-cent asset': randomWalkCandles(300, { seed: 33, start: 0.15, stepPct: 0.05 }),
    'btc-scaled asset': randomWalkCandles(300, { seed: 34, start: 118_000, stepPct: 0.02 }),
    'zero volume': candlesFromCloses(randomWalkCloses(300, { seed: 35 }), { volume: 0 }),
  }

  for (const [name, candles] of Object.entries(scenarios)) {
    it(`produces no NaN or Infinity for the "${name}" series`, () => {
      const closeSeries = candles.map((c) => c.close)
      const macdOut = macd(closeSeries)
      const bands = bollingerBands(closeSeries, 20)
      const stoch = stochastic(candles, 14, 3, 3)
      const stochRsi = stochasticRsi(closeSeries)
      const adxOut = adx(candles, 14)

      const allSeries: (number | null)[][] = [
        sma(closeSeries, 20),
        ema(closeSeries, 20),
        wma(closeSeries, 20),
        rsi(closeSeries, 14),
        macdOut.macd,
        macdOut.signal,
        macdOut.histogram,
        bands.upper,
        bands.middle,
        bands.lower,
        bands.bandwidth,
        bands.percentB,
        trueRange(candles),
        atr(candles, 14),
        stoch.k,
        stoch.d,
        stochRsi.k,
        stochRsi.d,
        adxOut.adx,
        adxOut.plusDI,
        adxOut.minusDI,
        obv(candles),
        sessionVwap(candles),
        rollingVwap(candles, 20),
        rollingStdDev(closeSeries, 20),
        roc(closeSeries, 10),
        momentum(closeSeries, 10),
        cci(candles, 20),
        williamsR(candles, 14),
        moneyFlowIndex(candles, 14),
      ]

      for (const series of allSeries) {
        expect(series).toHaveLength(candles.length)
        for (const v of series) {
          if (v === null) continue
          expect(Number.isFinite(v)).toBe(true)
        }
      }
    })
  }
})

describe('property: aligned output prevents index drift when combining indicators', () => {
  it('lets two indicators with different warm-ups be compared at the same index', () => {
    const closeSeries = randomWalkCloses(200, { seed: 41 })
    const fast = ema(closeSeries, 12)
    const slow = ema(closeSeries, 26)
    // Both arrays describe candle i at index i — the whole point of the contract.
    expect(fast).toHaveLength(closeSeries.length)
    expect(slow).toHaveLength(closeSeries.length)
    const signals = crossovers(fast, slow)
    expect(signals).toHaveLength(closeSeries.length)
    // No signal can appear before the slower series is defined.
    for (let i = 0; i < 25; i++) expect(signals[i]).toBeNull()
  })
})
