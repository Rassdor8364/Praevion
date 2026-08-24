import { describe, expect, it } from 'vitest'

import { InsufficientDataError } from '@/core/errors'
import {
  MIN_FORECAST_CANDLES,
  PERIODS_PER_YEAR,
  annualise,
  atrPercentile,
  ewmaVolatility,
  forecastVolatility,
  garmanKlassVolatility,
  logReturns,
  parkinsonVolatility,
  percentileRank,
  realisedVolatility,
  volatilityRegime,
} from '@/engines/crypto/volatility'

import { candlesFromCloses, flatCandles, makeCandle, randomWalkCandles } from './fixtures'

function defined(series: readonly (number | null)[]): number[] {
  return series.filter((v): v is number => v !== null)
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

describe('logReturns', () => {
  it('matches hand-computed values and is one shorter than its input', () => {
    // ln(2/1) = 0.6931472, ln(4/2) = 0.6931472, ln(2/4) = −0.6931472
    const r = logReturns([1, 2, 4, 2])
    expect(r).toHaveLength(3)
    expect(r[0]).toBeCloseTo(Math.LN2, 12)
    expect(r[1]).toBeCloseTo(Math.LN2, 12)
    expect(r[2]).toBeCloseTo(-Math.LN2, 12)
  })

  it('is additive over time (the property sqrt-of-time scaling depends on)', () => {
    const values = [100, 103, 99, 107]
    const r = logReturns(values)
    const total = r.reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(Math.log(107 / 100), 12)
  })

  it('is all zeros for a constant series', () => {
    expect(logReturns([5, 5, 5, 5])).toEqual([0, 0, 0])
  })

  it('emits 0 rather than NaN or -Infinity for non-positive prices', () => {
    for (const v of logReturns([0, 1, -1, 2])) expect(Number.isFinite(v)).toBe(true)
  })

  it('returns an empty array for fewer than two values', () => {
    expect(logReturns([])).toEqual([])
    expect(logReturns([1])).toEqual([])
  })
})

describe('annualise', () => {
  it('scales by the square root of the number of periods', () => {
    expect(annualise(0.01, 365)).toBeCloseTo(0.01 * Math.sqrt(365), 12)
    // A daily sigma of 2% annualises to ~38.2%.
    expect(annualise(0.02, 365)).toBeCloseTo(0.382, 2)
  })

  it('is consistent across intervals for the same underlying volatility', () => {
    // An hourly sigma of s and a daily sigma of s·√24 must annualise identically.
    const hourly = 0.005
    const daily = hourly * Math.sqrt(24)
    expect(annualise(hourly, PERIODS_PER_YEAR['1h'] ?? 0)).toBeCloseTo(
      annualise(daily, PERIODS_PER_YEAR['1d'] ?? 0),
      6,
    )
  })

  it('rejects a non-positive period count', () => {
    expect(() => annualise(0.01, 0)).toThrow(/periodsPerYear/)
  })
})

// ---------------------------------------------------------------------------
// Estimators
// ---------------------------------------------------------------------------

describe('realisedVolatility', () => {
  it('is exactly zero for a constant series', () => {
    expect(defined(realisedVolatility(flatCandles(60), 20)).every((v) => v === 0)).toBe(true)
  })

  it('matches a hand-computed value on a two-state series', () => {
    // Closes alternate 100, 101, 100, 101… so log returns alternate ±ln(1.01).
    // Over any even window the mean is 0 and the population sd is exactly
    // ln(1.01) = 0.00995033…
    const path: number[] = []
    for (let i = 0; i < 30; i++) path.push(i % 2 === 0 ? 100 : 101)
    const series = realisedVolatility(candlesFromCloses(path), 10)
    expect(series[20] ?? 0).toBeCloseTo(Math.log(1.01), 12)
  })

  it('stays aligned to the candle array and is never negative', () => {
    const candles = randomWalkCandles(200, { seed: 91, stepPct: 0.05 })
    const series = realisedVolatility(candles, 20)
    expect(series).toHaveLength(candles.length)
    for (const v of defined(series)) expect(v).toBeGreaterThanOrEqual(0)
  })

  it('returns all nulls when data is insufficient', () => {
    expect(realisedVolatility(randomWalkCandles(5, { seed: 92 }), 20).every((v) => v === null)).toBe(
      true,
    )
  })

  it('reads higher on a more violent series', () => {
    const calm = realisedVolatility(randomWalkCandles(200, { seed: 93, stepPct: 0.005 }), 20)
    const wild = realisedVolatility(randomWalkCandles(200, { seed: 93, stepPct: 0.05 }), 20)
    expect(wild[199] ?? 0).toBeGreaterThan(calm[199] ?? 1)
  })
})

describe('ewmaVolatility', () => {
  it('is zero throughout for zero returns', () => {
    expect(ewmaVolatility(new Array<number>(50).fill(0)).every((v) => v === 0)).toBe(true)
  })

  it('follows the RiskMetrics recursion exactly', () => {
    // r = [0.02, 0.01, −0.03], λ = 0.94.
    //   σ²₀ = 0.02² = 4.0e-4
    //   σ²₁ = 0.94·4.0e-4 + 0.06·0.02² = 4.0e-4  (identical, since r₀ seeded it)
    //   σ²₂ = 0.94·4.0e-4 + 0.06·0.01² = 3.82e-4
    const out = ewmaVolatility([0.02, 0.01, -0.03], 0.94)
    expect(out[0]).toBeCloseTo(0.02, 12)
    expect(out[1]).toBeCloseTo(Math.sqrt(0.94 * 4.0e-4 + 0.06 * 4.0e-4), 12)
    expect(out[2]).toBeCloseTo(Math.sqrt(0.94 * 4.0e-4 + 0.06 * 1.0e-4), 12)
  })

  it('reacts faster with a lower lambda', () => {
    // Quiet, then a shock: a shorter memory must register more of it.
    const returns = [...new Array<number>(40).fill(0.001), 0.15, 0.001]
    const slow = ewmaVolatility(returns, 0.99)
    const fast = ewmaVolatility(returns, 0.8)

    // Before the shock, a constant return stream has both recursions pinned at
    // exactly |r| regardless of lambda — there is nothing to react to.
    expect(fast[39] ?? 0).toBeCloseTo(0.001, 15)
    expect(slow[39] ?? 0).toBeCloseTo(0.001, 15)

    // The shock enters the recursion on the step AFTER it occurs, and the
    // shorter memory absorbs far more of it.
    const last = returns.length - 1
    expect(fast[last] ?? 0).toBeGreaterThan(slow[last] ?? 0)
    expect(fast[last] ?? 0).toBeCloseTo(Math.sqrt(0.8 * 1e-6 + 0.2 * 0.15 ** 2), 12)
    expect(slow[last] ?? 0).toBeCloseTo(Math.sqrt(0.99 * 1e-6 + 0.01 * 0.15 ** 2), 12)
  })

  it('is aligned to the returns array and never negative', () => {
    const returns = logReturns(randomWalkCandles(150, { seed: 94 }).map((c) => c.close))
    const out = ewmaVolatility(returns)
    expect(out).toHaveLength(returns.length)
    for (const v of out) expect(v).toBeGreaterThanOrEqual(0)
  })

  it('rejects a lambda outside (0,1)', () => {
    expect(() => ewmaVolatility([0.01], 1)).toThrow(/lambda/)
    expect(() => ewmaVolatility([0.01], 0)).toThrow(/lambda/)
  })
})

describe('parkinsonVolatility', () => {
  it('is zero when every bar has no range', () => {
    expect(defined(parkinsonVolatility(flatCandles(40), 20)).every((v) => v === 0)).toBe(true)
  })

  it('matches the closed form on a constant-range series', () => {
    // Every bar spans exactly 1% high-to-low ⇒ σ_P = ln(1.01)/(2·√ln2).
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle({ open: 100, high: 101, low: 100, close: 100.5 }, i),
    )
    const expected = Math.log(1.01) / (2 * Math.sqrt(Math.LN2))
    expect(parkinsonVolatility(candles, 20)[29] ?? 0).toBeCloseTo(expected, 12)
  })

  it('under-reads a series whose moves happen BETWEEN bars (the jump bias)', () => {
    // Two series with the same close-to-close path. In the first, each move
    // happens inside the bar (so the range captures it); in the second the bar
    // is a doji and the whole move gaps between bars. Parkinson cannot see the
    // second at all — the documented downward bias in the presence of jumps.
    const closeSeries = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 105))
    const intrabar = closeSeries.map((close, i) => {
      const open = i === 0 ? close : (closeSeries[i - 1] ?? close)
      return makeCandle(
        { open, high: Math.max(open, close), low: Math.min(open, close), close },
        i,
      )
    })
    const gapping = closeSeries.map((close, i) =>
      makeCandle({ open: close, high: close, low: close, close }, i),
    )
    expect(parkinsonVolatility(gapping, 20)[39] ?? 1).toBe(0)
    expect(parkinsonVolatility(intrabar, 20)[39] ?? 0).toBeGreaterThan(0)
  })

  it('is aligned and non-negative on a random walk', () => {
    const candles = randomWalkCandles(200, { seed: 95, stepPct: 0.04 })
    const series = parkinsonVolatility(candles, 20)
    expect(series).toHaveLength(candles.length)
    for (const v of defined(series)) expect(v).toBeGreaterThanOrEqual(0)
  })
})

