/**
 * Pure technical indicators.
 *
 * Every function here is total, deterministic and side-effect free: it takes
 * arrays of numbers (or Candles) and returns arrays of numbers. No clock, no
 * network, no randomness. That is what makes a backtest reproducible — running
 * the same series through the same function on a different day must produce
 * byte-identical output, otherwise "the model was right in backtest" means
 * nothing.
 *
 * ---------------------------------------------------------------------------
 * The alignment contract
 * ---------------------------------------------------------------------------
 * Every series-returning function returns an array of EXACTLY the same length
 * as its input, with `null` at every index where the indicator is not yet
 * defined. This is deliberate and it is the single most important convention in
 * this file.
 *
 * The alternative — returning a shorter array that starts at the first defined
 * value — is the classic silent bug generator in TA code. The moment you
 * combine two indicators with different warm-up lengths (RSI(14) warms up in 14
 * bars, MACD in 33) the shorter arrays are offset from each other by 19 bars and
 * every downstream comparison is quietly comparing today's RSI against
 * three-weeks-ago MACD. Nothing throws. The numbers all look plausible. The
 * model just learns garbage.
 *
 * With aligned output, `rsiSeries[i]` and `macdSeries[i]` always describe the
 * same candle, and "not enough data yet" is represented explicitly rather than
 * by an index shift you have to remember.
 *
 * Insufficient data is never an error here — it returns all-nulls. Indicators
 * are features; a feature that cannot be computed is a missing feature, and the
 * model layer above decides whether to abstain. Throwing would force every
 * caller into try/catch for an entirely ordinary condition.
 */

import { invariant } from '@/core/errors'
import type { Candle } from '@/providers/types'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** An array of `length` nulls — the "not computable" answer for every function. */
function nulls(length: number): (number | null)[] {
  return new Array<number | null>(length).fill(null)
}

/** Index of the first non-null entry, or -1. */
function firstDefinedIndex(series: readonly (number | null)[]): number {
  for (let i = 0; i < series.length; i++) {
    const v = series[i]
    if (v !== null && v !== undefined) return i
  }
  return -1
}

/**
 * Extract the contiguous defined tail of a warm-up-prefixed series.
 *
 * Indicator series produced by this file have the shape [null, ..., null, x, x,
 * x] — nulls only ever form a prefix. Chained indicators (signal line of MACD,
 * stochastic of RSI) need to run over just the defined part and then be padded
 * back to full length, which is what this plus `padTo` do.
 */
function definedTail(series: readonly (number | null)[]): { offset: number; values: number[] } {
  const offset = firstDefinedIndex(series)
  if (offset < 0) return { offset: -1, values: [] }
  const values: number[] = []
  for (let i = offset; i < series.length; i++) {
    const v = series[i]
    if (v === null || v === undefined) break
    values.push(v)
  }
  return { offset, values }
}

/** Re-expand a tail-computed series back onto the original index space. */
function padTo(length: number, offset: number, tail: readonly (number | null)[]): (number | null)[] {
  const out = nulls(length)
  for (let i = 0; i < tail.length; i++) {
    const target = offset + i
    if (target < 0 || target >= length) continue
    out[target] = tail[i] ?? null
  }
  return out
}

/** Highest value in `values[from..to]` inclusive, or null if the slice is empty. */
function highestIn(values: readonly number[], from: number, to: number): number | null {
  let best: number | null = null
  for (let i = Math.max(0, from); i <= to && i < values.length; i++) {
    const v = values[i]
    if (v === undefined) continue
    if (best === null || v > best) best = v
  }
  return best
}

function lowestIn(values: readonly number[], from: number, to: number): number | null {
  let best: number | null = null
  for (let i = Math.max(0, from); i <= to && i < values.length; i++) {
    const v = values[i]
    if (v === undefined) continue
    if (best === null || v < best) best = v
  }
  return best
}

/** Clamp a definitionally-bounded oscillator against floating-point residue. */
function clampRange(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return (lo + hi) / 2
  if (value < lo) return lo
  if (value > hi) return hi
  return value
}

/** Guard against 0/0 and x/0 producing NaN or Infinity anywhere in this file. */
function safeDiv(numerator: number, denominator: number, fallback: number): number {
  if (denominator === 0 || !Number.isFinite(denominator) || !Number.isFinite(numerator)) {
    return fallback
  }
  const q = numerator / denominator
  return Number.isFinite(q) ? q : fallback
}

