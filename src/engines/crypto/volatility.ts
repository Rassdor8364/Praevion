/**
 * Volatility estimation and forecasting.
 *
 * Direction and magnitude are different questions with different accuracy
 * profiles, and this module exists so the system can be uncertain about one
 * while confident about the other. A model that fuses them will happily be right
 * about direction and catastrophically wrong about range, and the user will only
 * remember the range.
 *
 * All estimators here are REALISED-volatility estimators: they measure what
 * price actually did. None of them is implied volatility — we have no options
 * surface — so nothing here contains market expectations, only market history.
 * That asymmetry is why `forecastVolatility` reports a confidence rather than
 * presenting its output as a prediction of the same standing as an option chain.
 *
 * Pure throughout: candles in, numbers out. No clock, no randomness.
 */

import { InsufficientDataError, invariant } from '@/core/errors'
import type { VolatilityForecast } from '@/core/prediction/types'
import type { Candle } from '@/providers/types'
import { atr, standardDeviation } from './indicators'

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

function nulls(length: number): (number | null)[] {
  return new Array<number | null>(length).fill(null)
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

/**
 * Log returns, length n − 1.
 *
 * Log rather than simple returns because they are additive over time — the
 * two-period return is the sum of the two one-period returns — which is exactly
 * the property the sqrt-of-time scaling in `forecastVolatility` relies on.
 * Simple returns compound multiplicatively and scaling their standard deviation
 * by √h is quietly wrong.
 *
 * Non-positive prices (bad ticks, a delisted pair padded with zeros) would give
 * −Infinity or NaN. Those pairs contribute a 0 return: a zero says "we observed
 * no move", which is the least damaging thing to say about a datum we know is
 * broken, and the data-quality layer is the right place to notice the gap.
 */
export function logReturns(values: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < values.length; i++) {
    const cur = values[i]
    const prev = values[i - 1]
    if (cur === undefined || prev === undefined || cur <= 0 || prev <= 0) {
      out.push(0)
      continue
    }
    out.push(Math.log(cur / prev))
  }
  return out
}

/**
 * Scale a per-period volatility to an annual figure.
 *
 * σ_annual = σ_period · √periodsPerYear, which follows from the independence
 * assumption behind sqrt-of-time. Crypto returns are NOT independent — they
 * cluster — so this systematically understates annualised risk in a storm and
 * overstates it in a lull. It is kept because it is the universal convention and
 * therefore comparable, not because it is true.
 */
export function annualise(vol: number, periodsPerYear: number): number {
  invariant(periodsPerYear > 0, 'periodsPerYear must be positive')
  return vol * Math.sqrt(periodsPerYear)
}

/** Periods per year for each supported candle interval, for `annualise`. */
export const PERIODS_PER_YEAR: Readonly<Record<string, number>> = {
  '1m': 525_600,
  '5m': 105_120,
  '15m': 35_040,
  '1h': 8_760,
  '4h': 2_190,
  '1d': 365,
}

// ---------------------------------------------------------------------------
// Realised volatility estimators
// ---------------------------------------------------------------------------

/**
 * Close-to-close realised volatility: the rolling standard deviation of log
 * returns, per period, aligned to the candle array.
 *
 * Population (not sample) standard deviation, and no mean subtraction debate:
 * over short windows the estimated mean return is almost pure noise, and the
 * classic estimator's √(1/n Σ (r − r̄)²) is retained only for comparability with
 * other packages.
 *
 * This is the least efficient of the estimators here — it uses one observation
 * per bar and throws away everything that happened inside it — but it is the
 * only one that is unaffected by the shape of the bar, which makes it the
 * sanity check for the others.
 */
export function realisedVolatility(
  candles: readonly Candle[],
  window = 20,
): (number | null)[] {
  invariant(Number.isInteger(window) && window >= 2, 'realisedVolatility window must be >= 2')
  const n = candles.length
  const out = nulls(n)
  if (n < window + 1) return out

  const returns = logReturns(candles.map((c) => c.close))
  // returns[k] describes the move INTO candle k+1, so the window ending at
  // candle i is returns[i-window .. i-1].
  for (let i = window; i < n; i++) {
    const slice = returns.slice(i - window, i)
    out[i] = standardDeviation(slice)
  }
  return out
}

