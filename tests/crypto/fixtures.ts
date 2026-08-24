/**
 * Deterministic test fixtures.
 *
 * `Math.random()` is banned in these tests. A property test that fails on one
 * run in fifty and passes on the CI re-run is worse than no test at all: it
 * trains everyone to hit retry. Everything random here comes from mulberry32
 * seeded with an explicit constant, so a failure is reproducible forever by
 * anyone who reads the seed out of the failure message.
 */

import type { CryptoFeatures } from '@/engines/crypto/features'
import type { Candle, OrderBook, OrderBookLevel } from '@/providers/types'

/**
 * mulberry32 — a 32-bit seeded PRNG. Tiny, fast, and good enough for fixture
 * generation (it passes gjrand's basic suite); the only property we actually
 * need is that the same seed yields the same stream on every machine.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HOUR = 3_600_000

export interface CandleInit {
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume?: number
  readonly takerBuyVolume?: number | null
  readonly openTime?: number
}

export function makeCandle(init: CandleInit, index = 0): Candle {
  const openTime = init.openTime ?? index * HOUR
  return {
    openTime,
    open: init.open,
    high: init.high,
    low: init.low,
    close: init.close,
    volume: init.volume ?? 1_000,
    closeTime: openTime + HOUR - 1,
    trades: 100,
    takerBuyVolume: init.takerBuyVolume === undefined ? null : init.takerBuyVolume,
  }
}

/** Build candles from a close series, deriving a plausible OHLC around each close. */
export function candlesFromCloses(
  closeSeries: readonly number[],
  opts: { wickPct?: number; volume?: number | ((i: number) => number) } = {},
): Candle[] {
  const wickPct = opts.wickPct ?? 0.002
  return closeSeries.map((close, i) => {
    const open = i === 0 ? close : (closeSeries[i - 1] ?? close)
    const volume =
      typeof opts.volume === 'function' ? opts.volume(i) : (opts.volume ?? 1_000)
    return makeCandle(
      {
        open,
        high: Math.max(open, close) * (1 + wickPct),
        low: Math.min(open, close) * (1 - wickPct),
        close,
        volume,
      },
      i,
    )
  })
}

/** A seeded geometric random walk. Same seed ⇒ byte-identical series. */
export function randomWalkCloses(
  count: number,
  opts: { seed?: number; start?: number; stepPct?: number } = {},
): number[] {
  const rand = mulberry32(opts.seed ?? 42)
  const stepPct = opts.stepPct ?? 0.01
  let price = opts.start ?? 100
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    price *= 1 + (rand() - 0.5) * 2 * stepPct
    out.push(price)
  }
  return out
}

export function randomWalkCandles(
  count: number,
  opts: { seed?: number; start?: number; stepPct?: number; withTaker?: boolean } = {},
): Candle[] {
  const rand = mulberry32((opts.seed ?? 42) + 7)
  const closeSeries = randomWalkCloses(count, opts)
  return closeSeries.map((close, i) => {
    const open = i === 0 ? close : (closeSeries[i - 1] ?? close)
    const wick = 1 + rand() * 0.004
    const volume = 500 + rand() * 1_500
    return makeCandle(
      {
        open,
        high: Math.max(open, close) * wick,
        low: Math.min(open, close) / wick,
        close,
        volume,
        takerBuyVolume: opts.withTaker === true ? volume * (0.3 + rand() * 0.4) : null,
      },
      i,
    )
  })
}

/** A perfectly flat market — the degenerate case every estimator must survive. */
export function flatCandles(count: number, price = 100, volume = 1_000): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < count; i++) {
    out.push(makeCandle({ open: price, high: price, low: price, close: price, volume }, i))
  }
  return out
}

export function makeBook(
  bids: readonly (readonly [number, number])[],
  asks: readonly (readonly [number, number])[],
  symbol = 'BTCUSDT',
): OrderBook {
  const toLevels = (rows: readonly (readonly [number, number])[]): OrderBookLevel[] =>
    rows.map(([price, quantity]) => ({ price, quantity }))
  return {
    symbol,
    bids: toLevels(bids),
    asks: toLevels(asks),
    timestamp: 1_700_000_000_000,
  }
}

/**
 * A CryptoFeatures object with EVERY feature null — the "no data at all"
 * state every model must abstain on. Tests override individual fields to
 * construct precise bullish/bearish feature sets without dragging the whole
 * indicator pipeline into a unit test of a model's weights.
 */
export function nullFeatures(overrides: Partial<CryptoFeatures> = {}): CryptoFeatures {
  return {
    timeframe: '1h',
    nowMs: 1_700_000_000_000,
    candleCount: 0,
    spot: null,
    rsi: null,
    rsiPercentile: null,
    macdHistogramAtr: null,
    percentB: null,
    priceVsSma20: null,
    priceVsSma50: null,
    priceVsSma200: null,
    priceZScore: null,
    emaCrossState: null,
    adx: null,
    diSpread: null,
    obvSlope: null,
    atrPercentile: null,
    trendStructure: null,
    nearestSupport: null,
    nearestResistance: null,
    consolidationScore: null,
    breakout: null,
    bookImbalance: null,
    bookDepthScore: null,
    nearestBidWall: null,
    nearestAskWall: null,
    aggressorImbalance: null,
    aggressorCoverage: null,
    fundingRate: null,
    openInterest: null,
    oiToVolume24h: null,
    realisedVol: null,
    volForecast: null,
    volRegime: null,
    ret1: null,
    ret5: null,
    ret20: null,
    ...overrides,
  }
}

/**
 * A symmetric ladder around `mid`: identical sizes, identical tick spacing on
 * both sides. Any imbalance measure must read exactly 0 on this book.
 */
export function symmetricBook(
  mid = 100,
  levels = 10,
  tick = 0.1,
  size = 5,
): OrderBook {
  const bids: [number, number][] = []
  const asks: [number, number][] = []
  for (let i = 0; i < levels; i++) {
    bids.push([mid - tick * (i + 1), size])
    asks.push([mid + tick * (i + 1), size])
  }
  return makeBook(bids, asks)
}