/** Typical price (HLC/3) — the price series that CCI, MFI and VWAP are built on. */
export function typicalPrice(candle: Candle): number {
  return (candle.high + candle.low + candle.close) / 3
}

export function closes(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.close)
}

// ---------------------------------------------------------------------------
// Moving averages
// ---------------------------------------------------------------------------

/**
 * Simple moving average. Null prefix is exactly `period - 1` long: the average
 * of a `period`-wide window is first defined at index `period - 1`.
 */
export function sma(values: readonly number[], period: number): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'sma period must be a positive integer')
  const out = nulls(values.length)
  if (values.length < period) return out

  // Each window is summed directly rather than maintained as a rolling
  // add-one/drop-one total. The rolling form is O(n) instead of O(n·p), but its
  // floating-point residue never cancels: subtracting a value that was added
  // hundreds of steps earlier leaves a small error that accumulates
  // monotonically. On a near-constant series that residue is the ENTIRE answer —
  // it is how an SMA of a window of exact zeros comes back as −1.5e-14, which
  // then propagates as a negative %K out of a bounded oscillator. At the series
  // lengths this engine works with, the extra loop is far cheaper than the class
  // of bug it removes.
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j]
      if (v === undefined) continue
      sum += v
    }
    out[i] = sum / period
  }
  return out
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values.
 *
 * The seed matters more than people expect. Seeding with the first value alone
 * (the other common choice) leaves the EMA visibly biased toward that single
 * arbitrary observation for roughly 3·period bars, which shows up as a phantom
 * trend at the start of every backtest window. Seeding with the SMA is what
 * every reference implementation (and every charting package we would be
 * compared against) does.
 */
export function ema(values: readonly number[], period: number): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'ema period must be a positive integer')
  const out = nulls(values.length)
  if (values.length < period) return out

  const k = 2 / (period + 1)

  let seed = 0
  for (let i = 0; i < period; i++) {
    const v = values[i]
    if (v === undefined) return out
    seed += v
  }
  let prev = seed / period
  out[period - 1] = prev

  for (let i = period; i < values.length; i++) {
    const v = values[i]
    if (v === undefined) continue
    prev = v * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/**
 * Weighted moving average with linearly increasing weights (1..period).
 *
 * Sits between SMA and EMA in responsiveness: unlike the EMA it has a hard
 * cutoff, so a shock leaves the window completely after `period` bars instead of
 * decaying forever.
 */
export function wma(values: readonly number[], period: number): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'wma period must be a positive integer')
  const out = nulls(values.length)
  if (values.length < period) return out

  const denominator = (period * (period + 1)) / 2
  for (let i = period - 1; i < values.length; i++) {
    let acc = 0
    for (let j = 0; j < period; j++) {
      const v = values[i - period + 1 + j]
      if (v === undefined) continue
      acc += v * (j + 1)
    }
    out[i] = acc / denominator
  }
  return out
}

// ---------------------------------------------------------------------------
// Dispersion
// ---------------------------------------------------------------------------

/**
 * Standard deviation of a whole series (population by default).
 *
 * Two-pass (mean first, then squared deviations) rather than the algebraically
 * equivalent E[x²] − E[x]² shortcut. The shortcut suffers catastrophic
 * cancellation exactly where crypto lives: for BTC around 118,000 with a
 * 200-wide spread, E[x²] ≈ 1.39e10 and E[x]² ≈ 1.39e10, and subtracting them
 * throws away most of the significant digits of the answer. Two passes cost one
 * extra loop and are correct.
 */
export function standardDeviation(
  values: readonly number[],
  mode: 'population' | 'sample' = 'population',
): number {
  const n = values.length
  if (n === 0) return 0
  if (mode === 'sample' && n < 2) return 0

  let mean = 0
  for (const v of values) mean += v
  mean /= n

  let acc = 0
  for (const v of values) {
    const d = v - mean
    acc += d * d
  }
  const divisor = mode === 'sample' ? n - 1 : n
  return Math.sqrt(acc / divisor)
}