/**
 * RiskMetrics-style EWMA volatility.
 *
 *     σ²_t = λ·σ²_{t-1} + (1 − λ)·r²_{t-1}
 *
 * λ = 0.94 is the JP Morgan RiskMetrics daily default, chosen empirically as the
 * decay that best fit realised variance across asset classes; it corresponds to
 * a half-life of about 11 periods.
 *
 * Why EWMA rather than a rolling window: volatility CLUSTERS. A rolling window
 * gives a five-sigma crash the same weight on day 19 as on day 1 and then drops
 * it off a cliff on day 21, producing the notorious "ghost feature" — a step
 * change in the risk estimate caused by nothing happening. Exponential decay
 * removes the discontinuity and reacts faster to the shock in the first place.
 *
 * Returns a per-period sigma aligned to `returns` (same length). Seeded with
 * |r_0|, which is a poor estimate for one step and irrelevant within ~30.
 */
export function ewmaVolatility(returns: readonly number[], lambda = 0.94): number[] {
  invariant(lambda > 0 && lambda < 1, 'ewma lambda must lie in (0,1)')
  const out: number[] = []
  if (returns.length === 0) return out

  const first = returns[0] ?? 0
  let variance = first * first
  out.push(Math.sqrt(variance))

  for (let i = 1; i < returns.length; i++) {
    const prev = returns[i - 1] ?? 0
    variance = lambda * variance + (1 - lambda) * prev * prev
    out.push(Math.sqrt(Math.max(0, variance)))
  }
  return out
}

/**
 * Parkinson high–low range estimator.
 *
 *     σ_P = √( 1/(4·ln2·n) · Σ ln(high/low)² )
 *
 * Roughly 5× more statistically efficient than close-to-close for the same
 * sample size, because it uses the intraperiod RANGE — the full path the price
 * took — instead of a single endpoint. With 20 bars it delivers about the
 * precision close-to-close needs 100 bars for, which matters enormously on 4h
 * and daily candles where 100 bars is months of history that may not describe
 * the current regime at all.
 *
 * The catch, and it is a real one: Parkinson is BIASED DOWNWARD in the presence
 * of jumps and gaps. It assumes continuous geometric Brownian motion within the
 * bar, so any move that happens BETWEEN bars — an exchange halt, a funding-time
 * liquidation cascade, a weekend gap — is invisible to it. Crypto has no
 * overnight gap, which helps, but it has plenty of jumps, and precisely during
 * the events where an accurate risk number matters most this estimator will read
 * low. It is therefore blended, never used alone.
 */
export function parkinsonVolatility(
  candles: readonly Candle[],
  window = 20,
): (number | null)[] {
  invariant(Number.isInteger(window) && window >= 1, 'parkinson window must be >= 1')
  const n = candles.length
  const out = nulls(n)
  if (n < window) return out

  const factor = 1 / (4 * Math.LN2)
  for (let i = window - 1; i < n; i++) {
    let acc = 0
    let counted = 0
    for (let j = i - window + 1; j <= i; j++) {
      const c = candles[j]
      if (c === undefined || c.high <= 0 || c.low <= 0) continue
      const r = Math.log(c.high / c.low)
      acc += r * r
      counted++
    }
    out[i] = counted === 0 ? 0 : Math.sqrt(factor * (acc / counted))
  }
  return out
}

/**
 * Garman–Klass OHLC estimator.
 *
 *     σ²_GK = 1/n · Σ [ 0.5·ln(h/l)² − (2·ln2 − 1)·ln(c/o)² ]
 *
 * Uses all four prices and is about 7–8× more efficient than close-to-close. The
 * second term is a correction, not an addition: it subtracts the portion of the
 * range that is explained by directional drift, on the reasoning that a bar
 * which opened at its low and closed at its high was TRENDING rather than
 * volatile, and charging it full range would overstate the risk.
 *
 * That subtraction can drive an individual bar's variance contribution negative;
 * the sum is floored at 0 before the square root because a negative variance is
 * an estimator artefact, not a number to propagate.
 */