describe('garmanKlassVolatility', () => {
  it('is zero for a flat market', () => {
    expect(defined(garmanKlassVolatility(flatCandles(40), 20)).every((v) => v === 0)).toBe(true)
  })

  it('never returns NaN even when the drift correction dominates', () => {
    // open == low and close == high on every bar: 0.5·ln(h/l)² is exactly
    // cancelled-and-then-some by (2ln2 − 1)·ln(c/o)², driving the per-bar term
    // negative. The floor at 0 must hold.
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle({ open: 100, high: 110, low: 100, close: 110 }, i),
    )
    const v = garmanKlassVolatility(candles, 20)[29]
    expect(v).not.toBeNull()
    expect(Number.isFinite(v ?? NaN)).toBe(true)
    expect(v ?? -1).toBeGreaterThanOrEqual(0)
  })

  it('is aligned and non-negative on a random walk', () => {
    const candles = randomWalkCandles(200, { seed: 96, stepPct: 0.04 })
    const series = garmanKlassVolatility(candles, 20)
    expect(series).toHaveLength(candles.length)
    for (const v of defined(series)) expect(v).toBeGreaterThanOrEqual(0)
  })

  it('returns all nulls when data is insufficient', () => {
    expect(garmanKlassVolatility(randomWalkCandles(5, { seed: 97 }), 20).every((v) => v === null))
      .toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Regime
// ---------------------------------------------------------------------------

describe('percentileRank', () => {
  it('matches hand-computed ranks with midpoint tie handling', () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBeCloseTo((2 + 0.5) / 4, 12)
    expect(percentileRank([1, 2, 3, 4], 0)).toBe(0)
    expect(percentileRank([1, 2, 3, 4], 5)).toBe(1)
  })

  it('returns 0.5 for a constant history (a flat market is exactly average)', () => {
    expect(percentileRank([7, 7, 7, 7], 7)).toBe(0.5)
  })

  it('returns 0.5 for an empty history', () => {
    expect(percentileRank([], 1)).toBe(0.5)
  })
})

describe('atrPercentile', () => {
  it('always lies within [0,1]', () => {
    for (const seed of [101, 102, 103]) {
      const p = atrPercentile(randomWalkCandles(300, { seed, stepPct: 0.05 }), 14, 100)
      expect(p).not.toBeNull()
      expect(p ?? -1).toBeGreaterThanOrEqual(0)
      expect(p ?? 2).toBeLessThanOrEqual(1)
    }
  })

  it('reads 0.5 for a flat market rather than 0 or 1', () => {
    expect(atrPercentile(flatCandles(200), 14, 100)).toBe(0.5)
  })

  it('reads near the top after a volatility expansion', () => {
    const calm = randomWalkCandles(160, { seed: 104, stepPct: 0.002 })
    const wild = randomWalkCandles(40, { seed: 105, stepPct: 0.08 }).map((c, i) => ({
      ...c,
      openTime: (160 + i) * 3_600_000,
    }))
    const p = atrPercentile([...calm, ...wild], 14, 200)
    expect(p ?? 0).toBeGreaterThan(0.9)
  })

  it('returns null when there is not enough history', () => {
    expect(atrPercentile(randomWalkCandles(10, { seed: 106 }), 14, 100)).toBeNull()
  })
})

describe('volatilityRegime', () => {
  it('returns one of the four documented labels', () => {
    for (const seed of [111, 112, 113, 114]) {
      const label = volatilityRegime(randomWalkCandles(300, { seed, stepPct: 0.05 }))
      expect(['low', 'normal', 'elevated', 'extreme']).toContain(label)
    }
  })

  it('escalates when volatility breaks out of its own history', () => {
    const calm = randomWalkCandles(200, { seed: 115, stepPct: 0.002 })
    const wild = randomWalkCandles(30, { seed: 116, stepPct: 0.1 }).map((c, i) => ({
      ...c,
      openTime: (200 + i) * 3_600_000,
    }))
    expect(volatilityRegime([...calm, ...wild])).toBe('extreme')
    expect(volatilityRegime(calm)).not.toBe('extreme')
  })

  it('falls back to normal when there is no usable history', () => {
    expect(volatilityRegime(randomWalkCandles(5, { seed: 117 }))).toBe('normal')
  })
})

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

describe('forecastVolatility', () => {
  const candles = randomWalkCandles(300, { seed: 121, stepPct: 0.03 })

  it('abstains with InsufficientDataError rather than guessing', () => {
    expect(() => forecastVolatility(randomWalkCandles(10, { seed: 122 }), 1)).toThrow(
      InsufficientDataError,
    )
    expect(() =>
      forecastVolatility(randomWalkCandles(MIN_FORECAST_CANDLES - 1, { seed: 122 }), 1),
    ).toThrow(InsufficientDataError)
    expect(() =>
      forecastVolatility(randomWalkCandles(MIN_FORECAST_CANDLES, { seed: 122 }), 1),
    ).not.toThrow()
  })

  it('scales the expected move with the square root of the horizon', () => {
    const one = forecastVolatility(candles, 1)
    const four = forecastVolatility(candles, 4)
    const nine = forecastVolatility(candles, 9)
    expect(four.expectedMove).toBeCloseTo(one.expectedMove * 2, 12)
    expect(nine.expectedMove).toBeCloseTo(one.expectedMove * 3, 12)
  })

  it('reports a symmetric range around spot', () => {
    const f = forecastVolatility(candles, 4)
    expect(f.rangeLow).toBeCloseTo(-f.rangeHigh, 12)
    expect(f.rangeHigh).toBeGreaterThan(f.expectedMove) // z = 1.645 > 1σ
  })

  it('keeps confidence within [0,1] and decays it with horizon', () => {
    const short = forecastVolatility(candles, 1)
    const long = forecastVolatility(candles, 48)
    for (const f of [short, long]) {
      expect(f.confidence).toBeGreaterThanOrEqual(0)
      expect(f.confidence).toBeLessThanOrEqual(1)
    }
    expect(long.confidence).toBeLessThan(short.confidence)
  })

  it('satisfies the VolatilityForecast contract for every scenario', () => {
    const scenarios = [
      randomWalkCandles(300, { seed: 123, stepPct: 0.001 }),
      randomWalkCandles(300, { seed: 124, stepPct: 0.3 }),
      randomWalkCandles(300, { seed: 125, start: 0.15, stepPct: 0.05 }),
      randomWalkCandles(300, { seed: 126, start: 118_000, stepPct: 0.02 }),
      flatCandles(300),
    ]
    for (const series of scenarios) {
      const f = forecastVolatility(series, 6)
      expect(Number.isFinite(f.expectedMove)).toBe(true)
      expect(Number.isFinite(f.rangeLow)).toBe(true)
      expect(Number.isFinite(f.rangeHigh)).toBe(true)
      expect(f.expectedMove).toBeGreaterThanOrEqual(0)
      expect(f.rangeLow).toBeLessThanOrEqual(f.rangeHigh)
      expect(['low', 'normal', 'elevated', 'extreme']).toContain(f.regime)
      expect(f.confidence).toBeGreaterThanOrEqual(0)
      expect(f.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('forecasts zero movement for a perfectly flat market', () => {
    const f = forecastVolatility(flatCandles(200), 12)
    expect(f.expectedMove).toBe(0)
    expect(f.rangeLow).toBe(-0)
    expect(f.rangeHigh).toBe(0)
  })

  it('is invariant to price scale (returns, not prices, drive it)', () => {
    const shape = randomWalkCandles(300, { seed: 127, start: 1, stepPct: 0.03 })
    const rescale = (factor: number) =>
      shape.map((c) => ({
        ...c,
        open: c.open * factor,
        high: c.high * factor,
        low: c.low * factor,
        close: c.close * factor,
      }))
    const cheap = forecastVolatility(rescale(0.15), 4)
    const rich = forecastVolatility(rescale(118_000), 4)
    expect(cheap.expectedMove).toBeCloseTo(rich.expectedMove, 9)
    expect(cheap.regime).toBe(rich.regime)
  })

  it('forecasts a larger move for a more volatile asset', () => {
    const calm = forecastVolatility(randomWalkCandles(300, { seed: 128, stepPct: 0.003 }), 4)
    const wild = forecastVolatility(randomWalkCandles(300, { seed: 128, stepPct: 0.06 }), 4)
    expect(wild.expectedMove).toBeGreaterThan(calm.expectedMove)
  })

  it('rejects a non-positive horizon', () => {
    expect(() => forecastVolatility(candles, 0)).toThrow(/horizonPeriods/)
  })
})