/** Rolling standard deviation over a trailing window of `period` values. */
export function rollingStdDev(
  values: readonly number[],
  period: number,
  mode: 'population' | 'sample' = 'population',
): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'rollingStdDev period must be a positive integer')
  const out = nulls(values.length)
  if (values.length < period) return out

  for (let i = period - 1; i < values.length; i++) {
    const window: number[] = []
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j]
      if (v === undefined) continue
      window.push(v)
    }
    out[i] = standardDeviation(window, mode)
  }
  return out
}

// ---------------------------------------------------------------------------
// Oscillators
// ---------------------------------------------------------------------------

/**
 * Relative Strength Index using WILDER'S SMOOTHING.
 *
 * This is the indicator most commonly got wrong, so being explicit: RSI is NOT
 * `100 − 100/(1 + meanGain/meanLoss)` over a simple moving average of the last
 * `period` gains and losses. Wilder's original formulation seeds with a simple
 * average of the first `period` changes and then applies a modified exponential
 * smoothing with α = 1/period (NOT the 2/(period+1) used by a standard EMA):
 *
 *     avgGain_t = (avgGain_{t-1} · (period − 1) + gain_t) / period
 *
 * A simple-average implementation produces a jumpier RSI whose values differ
 * from every charting platform by several points, and — worse — whose extremes
 * are reached at different bars. Since our models threshold and z-score these
 * values against historical distributions, a systematically different RSI is not
 * "close enough", it is a different feature.
 *
 * Convention on flat series: when there are neither gains nor losses in the
 * window (a perfectly constant price) the ratio is 0/0. We return **50**, not
 * 100. 100 means "all movement was upward"; a series with no movement at all has
 * no directional information, and 50 is the honest encoding of that. Callers
 * relying on RSI == 100 to mean "maximally overbought" would otherwise be
 * handed a dead market as a screaming buy signal. When there are gains but zero
 * losses we return 100, and zero gains with losses returns 0, both as usual.
 *
 * First defined index is `period` (we need `period` price CHANGES, which needs
 * `period + 1` prices).
 */
export function rsi(values: readonly number[], period = 14): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'rsi period must be a positive integer')
  const out = nulls(values.length)
  if (values.length <= period) return out

  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const cur = values[i]
    const prev = values[i - 1]
    if (cur === undefined || prev === undefined) return out
    const change = cur - prev
    if (change > 0) avgGain += change
    else avgLoss += -change
  }
  avgGain /= period
  avgLoss /= period
  out[period] = rsiFromAverages(avgGain, avgLoss)

  for (let i = period + 1; i < values.length; i++) {
    const cur = values[i]
    const prev = values[i - 1]
    if (cur === undefined || prev === undefined) continue
    const change = cur - prev
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? -change : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] = rsiFromAverages(avgGain, avgLoss)
  }
  return out
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0 && avgGain === 0) return 50 // flat market — see convention note above
  if (avgLoss === 0) return 100
  if (avgGain === 0) return 0
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export interface MacdSeries {
  readonly macd: (number | null)[]
  readonly signal: (number | null)[]
  readonly histogram: (number | null)[]
}

/**
 * MACD: fast EMA − slow EMA, with an EMA signal line and their difference.
 *
 * The signal line is an EMA of the MACD line, which means it is only defined
 * `signalPeriod - 1` bars after the MACD line itself is — hence the warm-up
 * compaction: we run the signal EMA over the defined tail of the MACD series and
 * pad the result back onto the full index space, rather than feeding nulls into
 * an EMA and getting NaN.
 */
