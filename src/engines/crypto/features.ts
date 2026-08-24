/**
 * The crypto feature builder.
 *
 * This is the single seam between the raw data layers (indicators, structure,
 * order flow, volatility) and the model ensemble. Models never touch candles or
 * books directly — they receive a frozen `CryptoFeatures` snapshot, which is
 * what makes every model pure, testable in isolation, and replayable at any
 * historical instant.
 *
 * Two conventions govern everything in this file:
 *
 *  1. EVERY FEATURE IS `null` WHEN ITS INPUT IS UNAVAILABLE — never a default,
 *     never a zero-fill, never a "reasonable" fallback. A null feature causes
 *     the models that need it to abstain, which is the designed behaviour. A
 *     defaulted feature would silently convert "we don't know" into "we know
 *     it's neutral", which are different claims (see ensemble.ts).
 *
 *  2. ALL FEATURES ARE NORMALISED TO BE SCALE-FREE: z-scores, percentiles,
 *     fractions of price, or ATR multiples. Raw dollar quantities are useless
 *     to models that must work identically on a $0.15 memecoin and $118,000
 *     BTC (see the tolerance discussion in structure.supportResistance).
 *
 * ---------------------------------------------------------------------------
 * Timeframe → candle-window mapping
 * ---------------------------------------------------------------------------
 * TIMEFRAMES ARE NEVER MIXED (plan §10). Each prediction timeframe reads
 * candles of a matching interval, so the features describe dynamics at the
 * scale being predicted. Predicting 24h/7d/30d from a same-interval candle is
 * impossible (there is no '24h' or '7d' candle), so those horizons read a
 * finer interval and scale the volatility forecast by the horizon period
 * count:
 *
 *   | prediction | candle interval | horizon periods | window @ 250 candles |
 *   |------------|-----------------|-----------------|----------------------|
 *   | 15m        | 15m             | 1               | ≈ 2.6 days           |
 *   | 1h         | 1h              | 1               | ≈ 10 days            |
 *   | 4h         | 4h              | 1               | ≈ 6 weeks            |
 *   | 24h        | 1h              | 24              | ≈ 10 days            |
 *   | 7d         | 4h              | 42              | ≈ 6 weeks            |
 *   | 30d        | 1d              | 30              | ≈ 8 months           |
 *
 * A 15m prediction therefore reads 15m candles, a 1h prediction 1h candles,
 * and so on. The horizon period count is what `forecastVolatility` uses to
 * scale a per-candle sigma up to the prediction horizon.
 *
 * Pure: no I/O, no Date.now() (the evaluation instant arrives as `nowMs`),
 * no randomness.
 */

import type { Timeframe, VolatilityForecast } from '@/core/prediction/types'
import { InsufficientDataError } from '@/core/errors'
import type {
  Candle,
  CandleInterval,
  DerivativesData,
  MarketData,
  OrderBook,
} from '@/providers/types'
import {
  adx,
  atr,
  bollingerBands,
  ema,
  macd,
  obv,
  rollingStdDev,
  rsi,
  sma,
} from './indicators'
import {
  aggressorImbalance,
  bookDepthScore,
  detectWalls,
  orderBookImbalance,
  type BookWall,
} from './orderflow'
import {
  consolidationScore,
  detectBreakout,
  supportResistance,
  trendStructure,
  type BreakoutSignal,
  type TrendStructure,
} from './structure'
import {
  atrPercentile,
  forecastVolatility,
  realisedVolatility,
  percentileRank,
  volatilityRegime,
  type VolatilityRegimeLabel,
} from './volatility'

// ---------------------------------------------------------------------------
// Timeframe specification
// ---------------------------------------------------------------------------

export interface TimeframeSpec {
  readonly interval: CandleInterval
  /** How many candles of `interval` make up the prediction horizon. */
  readonly horizonPeriods: number
}

/** The table from the header, as data. See the comment block above. */
export const TIMEFRAME_SPECS: Readonly<Partial<Record<Timeframe, TimeframeSpec>>> = {
  '15m': { interval: '15m', horizonPeriods: 1 },
  '1h': { interval: '1h', horizonPeriods: 1 },
  '4h': { interval: '4h', horizonPeriods: 1 },
  '24h': { interval: '1h', horizonPeriods: 24 },
  '7d': { interval: '4h', horizonPeriods: 42 },
  '30d': { interval: '1d', horizonPeriods: 30 },
}

// ---------------------------------------------------------------------------
// Feature shape
// ---------------------------------------------------------------------------