export function garmanKlassVolatility(
  candles: readonly Candle[],
  window = 20,
): (number | null)[] {
  invariant(Number.isInteger(window) && window >= 1, 'garmanKlass window must be >= 1')
  const n = candles.length
  const out = nulls(n)
  if (n < window) return out

  const driftCoefficient = 2 * Math.LN2 - 1
  for (let i = window - 1; i < n; i++) {
    let acc = 0
    let counted = 0
    for (let j = i - window + 1; j <= i; j++) {
      const c = candles[j]
      if (c === undefined || c.high <= 0 || c.low <= 0 || c.open <= 0 || c.close <= 0) continue
      const hl = Math.log(c.high / c.low)
      const co = Math.log(c.close / c.open)
      acc += 0.5 * hl * hl - driftCoefficient * co * co
      counted++
    }
    out[i] = counted === 0 ? 0 : Math.sqrt(Math.max(0, acc / counted))
  }
  return out
}

// ---------------------------------------------------------------------------
// Regime
// ---------------------------------------------------------------------------

/**
 * Fraction of `history` that is strictly less than `value`, plus half the ties.
 *
 * Midpoint tie handling keeps a constant series at 0.5 rather than 0 or 1 —
 * without it, a market that has been perfectly flat for the whole lookback
 * reports its (equally flat) current reading as either the calmest or the most
 * violent moment in its history, both of which are absurd.
 */
export function percentileRank(history: readonly number[], value: number): number {
  if (history.length === 0) return 0.5
  let below = 0
  let equal = 0
  for (const h of history) {
    if (h < value) below++
    else if (h === value) equal++
  }
  return clamp01((below + equal / 2) / history.length)
}

/**
 * Where the current ATR sits within its own recent history, 0..1.
 *
 * Self-referential by design. There is no absolute ATR that means "volatile" —
 * 2% daily range is a sleepy day for a memecoin and a crisis for a major pair.
 * The only question with a portable answer is "is this asset moving more than it
 * usually does?".
 */
export function atrPercentile(
  candles: readonly Candle[],
  window = 14,
  lookback = 100,
): number | null {
  invariant(Number.isInteger(lookback) && lookback > 1, 'atrPercentile lookback must be > 1')
  const series = atr(candles, window)
  const defined = series.filter((v): v is number => v !== null)
  if (defined.length < 2) return null

  const current = defined[defined.length - 1]
  if (current === undefined) return null
  const history = defined.slice(-lookback)
  return percentileRank(history, current)
}

export type VolatilityRegimeLabel = 'low' | 'normal' | 'elevated' | 'extreme'

/**
 * Classify the current volatility regime.
 *
 * The percentile does the primary work, but percentiles are slow to react: a
 * genuine regime break — volatility doubling in a handful of bars — can only
 * reach the 100th percentile, and "100th percentile" is also where a mild drift
 * upward eventually lands. So a separate REGIME-BREAK check compares current ATR
 * to the median of its history and promotes the label one step when the ratio
 * exceeds 1.75×. This is what stops the system describing the first hour of a
 * liquidation cascade as merely "elevated" because the percentile has not had
 * time to distinguish it from last week's grind.
 */