export function macd(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdSeries {
  invariant(fastPeriod > 0 && slowPeriod > 0 && signalPeriod > 0, 'macd periods must be positive')
  invariant(fastPeriod < slowPeriod, 'macd fast period must be shorter than slow period')

  const fast = ema(values, fastPeriod)
  const slow = ema(values, slowPeriod)

  const macdLine = nulls(values.length)
  for (let i = 0; i < values.length; i++) {
    const f = fast[i]
    const s = slow[i]
    if (f === null || f === undefined || s === null || s === undefined) continue
    macdLine[i] = f - s
  }

  const { offset, values: tail } = definedTail(macdLine)
  const signalLine =
    offset < 0 ? nulls(values.length) : padTo(values.length, offset, ema(tail, signalPeriod))

  const histogram = nulls(values.length)
  for (let i = 0; i < values.length; i++) {
    const m = macdLine[i]
    const s = signalLine[i]
    if (m === null || m === undefined || s === null || s === undefined) continue
    histogram[i] = m - s
  }

  return { macd: macdLine, signal: signalLine, histogram }
}

export interface BollingerSeries {
  readonly upper: (number | null)[]
  readonly middle: (number | null)[]
  readonly lower: (number | null)[]
  /** (upper − lower) / middle — a scale-free width measure comparable across assets. */
  readonly bandwidth: (number | null)[]
  /** Where price sits inside the bands: 0 at the lower band, 1 at the upper. */
  readonly percentB: (number | null)[]
}

/**
 * Bollinger Bands.
 *
 * `bandwidth` is normalised by the middle band precisely so it is comparable
 * across a $0.15 memecoin and $118,000 BTC — an absolute band width is a
 * meaningless number to feed a model that trades both.
 *
 * `percentB` is deliberately NOT clamped to [0,1]: values above 1 (close above
 * the upper band) and below 0 are real, informative states, and clipping them
 * would erase exactly the tail events the volatility models care about.
 * Degenerate case: when the bands collapse (zero deviation) %B is 0/0 and we
 * return 0.5 — price is trivially "in the middle" of a zero-width band.
 */
export function bollingerBands(
  values: readonly number[],
  period = 20,
  multiplier = 2,
): BollingerSeries {
  invariant(Number.isInteger(period) && period > 0, 'bollinger period must be a positive integer')
  invariant(multiplier > 0, 'bollinger multiplier must be positive')

  const middle = sma(values, period)
  const sd = rollingStdDev(values, period)

  const upper = nulls(values.length)
  const lower = nulls(values.length)
  const bandwidth = nulls(values.length)
  const percentB = nulls(values.length)

  for (let i = 0; i < values.length; i++) {
    const m = middle[i]
    const s = sd[i]
    const price = values[i]
    if (m === null || m === undefined || s === null || s === undefined || price === undefined) {
      continue
    }
    const u = m + multiplier * s
    const l = m - multiplier * s
    upper[i] = u
    lower[i] = l
    bandwidth[i] = safeDiv(u - l, m, 0)
    percentB[i] = u === l ? 0.5 : (price - l) / (u - l)
  }

  return { upper, middle, lower, bandwidth, percentB }
}

export interface StochasticSeries {
  readonly k: (number | null)[]
  readonly d: (number | null)[]
}

/**
 * Stochastic oscillator.
 *
 * %K = 100 · (close − lowestLow) / (highestHigh − lowestLow) over `kPeriod`,
 * optionally smoothed by `smoothK` (smoothK = 1 is the "fast" stochastic,
 * smoothK = 3 the conventional "slow"), with %D = SMA(%K, dPeriod).
 *
 * Degenerate case: a window where high == low across every bar gives 0/0. We
 * return 50 — a flat window is neither overbought nor oversold.
 */
export function stochastic(
  candles: readonly Candle[],
  kPeriod = 14,
  dPeriod = 3,
  smoothK = 1,
): StochasticSeries {
  invariant(Number.isInteger(kPeriod) && kPeriod > 0, 'stochastic kPeriod must be a positive integer')
  invariant(Number.isInteger(dPeriod) && dPeriod > 0, 'stochastic dPeriod must be a positive integer')
  invariant(Number.isInteger(smoothK) && smoothK > 0, 'stochastic smoothK must be a positive integer')

  const n = candles.length
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)

  const rawK = nulls(n)
  for (let i = kPeriod - 1; i < n; i++) {
    const hh = highestIn(highs, i - kPeriod + 1, i)
    const ll = lowestIn(lows, i - kPeriod + 1, i)
    const candle = candles[i]
    if (hh === null || ll === null || candle === undefined) continue
    rawK[i] = hh === ll ? 50 : (100 * (candle.close - ll)) / (hh - ll)
  }

  const k = smoothK === 1 ? rawK : smoothNullable(rawK, smoothK)
  const d = smoothNullable(k, dPeriod)
  // %K and %D are bounded to [0,100] by construction; clamp so that accumulated
  // floating-point residue can never leak a −1e-14 out of a bounded oscillator
  // and break a downstream range assumption.
  return { k: clampSeries(k, 0, 100), d: clampSeries(d, 0, 100) }
}