/** Proximity of price to a support/resistance level, in scale-free units. */
export interface LevelProximity {
  /** Distance from the last close to the level, in ATR multiples. */
  readonly distanceAtr: number
  /** The level's strength score, 0..1 (see structure.supportResistance). */
  readonly strength: number
  readonly price: number
}

export interface CryptoFeatures {
  readonly timeframe: Timeframe
  /** Evaluation instant, injected — never Date.now(). */
  readonly nowMs: number
  readonly candleCount: number
  /** Last close, needed downstream for scenario target ranges. */
  readonly spot: number | null

  // -- indicator layer -------------------------------------------------------
  /** RSI(14), 0..100. */
  readonly rsi: number | null
  /** Where the current RSI sits within its own recent history, 0..1. */
  readonly rsiPercentile: number | null
  /** MACD histogram normalised by ATR — scale-free momentum-of-momentum. */
  readonly macdHistogramAtr: number | null
  /** Bollinger %B: 0 at the lower band, 1 at the upper; may exceed [0,1]. */
  readonly percentB: number | null
  /** (close − SMA_n) / SMA_n. */
  readonly priceVsSma20: number | null
  readonly priceVsSma50: number | null
  readonly priceVsSma200: number | null
  /** (close − SMA20) / rollingStd20 — the classic mean-reversion z-score. */
  readonly priceZScore: number | null
  /** State (not event) of EMA12 vs EMA26: which side is the fast EMA on. */
  readonly emaCrossState: 'bullish' | 'bearish' | null
  /** ADX(14) trend strength, 0..100 — direction-agnostic. */
  readonly adx: number | null
  /** +DI − −DI: the DIRECTION that ADX measures the strength of. */
  readonly diSpread: number | null
  /** OBV change over the window divided by total volume — roughly −1..1. */
  readonly obvSlope: number | null
  /** Where current ATR sits in its own history, 0..1. */
  readonly atrPercentile: number | null

  // -- structure layer -------------------------------------------------------
  readonly trendStructure: TrendStructure | null
  /** Nearest strong support BELOW price (strength ≥ 0.3). */
  readonly nearestSupport: LevelProximity | null
  /** Nearest strong resistance ABOVE price (strength ≥ 0.3). */
  readonly nearestResistance: LevelProximity | null
  /** How range-bound the recent window is, 0..1. */
  readonly consolidationScore: number | null
  /** Most recent bar classified against the level set (may be type 'none'). */
  readonly breakout: BreakoutSignal | null

  // -- order flow (null-tolerant: book may be absent entirely) ---------------
  /** Resting-depth imbalance, −1..1, bid-positive. */
  readonly bookImbalance: number | null
  /** 0..1 liquidity heuristic for the whole book. */
  readonly bookDepthScore: number | null
  readonly nearestBidWall: BookWall | null
  readonly nearestAskWall: BookWall | null
  /** EXECUTED aggressor imbalance, −1..1 — null when the venue omits taker side. */
  readonly aggressorImbalance: number | null
  /** Fraction of the window's candles that reported taker volume, 0..1. */
  readonly aggressorCoverage: number | null

  // -- derivatives / market (null-tolerant) -----------------------------------
  readonly fundingRate: number | null
  readonly openInterest: number | null
  /** OI notional / 24h quote volume — how leveraged the market is vs its flow. */
  readonly oiToVolume24h: number | null

  // -- volatility --------------------------------------------------------------
  /** Realised per-period sigma (close-to-close, 20-bar window). */
  readonly realisedVol: number | null
  /** Blended EWMA/Garman–Klass forecast over the prediction horizon. */
  readonly volForecast: VolatilityForecast | null
  readonly volRegime: VolatilityRegimeLabel | null

  // -- return momentum over multiple windows (log returns) --------------------
  readonly ret1: number | null
  readonly ret5: number | null
  readonly ret20: number | null
}

export interface CryptoFeatureInput {
  readonly candles: readonly Candle[]
  readonly book: OrderBook | null
  readonly derivatives: DerivativesData | null
  readonly market: MarketData | null
  readonly timeframe: Timeframe
  readonly nowMs: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lastDefined(series: readonly (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i]
    if (v !== null && v !== undefined) return v
  }
  return null
}

function definedValues(series: readonly (number | null)[]): number[] {
  return series.filter((v): v is number => v !== null && v !== undefined)
}

/** Log return over the last `window` bars, or null with insufficient data. */
function windowReturn(closeSeries: readonly number[], window: number): number | null {
  const n = closeSeries.length
  if (n <= window) return null
  const cur = closeSeries[n - 1]
  const prev = closeSeries[n - 1 - window]
  if (cur === undefined || prev === undefined || cur <= 0 || prev <= 0) return null
  return Math.log(cur / prev)
}