export function volatilityRegime(
  candles: readonly Candle[],
  window = 14,
  lookback = 100,
): VolatilityRegimeLabel {
  const percentile = atrPercentile(candles, window, lookback)
  if (percentile === null) return 'normal'

  const order: VolatilityRegimeLabel[] = ['low', 'normal', 'elevated', 'extreme']
  let idx: number
  if (percentile < 0.25) idx = 0
  else if (percentile < 0.7) idx = 1
  else if (percentile < 0.9) idx = 2
  else idx = 3

  const series = atr(candles, window).filter((v): v is number => v !== null)
  const current = series[series.length - 1]
  const history = series.slice(-lookback)
  if (current !== undefined && history.length >= 5) {
    const median = medianOf(history)
    if (median > 0 && current / median >= 1.75) idx = Math.min(order.length - 1, idx + 1)
  }

  return order[idx] ?? 'normal'
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

/** Minimum candles needed before a forecast is meaningful rather than decorative. */
export const MIN_FORECAST_CANDLES = 30

/**
 * z-score for the reported range. 1.645 ≈ the 90% two-sided band under a normal
 * assumption. Crypto returns are fat-tailed, so the TRUE coverage of this band is
 * lower than 90% — it is reported as a range, never as a guarantee, and the
 * disclaimer on every prediction says so.
 */
const RANGE_Z = 1.645

/**
 * Blended volatility forecast over `horizonPeriods` candles.
 *
 * Two estimators are blended rather than one being chosen:
 *
 *  - EWMA on close-to-close returns is REACTIVE. It is dominated by the last
 *    handful of bars, so it turns quickly when a regime changes — and it is
 *    noisy, because a single bar can move it a long way.
 *
 *  - Garman–Klass on OHLC is EFFICIENT. It extracts several times more
 *    information per bar, so its estimate is far more stable — and it is slower,
 *    because that stability comes from averaging a window, and it under-reads
 *    through jumps (see `parkinsonVolatility`, same failure mode).
 *
 * Their errors are close to uncorrelated: one is wrong when the regime turns,
 * the other is wrong when a single bar is unrepresentative. Averaging two
 * estimators with uncorrelated errors and comparable bias beats either alone for
 * the same reason the ensemble in `core/prediction/ensemble.ts` beats its best
 * member — variance falls faster than bias rises. The 60/40 tilt toward EWMA
 * reflects that for SHORT horizons (which is all we forecast) reacting to the
 * current regime matters more than measuring the average one precisely.
 *
 * Their DISAGREEMENT is also used, as the main input to `confidence`: when the
 * reactive and the efficient estimator say the same thing, the volatility
 * picture is stable and the forecast deserves to be believed; when they diverge
 * by 2×, something is changing and the honest answer is a low confidence.
 *
 * Scaling to the horizon is √h, which assumes independent increments. Volatility
 * clustering violates that assumption in the direction of understating multi-
 * period risk, so `confidence` decays with horizon as well.
 *
 * Throws `InsufficientDataError` rather than returning a shrugging default: a
 * volatility forecast is a model output, and per house convention a model that
 * cannot run must abstain so the ensemble drops it, not emit a placeholder that
 * gets averaged in as if it were evidence.
 */
export function forecastVolatility(
  candles: readonly Candle[],
  horizonPeriods: number,
): VolatilityForecast {
  invariant(
    Number.isFinite(horizonPeriods) && horizonPeriods > 0,
    'horizonPeriods must be positive',
  )
  if (candles.length < MIN_FORECAST_CANDLES) {
    throw new InsufficientDataError(
      `${MIN_FORECAST_CANDLES} candles`,
      `Volatility forecast needs ${MIN_FORECAST_CANDLES} candles, received ${candles.length}`,
    )
  }

  const window = Math.min(20, Math.max(2, Math.floor(candles.length / 3)))
  const returns = logReturns(candles.map((c) => c.close))

  const ewmaSeries = ewmaVolatility(returns)
  const ewmaSigma = ewmaSeries[ewmaSeries.length - 1] ?? 0

  const gkSeries = garmanKlassVolatility(candles, window)
  const gkDefined = gkSeries.filter((v): v is number => v !== null)
  const gkSigma = gkDefined[gkDefined.length - 1] ?? 0

  const blended = 0.6 * ewmaSigma + 0.4 * gkSigma
  const horizonSigma = blended * Math.sqrt(horizonPeriods)

  // Agreement between the two estimators, 1 when identical, → 0 as one is a
  // large multiple of the other.
  const larger = Math.max(ewmaSigma, gkSigma)
  const smaller = Math.min(ewmaSigma, gkSigma)
  const agreement = larger === 0 ? 1 : clamp01(smaller / larger)

  // Sample adequacy: 200 candles is treated as fully sufficient.
  const sampleScore = clamp01(candles.length / 200)

  // Horizon decay: sqrt-of-time scaling degrades as the horizon lengthens
  // because return independence degrades. 1 period ≈ 1.0, 24 ≈ 0.65.
  const horizonPenalty = 1 / (1 + Math.log(1 + horizonPeriods) / 6)

  const confidence = clamp01((0.55 * agreement + 0.45 * sampleScore) * horizonPenalty)

  return {
    // 1σ move over the horizon, as a fraction of price.
    expectedMove: horizonSigma,
    regime: volatilityRegime(candles),
    // Symmetric in LOG space would be asymmetric in price space; the interface
    // asks for symmetric fractions, so the band is reported as ±z·σ√h.
    rangeLow: -RANGE_Z * horizonSigma,
    rangeHigh: RANGE_Z * horizonSigma,
    confidence,
  }
}