function clampSeries(
  series: readonly (number | null)[],
  lo: number,
  hi: number,
): (number | null)[] {
  return series.map((v) => (v === null || v === undefined ? null : clampRange(v, lo, hi)))
}

/** SMA over a warm-up-prefixed series, preserving alignment. */
function smoothNullable(series: readonly (number | null)[], period: number): (number | null)[] {
  const { offset, values } = definedTail(series)
  if (offset < 0) return nulls(series.length)
  return padTo(series.length, offset, sma(values, period))
}

/**
 * Stochastic RSI — the stochastic oscillator applied to the RSI series rather
 * than to price.
 *
 * The point is sensitivity. Plain RSI on a trending crypto asset can sit between
 * 40 and 70 for weeks and never touch its nominal 30/70 extremes; StochRSI
 * rescales RSI against its OWN recent range, so it registers relative extremes
 * within whatever band the market is currently using. The cost is a much noisier
 * signal, which is why both smoothing stages exist.
 */
export function stochasticRsi(
  values: readonly number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3,
): StochasticSeries {
  invariant(Number.isInteger(stochPeriod) && stochPeriod > 0, 'stochRsi stochPeriod must be a positive integer')

  const n = values.length
  const rsiSeries = rsi(values, rsiPeriod)
  const { offset, values: rsiTail } = definedTail(rsiSeries)
  if (offset < 0 || rsiTail.length < stochPeriod) {
    return { k: nulls(n), d: nulls(n) }
  }

  const rawTail = nulls(rsiTail.length)
  for (let i = stochPeriod - 1; i < rsiTail.length; i++) {
    const hh = highestIn(rsiTail, i - stochPeriod + 1, i)
    const ll = lowestIn(rsiTail, i - stochPeriod + 1, i)
    const cur = rsiTail[i]
    if (hh === null || ll === null || cur === undefined) continue
    // Scaled to 0..100 to match the conventional presentation of %K.
    rawTail[i] = hh === ll ? 50 : (100 * (cur - ll)) / (hh - ll)
  }

  const raw = padTo(n, offset, rawTail)
  const k = kSmooth <= 1 ? raw : smoothNullable(raw, kSmooth)
  const d = dSmooth <= 1 ? k : smoothNullable(k, dSmooth)
  return { k: clampSeries(k, 0, 100), d: clampSeries(d, 0, 100) }
}

/**
 * Rate of change, as a percentage of the price `period` bars ago.
 * Returns null when the reference price is 0 (undefined percentage change).
 */
export function roc(values: readonly number[], period = 10): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'roc period must be a positive integer')
  const out = nulls(values.length)
  for (let i = period; i < values.length; i++) {
    const cur = values[i]
    const prev = values[i - period]
    if (cur === undefined || prev === undefined || prev === 0) continue
    out[i] = ((cur - prev) / prev) * 100
  }
  return out
}

/** Momentum: the raw price difference over `period` bars (not normalised). */
export function momentum(values: readonly number[], period = 10): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'momentum period must be a positive integer')
  const out = nulls(values.length)
  for (let i = period; i < values.length; i++) {
    const cur = values[i]
    const prev = values[i - period]
    if (cur === undefined || prev === undefined) continue
    out[i] = cur - prev
  }
  return out
}

/**
 * Commodity Channel Index.
 *
 * CCI = (TP − SMA(TP)) / (0.015 · meanDeviation). The 0.015 constant is Lambert's
 * arbitrary scaling chosen so that roughly 70–80% of values land in ±100; it has
 * no statistical meaning and we keep it only for comparability with published
 * values. Note this uses MEAN absolute deviation, not standard deviation — using
 * stdev here (a frequent mistake) shrinks the readings by ~20% and moves the
 * ±100 bands off their conventional meaning.
 *
 * Degenerate case: zero mean deviation (perfectly flat typical price) → 0.
 */