/** (close − ma) / ma, or null when the MA is not yet defined. */
function relativeToMa(close: number | null, ma: number | null): number | null {
  if (close === null || ma === null || ma <= 0) return null
  return (close - ma) / ma
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Aggressor flow is measured over the most recent slice of the window so it
 *  describes CURRENT participation, not the average of the whole lookback. */
const AGGRESSOR_WINDOW = 30
/** OBV slope window. */
const OBV_WINDOW = 20
/** Minimum level strength before an S/R level counts as "strong". */
const STRONG_LEVEL_MIN_STRENGTH = 0.3

export function buildCryptoFeatures(input: CryptoFeatureInput): CryptoFeatures {
  const { candles, book, derivatives, market, timeframe, nowMs } = input
  const n = candles.length
  const closeSeries = candles.map((c) => c.close)
  const lastClose = n > 0 ? (closeSeries[n - 1] ?? null) : null

  // -- indicators ------------------------------------------------------------
  const rsiSeries = rsi(closeSeries, 14)
  const rsiValue = lastDefined(rsiSeries)
  const rsiHistory = definedValues(rsiSeries).slice(-100)
  const rsiPct =
    rsiValue !== null && rsiHistory.length >= 3 ? percentileRank(rsiHistory, rsiValue) : null

  const atrSeries = atr(candles, 14)
  const atrValue = lastDefined(atrSeries)

  const macdSeries = macd(closeSeries)
  const histValue = lastDefined(macdSeries.histogram)
  const macdHistogramAtr =
    histValue !== null && atrValue !== null && atrValue > 0 ? histValue / atrValue : null

  const bands = bollingerBands(closeSeries, 20)
  const percentB = lastDefined(bands.percentB)

  const sma20 = lastDefined(sma(closeSeries, 20))
  const sma50 = n >= 50 ? lastDefined(sma(closeSeries, 50)) : null
  const sma200 = n >= 200 ? lastDefined(sma(closeSeries, 200)) : null
  const std20 = lastDefined(rollingStdDev(closeSeries, 20))
  // A flat window (std 0) with price exactly at the mean is honestly z = 0;
  // a flat window with price off the mean cannot happen (mean of constants).
  const priceZScore =
    lastClose !== null && sma20 !== null && std20 !== null
      ? std20 === 0
        ? 0
        : (lastClose - sma20) / std20
      : null

  const emaFast = lastDefined(ema(closeSeries, 12))
  const emaSlow = lastDefined(ema(closeSeries, 26))
  const emaCrossState: 'bullish' | 'bearish' | null =
    emaFast === null || emaSlow === null || emaFast === emaSlow
      ? null
      : emaFast > emaSlow
        ? 'bullish'
        : 'bearish'

  const adxSeries = adx(candles, 14)
  const adxValue = lastDefined(adxSeries.adx)
  const plusDI = lastDefined(adxSeries.plusDI)
  const minusDI = lastDefined(adxSeries.minusDI)
  const diSpread = plusDI !== null && minusDI !== null ? plusDI - minusDI : null

  const obvSlope = computeObvSlope(candles)

  // -- structure ---------------------------------------------------------------
  const structure = n >= 10 ? trendStructure(candles) : null
  const levels = supportResistance(candles)
  const strong = levels.filter((l) => l.strength >= STRONG_LEVEL_MIN_STRENGTH)
  const nearestSupport = nearestLevel(strong, 'support', lastClose, atrValue)
  const nearestResistance = nearestLevel(strong, 'resistance', lastClose, atrValue)
  const consolidation = n >= 22 ? consolidationScore(candles) : null
  const breakout = n >= 5 && levels.length > 0 ? detectBreakout(candles, levels) : null

  // -- order flow ---------------------------------------------------------------
  let bookImb: number | null = null
  let depthScore: number | null = null
  let nearestBidWall: BookWall | null = null
  let nearestAskWall: BookWall | null = null
  if (book !== null && (book.bids.length > 0 || book.asks.length > 0)) {
    bookImb = orderBookImbalance(book).imbalance
    depthScore = bookDepthScore(book)
    const walls = detectWalls(book)
    nearestBidWall = walls.find((w) => w.side === 'bid') ?? null
    nearestAskWall = walls.find((w) => w.side === 'ask') ?? null
  }

  const aggressor = aggressorImbalance(candles.slice(-AGGRESSOR_WINDOW))

  // -- derivatives / market -------------------------------------------------------
  const fundingRate = derivatives?.fundingRate ?? null
  const openInterest = derivatives?.openInterest ?? null
  const oiValue = derivatives?.openInterestValue ?? null
  const oiToVolume24h =
    oiValue !== null && market !== null && market.quoteVolume24h > 0
      ? oiValue / market.quoteVolume24h
      : null

  // -- volatility -----------------------------------------------------------------
  const realisedVol = lastDefined(realisedVolatility(candles, 20))
  const spec = TIMEFRAME_SPECS[timeframe]
  let volForecast: VolatilityForecast | null = null
  try {
    volForecast = forecastVolatility(candles, spec?.horizonPeriods ?? 1)
  } catch (e) {
    // Insufficient candles: the forecast honestly does not exist. Anything
    // else is a bug and must propagate.
    if (!(e instanceof InsufficientDataError)) throw e
    volForecast = null
  }
  const atrPct = atrPercentile(candles)
  const volRegime = atrPct !== null ? volatilityRegime(candles) : null

  return {
    timeframe,
    nowMs,
    candleCount: n,
    spot: lastClose,
    rsi: rsiValue,
    rsiPercentile: rsiPct,
    macdHistogramAtr,
    percentB,
    priceVsSma20: relativeToMa(lastClose, sma20),
    priceVsSma50: relativeToMa(lastClose, sma50),
    priceVsSma200: relativeToMa(lastClose, sma200),
    priceZScore,
    emaCrossState,
    adx: adxValue,
    diSpread,
    obvSlope,
    atrPercentile: atrPct,
    trendStructure: structure,
    nearestSupport,
    nearestResistance,
    consolidationScore: consolidation,
    breakout,
    bookImbalance: bookImb,
    bookDepthScore: depthScore,
    nearestBidWall,
    nearestAskWall,
    aggressorImbalance: aggressor?.imbalance ?? null,
    aggressorCoverage: aggressor?.coverage ?? null,
    fundingRate,
    openInterest,
    oiToVolume24h,
    realisedVol,
    volForecast,
    volRegime,
    ret1: windowReturn(closeSeries, 1),
    ret5: windowReturn(closeSeries, 5),
    ret20: windowReturn(closeSeries, 20),
  }
}

/**
 * OBV change over the trailing window divided by total volume in that window.
 *
 * OBV's absolute level is meaningless (see indicators.obv); the slope is the
 * feature, and dividing by traded volume bounds it to roughly [−1, 1]: +1
 * means every unit of volume in the window traded on an up-close.
 */
function computeObvSlope(candles: readonly Candle[]): number | null {
  const n = candles.length
  if (n < OBV_WINDOW + 1) return null
  const series = obv(candles)
  const last = series[n - 1]
  const prior = series[n - 1 - OBV_WINDOW]
  if (last === null || last === undefined || prior === null || prior === undefined) return null

  let totalVolume = 0
  for (let i = n - OBV_WINDOW; i < n; i++) {
    const c = candles[i]
    if (c === undefined) continue
    totalVolume += c.volume
  }
  if (totalVolume <= 0) return null
  return (last - prior) / totalVolume
}

function nearestLevel(
  levels: readonly { price: number; strength: number; type: 'support' | 'resistance' }[],
  type: 'support' | 'resistance',
  lastClose: number | null,
  atrValue: number | null,
): LevelProximity | null {
  if (lastClose === null || atrValue === null || atrValue <= 0) return null
  let best: LevelProximity | null = null
  for (const level of levels) {
    if (level.type !== type) continue
    const distanceAtr = Math.abs(lastClose - level.price) / atrValue
    if (best === null || distanceAtr < best.distanceAtr) {
      best = { distanceAtr, strength: level.strength, price: level.price }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

/**
 * Fraction of the feature groups that are actually populated, 0..1.
 *
 * Feeds `computeConfidence.featureCompleteness`. Grouped rather than counted
 * per-field so that one missing order book (which nulls four fields) is not
 * quadruple-counted against completeness.
 */
export function cryptoFeatureCompleteness(f: CryptoFeatures): number {
  const groups: readonly boolean[] = [
    f.rsi !== null,
    f.macdHistogramAtr !== null,
    f.percentB !== null,
    f.priceVsSma20 !== null,
    f.priceVsSma50 !== null,
    f.priceVsSma200 !== null,
    f.emaCrossState !== null,
    f.adx !== null,
    f.obvSlope !== null,
    f.atrPercentile !== null,
    f.trendStructure !== null,
    f.nearestSupport !== null || f.nearestResistance !== null,
    f.consolidationScore !== null,
    f.bookImbalance !== null,
    f.aggressorImbalance !== null,
    f.fundingRate !== null,
    f.volForecast !== null,
    f.ret5 !== null,
  ]
  if (groups.length === 0) return 0
  let present = 0
  for (const g of groups) if (g) present++
  return present / groups.length
}