export function cci(candles: readonly Candle[], period = 20): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'cci period must be a positive integer')
  const n = candles.length
  const out = nulls(n)
  const tp = candles.map(typicalPrice)
  const tpSma = sma(tp, period)

  for (let i = period - 1; i < n; i++) {
    const mean = tpSma[i]
    const cur = tp[i]
    if (mean === null || mean === undefined || cur === undefined) continue
    let deviation = 0
    for (let j = i - period + 1; j <= i; j++) {
      const v = tp[j]
      if (v === undefined) continue
      deviation += Math.abs(v - mean)
    }
    deviation /= period
    out[i] = safeDiv(cur - mean, 0.015 * deviation, 0)
  }
  return out
}

/**
 * Williams %R — the stochastic's mirror image, on a −100..0 scale.
 * Degenerate flat window → −50 (the midpoint of the scale).
 */
export function williamsR(candles: readonly Candle[], period = 14): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'williamsR period must be a positive integer')
  const n = candles.length
  const out = nulls(n)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)

  for (let i = period - 1; i < n; i++) {
    const hh = highestIn(highs, i - period + 1, i)
    const ll = lowestIn(lows, i - period + 1, i)
    const candle = candles[i]
    if (hh === null || ll === null || candle === undefined) continue
    out[i] = hh === ll ? -50 : (-100 * (hh - candle.close)) / (hh - ll)
  }
  return out
}

/**
 * Money Flow Index — "volume-weighted RSI".
 *
 * Where RSI asks how much price moved up versus down, MFI asks how much MONEY
 * moved up versus down (typical price × volume). Divergence between the two is
 * the informative case: price making a new high on shrinking money flow is the
 * pattern this indicator exists to expose.
 *
 * Bars with unchanged typical price are counted on neither side, per the
 * standard definition. Conventions match `rsi`: no flow at all → 50, only
 * positive flow → 100, only negative flow → 0.
 */
export function moneyFlowIndex(candles: readonly Candle[], period = 14): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'mfi period must be a positive integer')
  const n = candles.length
  const out = nulls(n)
  if (n <= period) return out

  const tp = candles.map(typicalPrice)
  const positive = new Array<number>(n).fill(0)
  const negative = new Array<number>(n).fill(0)

  for (let i = 1; i < n; i++) {
    const cur = tp[i]
    const prev = tp[i - 1]
    const candle = candles[i]
    if (cur === undefined || prev === undefined || candle === undefined) continue
    const rawFlow = cur * candle.volume
    if (cur > prev) positive[i] = rawFlow
    else if (cur < prev) negative[i] = rawFlow
  }

  for (let i = period; i < n; i++) {
    let pos = 0
    let neg = 0
    for (let j = i - period + 1; j <= i; j++) {
      pos += positive[j] ?? 0
      neg += negative[j] ?? 0
    }
    if (pos === 0 && neg === 0) out[i] = 50
    else if (neg === 0) out[i] = 100
    else if (pos === 0) out[i] = 0
    else out[i] = 100 - 100 / (1 + pos / neg)
  }
  return out
}

// ---------------------------------------------------------------------------
// Range and volatility primitives
// ---------------------------------------------------------------------------

/**
 * True Range: max(high − low, |high − prevClose|, |low − prevClose|).
 *
 * Index 0 is null, not `high − low`. True range is defined RELATIVE to the
 * previous close — it exists to capture gaps — and the first bar has no previous
 * close, so its true range is genuinely unknown. Many libraries silently
 * substitute the raw high−low there, which biases the ATR seed downward whenever
 * the series begins after a gap. Being explicit costs one null and removes a
 * whole class of "why is my ATR slightly off" investigations.
 */
export function trueRange(candles: readonly Candle[]): (number | null)[] {
  const out = nulls(candles.length)
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i]
    const prev = candles[i - 1]
    if (cur === undefined || prev === undefined) continue
    out[i] = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    )
  }
  return out
}

/**
 * Average True Range with Wilder smoothing (α = 1/period, same family as RSI —
 * NOT a standard EMA's 2/(period+1)).
 *
 * Seeded with the simple mean of the first `period` true ranges, so the first
 * defined index is `period` (true range itself starts at index 1).
 */
export function atr(candles: readonly Candle[], period = 14): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'atr period must be a positive integer')
  const n = candles.length
  const out = nulls(n)
  if (n <= period) return out

  const tr = trueRange(candles)

  let seed = 0
  for (let i = 1; i <= period; i++) {
    const v = tr[i]
    if (v === null || v === undefined) return out
    seed += v
  }
  let prev = seed / period
  out[period] = prev

  for (let i = period + 1; i < n; i++) {
    const v = tr[i]
    if (v === null || v === undefined) continue
    prev = (prev * (period - 1) + v) / period
    out[i] = prev
  }
  return out
}

export interface AdxSeries {
  readonly adx: (number | null)[]
  readonly plusDI: (number | null)[]
  readonly minusDI: (number | null)[]
}

/**
 * Average Directional Index with +DI/−DI — the full Wilder construction.
 *
 * Three stacked smoothings, which is why ADX warms up so slowly (first defined
 * index is 2·period − 1, i.e. bar 27 for the default 14):
 *   1. Directional movement: +DM = up-move when it exceeds the down-move,
 *      −DM likewise. Only one of the two can be non-zero on any bar; an inside
 *      bar produces neither.
 *   2. Wilder-smooth +DM, −DM and TR over `period`, then +DI = 100·+DM/TR.
 *   3. DX = 100·|+DI − −DI| / (+DI + −DI), then Wilder-smooth DX into ADX.
 *
 * ADX measures trend STRENGTH and is direction-agnostic — a hard downtrend and a
 * hard uptrend both read 40+. Direction lives entirely in the sign of
 * +DI − −DI, which is why the DI lines are returned rather than hidden.
 */
export function adx(candles: readonly Candle[], period = 14): AdxSeries {
  invariant(Number.isInteger(period) && period > 0, 'adx period must be a positive integer')
  const n = candles.length
  const empty: AdxSeries = { adx: nulls(n), plusDI: nulls(n), minusDI: nulls(n) }
  if (n < 2 * period) return empty

  const tr = new Array<number>(n).fill(0)
  const plusDM = new Array<number>(n).fill(0)
  const minusDM = new Array<number>(n).fill(0)

  for (let i = 1; i < n; i++) {
    const cur = candles[i]
    const prev = candles[i - 1]
    if (cur === undefined || prev === undefined) continue
    tr[i] = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    )
    const upMove = cur.high - prev.high
    const downMove = prev.low - cur.low
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0
  }

  // Wilder's running sums, seeded with the plain sum of the first `period` bars.
  let smoothTR = 0
  let smoothPlus = 0
  let smoothMinus = 0
  for (let i = 1; i <= period; i++) {
    smoothTR += tr[i] ?? 0
    smoothPlus += plusDM[i] ?? 0
    smoothMinus += minusDM[i] ?? 0
  }

  const plusDI = nulls(n)
  const minusDI = nulls(n)
  const dx = nulls(n)

  for (let i = period; i < n; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + (tr[i] ?? 0)
      smoothPlus = smoothPlus - smoothPlus / period + (plusDM[i] ?? 0)
      smoothMinus = smoothMinus - smoothMinus / period + (minusDM[i] ?? 0)
    }
    // DI is bounded to [0,100] because a single bar's directional movement
    // cannot exceed its true range; clamped anyway against rounding residue.
    const pdi = clampRange(100 * safeDiv(smoothPlus, smoothTR, 0), 0, 100)
    const mdi = clampRange(100 * safeDiv(smoothMinus, smoothTR, 0), 0, 100)
    plusDI[i] = pdi
    minusDI[i] = mdi
    dx[i] = clampRange(100 * safeDiv(Math.abs(pdi - mdi), pdi + mdi, 0), 0, 100)
  }

  const adxOut = nulls(n)
  let seed = 0
  for (let i = period; i <= 2 * period - 1; i++) seed += dx[i] ?? 0
  let prevAdx = seed / period
  adxOut[2 * period - 1] = prevAdx

  for (let i = 2 * period; i < n; i++) {
    prevAdx = (prevAdx * (period - 1) + (dx[i] ?? 0)) / period
    adxOut[i] = prevAdx
  }

  return { adx: adxOut, plusDI, minusDI }
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/**
 * On-Balance Volume: a running total that adds the bar's volume on an up-close
 * and subtracts it on a down-close.
 *
 * The absolute level is meaningless (it depends entirely on where the series
 * happens to start) — only the SLOPE and its divergence from price carry
 * information. Index 0 is anchored at 0 as the arbitrary baseline.
 */
export function obv(candles: readonly Candle[]): (number | null)[] {
  const out = nulls(candles.length)
  if (candles.length === 0) return out
  let running = 0
  out[0] = 0
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i]
    const prev = candles[i - 1]
    if (cur === undefined || prev === undefined) continue
    if (cur.close > prev.close) running += cur.volume
    else if (cur.close < prev.close) running -= cur.volume
    out[i] = running
  }
  return out
}

export type VwapOptions =
  | { readonly mode: 'session'; readonly sessionMs?: number }
  | { readonly mode: 'rolling'; readonly period: number }

/**
 * Volume-weighted average price.
 *
 * Two variants, because they answer different questions:
 *  - `session`: cumulative from a fixed anchor (daily by default), reset at each
 *    session boundary. This is the benchmark execution desks are measured
 *    against, so it acts as a genuine magnet/reference level intraday.
 *  - `rolling`: a trailing `period`-bar window, which never resets and is
 *    therefore the right input for a model that needs a stationary feature.
 *
 * Session boundaries come from `candle.openTime` — data, not a clock — so this
 * stays pure and a backtest anchors sessions identically every run.
 */
export function vwap(
  candles: readonly Candle[],
  opts: VwapOptions = { mode: 'session' },
): (number | null)[] {
  return opts.mode === 'rolling'
    ? rollingVwap(candles, opts.period)
    : sessionVwap(candles, opts.sessionMs ?? 86_400_000)
}

/** Cumulative VWAP, reset whenever `openTime` crosses a session boundary. */
export function sessionVwap(
  candles: readonly Candle[],
  sessionMs = 86_400_000,
): (number | null)[] {
  invariant(sessionMs > 0, 'sessionMs must be positive')
  const out = nulls(candles.length)
  let bucket: number | null = null
  let pv = 0
  let vol = 0

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    if (c === undefined) continue
    const thisBucket = Math.floor(c.openTime / sessionMs)
    if (bucket === null || thisBucket !== bucket) {
      bucket = thisBucket
      pv = 0
      vol = 0
    }
    pv += typicalPrice(c) * c.volume
    vol += c.volume
    // Zero traded volume leaves VWAP genuinely undefined; null rather than a
    // fabricated fallback to the typical price.
    out[i] = vol === 0 ? null : pv / vol
  }
  return out
}

/** Trailing `period`-bar VWAP. */
export function rollingVwap(candles: readonly Candle[], period: number): (number | null)[] {
  invariant(Number.isInteger(period) && period > 0, 'rollingVwap period must be a positive integer')
  const out = nulls(candles.length)
  if (candles.length < period) return out

  for (let i = period - 1; i < candles.length; i++) {
    let pv = 0
    let vol = 0
    for (let j = i - period + 1; j <= i; j++) {
      const c = candles[j]
      if (c === undefined) continue
      pv += typicalPrice(c) * c.volume
      vol += c.volume
    }
    out[i] = vol === 0 ? null : pv / vol
  }
  return out
}

// ---------------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------------

export type CrossSignal = 'bullish' | 'bearish' | null

/**
 * Crossover detection between two aligned series.
 *
 * Emits a signal only on the bar where the relationship FLIPS, and only when
 * both bars of the comparison are defined in both series. Returning a signal on
 * every bar where fast > slow would turn one crossover into a hundred duplicate
 * events; the models want the transition, not the state.
 *
 * The `<=` on the previous bar means a touch-then-separate (equal, then above)
 * counts as a cross, which matches how charting packages mark them.
 */
export function crossovers(
  fast: readonly (number | null)[],
  slow: readonly (number | null)[],
): CrossSignal[] {
  invariant(fast.length === slow.length, 'crossovers requires equal-length series')
  const out: CrossSignal[] = new Array<CrossSignal>(fast.length).fill(null)

  for (let i = 1; i < fast.length; i++) {
    const f = fast[i]
    const s = slow[i]
    const pf = fast[i - 1]
    const ps = slow[i - 1]
    if (
      f === null || f === undefined || s === null || s === undefined ||
      pf === null || pf === undefined || ps === null || ps === undefined
    ) {
      continue
    }
    if (pf <= ps && f > s) out[i] = 'bullish'
    else if (pf >= ps && f < s) out[i] = 'bearish'
  }
  return out
}
