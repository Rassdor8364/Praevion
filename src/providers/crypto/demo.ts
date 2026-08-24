/**
 * ============================================================================
 * DEMO CRYPTO PROVIDER — SYNTHETIC DATA. NOT A MARKET.
 * ============================================================================
 *
 * This provider exists so the UI, the model pipeline and the end-to-end tests
 * can be developed and demonstrated without any API keys or network access. It
 * fabricates every number it returns.
 *
 * Its safety property is provenance, not plausibility: every payload is stamped
 * `isDemo: true`, which forces `dataMode: 'demo'` on any prediction that touches
 * it, and predictions with `dataMode !== 'live'` are excluded from ALL accuracy
 * statistics. Nothing generated here can ever inflate a published hit rate.
 *
 * The registry only registers demo providers when VIXERA_ALLOW_DEMO is set and
 * (barring an explicit prod override) we are not in production — see
 * `demoAllowed()` in registry.ts.
 *
 * The series is DETERMINISTIC: identical inputs give identical output on every
 * machine and every run, so a screenshot, a snapshot test and a bug report all
 * describe the same numbers. That is why Math.random() is banned in this file
 * except as the seeded PRNG below, which is not Math.random at all.
 * ============================================================================
 */

import { ProviderError } from '@/core/errors'
import { err, ok } from '@/core/result'
import type {
  Candle,
  CandleInterval,
  Capability,
  CryptoProvider,
  DerivativesData,
  MarketData,
  OrderBook,
  OrderBookLevel,
  PriceTick,
  ProviderHealth,
  ProviderResult,
  Sourced,
} from '../types'

const PROVIDER_ID = 'demo-crypto'

const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

/**
 * Anchor levels so a demo BTC does not print at $3. Anything unmapped gets a
 * price derived from its own name hash, which keeps unknown symbols stable too.
 */
const BASE_PRICE: Record<string, number> = {
  BTC: 64_000,
  ETH: 3_200,
  SOL: 148,
  XRP: 0.62,
  BNB: 585,
  DOGE: 0.163,
  ADA: 0.47,
  AVAX: 27.5,
  LINK: 14.8,
  MATIC: 0.55,
}

export class DemoCryptoProvider implements CryptoProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'Demo Crypto (synthetic)'
  readonly reliability = 'UNVERIFIED' as const
  readonly isDemo = true
  readonly capabilities: readonly Capability[] = [
    'crypto.price',
    'crypto.candles',
    'crypto.orderbook',
    'crypto.market',
    'crypto.derivatives',
  ]

  isConfigured(): boolean {
    return true // nothing to configure; generation is local
  }

  async health(): Promise<ProviderHealth> {
    // Always healthy and instantaneous — there is no upstream to be down.
    return { healthy: true, latencyMs: 0, message: 'synthetic provider' }
  }

  async getPrice(symbol: string): Promise<ProviderResult<PriceTick>> {
    const now = Date.now()
    // Sampled on the 1m grid so the price a chart's last candle closes at and
    // the price the ticker shows agree with each other.
    const price = priceAt(symbol, now / INTERVAL_MS['1m'])
    return ok(sourced<PriceTick>({ symbol, price, timestamp: now }, now))
  }

  async getCandles(
    symbol: string,
    interval: CandleInterval,
    limit: number,
  ): Promise<ProviderResult<Candle[]>> {
    const step = INTERVAL_MS[interval]
    const capped = Math.min(Math.max(limit, 1), 1000)
    // Bucket indices are absolute (epoch / step), not relative to `now`, so a
    // given candle keeps the same OHLC no matter when or how often it is asked
    // for — the series only ever grows a new bar on the right.
    const latestIndex = Math.floor(Date.now() / step)
    const firstIndex = latestIndex - capped + 1

    const candles: Candle[] = []
    for (let i = firstIndex; i <= latestIndex; i++) {
      candles.push(candleAt(symbol, interval, i, step))
    }

    const newest = candles[candles.length - 1]
    return ok(sourced(candles, newest ? newest.closeTime : Date.now()))
  }

  async getOrderBook(symbol: string, depth: number): Promise<ProviderResult<OrderBook>> {
    const levels = Math.min(Math.max(depth, 1), 200)
    const now = Date.now()
    const mid = priceAt(symbol, now / INTERVAL_MS['1m'])
    // Book snapshots are keyed to the current minute rather than the millisecond
    // so repeated reads inside a minute are consistent with each other.
    const rand = mulberry32(hash32(`${normalise(symbol)}|book|${Math.floor(now / 60_000)}`))

    // Spread and size grow with distance from mid, which is what a real book
    // looks like and what makes the imbalance metric produce a sane number.
    const tick = mid * 0.0001
    const bids: OrderBookLevel[] = []
    const asks: OrderBookLevel[] = []
    for (let i = 0; i < levels; i++) {
      const offset = tick * (i + 1)
      const depthFactor = 1 + i * 0.35
      bids.push({
        price: round(mid - offset, mid),
        quantity: round((0.4 + rand() * 1.6) * depthFactor, 1),
      })
      asks.push({
        price: round(mid + offset, mid),
        quantity: round((0.4 + rand() * 1.6) * depthFactor, 1),
      })
    }

    return ok(sourced<OrderBook>({ symbol, bids, asks, timestamp: now }, now))
  }

  async getMarketData(symbol: string): Promise<ProviderResult<MarketData>> {
    const now = Date.now()
    const step = INTERVAL_MS['1h']
    const latestIndex = Math.floor(now / step)
    // Derived from the same 24 hourly candles the chart would draw, so the
    // header stats and the chart can never disagree.
    const window: Candle[] = []
    for (let i = latestIndex - 23; i <= latestIndex; i++) {
      window.push(candleAt(symbol, '1h', i, step))
    }

    const first = window[0]
    const last = window[window.length - 1]
    if (!first || !last) return err(generationFailed('24h window was empty'))

    let high = last.high
    let low = last.low
    let volume = 0
    for (const c of window) {
      if (c.high > high) high = c.high
      if (c.low < low) low = c.low
      volume += c.volume
    }

    const price = last.close
    const supply = circulatingSupply(symbol)

    return ok(
      sourced<MarketData>(
        {
          symbol,
          price,
          change24hPct: first.open > 0 ? ((price - first.open) / first.open) * 100 : 0,
          high24h: high,
          low24h: low,
          volume24h: volume,
          quoteVolume24h: volume * price,
          // Unlike the live exchange adapters, the demo CAN quote a market cap:
          // its "circulating supply" is a fixed made-up constant, and every
          // consumer already knows the whole payload is synthetic.
          marketCap: supply * price,
          timestamp: now,
        },
        now,
      ),
    )
  }

  async getDerivatives(symbol: string): Promise<ProviderResult<DerivativesData>> {
    const now = Date.now()
    const price = priceAt(symbol, now / INTERVAL_MS['1m'])
    // Funding is re-seeded per 8h epoch to mirror the real settlement cadence,
    // so a demo funding chart shows steps rather than continuous drift.
    const fundingEpoch = Math.floor(now / 28_800_000)
    const rand = mulberry32(hash32(`${normalise(symbol)}|funding|${fundingEpoch}`))
    // Centred on zero, roughly ±0.05% — the band real perps spend most of their
    // life inside.
    const fundingRate = (rand() - 0.5) * 0.001
    const openInterest = round(circulatingSupply(symbol) * 0.004 * (0.8 + rand() * 0.4), 1)

    return ok(
      sourced<DerivativesData>(
        {
          symbol,
          fundingRate,
          nextFundingTime: (fundingEpoch + 1) * 28_800_000,
          openInterest,
          openInterestValue: openInterest * price,
          timestamp: now,
        },
        now,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// Deterministic generation
// ---------------------------------------------------------------------------

/**
 * mulberry32 — 32-bit PRNG, ~2^32 period, uniform enough for display data and,
 * crucially, reproducible from an integer seed. Math.random() cannot be used
 * here: it would make every reload of the demo show different history, breaking
 * snapshot tests and making bug reports unreproducible.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a: cheap, well-dispersed string→u32 so symbol names seed distinct series. */
function hash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** One deterministic draw for an integer lattice point. */
function latticeValue(seed: number, n: number): number {
  return mulberry32((seed ^ Math.imul(n, 0x9e3779b1)) >>> 0)()
}

/**
 * Smoothed value noise in [-1, 1].
 *
 * A naive cumulative random walk would need every prior step to compute the
 * current one, which makes "give me candle #4,821,003" O(n) and non-local.
 * Interpolated lattice noise is O(1) per point and still produces trends,
 * pullbacks and consolidation — the shapes the indicators need to chew on.
 */
function noiseAt(seed: number, x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const a = latticeValue(seed, i)
  const b = latticeValue(seed, i + 1)
  // Smoothstep: continuous first derivative, so no visible kinks at bar edges.
  const t = f * f * (3 - 2 * f)
  return (a + (b - a) * t) * 2 - 1
}

function normalise(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[-/]/g, '')
  return s.endsWith('USDT') ? s.slice(0, -4) : s.endsWith('USD') ? s.slice(0, -3) : s
}

function basePrice(symbol: string): number {
  const base = normalise(symbol)
  const known = BASE_PRICE[base]
  if (known !== undefined) return known
  // Unmapped symbols still get a stable, plausible level rather than a constant.
  return 5 + (hash32(base) % 500)
}

function circulatingSupply(symbol: string): number {
  const base = normalise(symbol)
  const price = basePrice(symbol)
  // Chosen so cap lands in a believable band for the price level rather than
  // pretending to know a real supply figure.
  const target = base === 'BTC' ? 1.25e12 : 4e10 + (hash32(`${base}|supply`) % 6e10)
  return target / price
}

/**
 * Price at a continuous position on the 1m grid.
 *
 * Three octaves: a slow multi-day trend, a session-scale swing, and bar-level
 * chop. Composed in log space so the series is always positive and percentage
 * moves are scale-free — a $64k asset and a $0.16 asset get the same volatility
 * character.
 */
function priceAt(symbol: string, minutes: number): number {
  const seed = hash32(normalise(symbol))
  const trend = noiseAt(seed, minutes / 4320) * 0.22 // ~3-day octave
  const swing = noiseAt(seed ^ 0x5bf03635, minutes / 360) * 0.06 // ~6-hour octave
  const chop = noiseAt(seed ^ 0x27d4eb2f, minutes / 12) * 0.012 // ~12-minute octave
  return basePrice(symbol) * Math.exp(trend + swing + chop)
}

function candleAt(
  symbol: string,
  interval: CandleInterval,
  index: number,
  step: number,
): Candle {
  const openTime = index * step
  const minutesPerBar = step / INTERVAL_MS['1m']
  const openMinutes = openTime / INTERVAL_MS['1m']

  const open = priceAt(symbol, openMinutes)
  const close = priceAt(symbol, openMinutes + minutesPerBar)

  // Wicks are drawn from their own seeded stream so they extend beyond the
  // body but never invert it (high >= max(o,c), low <= min(o,c) by construction).
  const rand = mulberry32(hash32(`${normalise(symbol)}|${interval}|${index}`))
  const body = Math.abs(close - open)
  const reference = Math.max(open, close)
  const wickScale = body > 0 ? body : reference * 0.001
  const high = Math.max(open, close) + wickScale * rand() * 1.4
  const low = Math.min(open, close) - wickScale * rand() * 1.4

  // Volume correlates with range, as it does in a real tape, so volume-weighted
  // indicators see a relationship rather than white noise.
  const rangePct = reference > 0 ? (high - low) / reference : 0
  const volume = round((0.6 + rand() * 0.8) * minutesPerBar * (1 + rangePct * 60) * 12, 1)
  const trades = Math.max(1, Math.round(volume * (3 + rand() * 4)))

  return {
    openTime,
    open: round(open, open),
    high: round(high, open),
    low: round(low, open),
    close: round(close, open),
    volume,
    closeTime: openTime + step - 1,
    trades,
    // The demo fills these because the order-flow model needs a shape to run
    // against; the split is skewed by the bar's own direction so an up bar shows
    // buy-side aggression.
    takerBuyVolume: round(volume * (close >= open ? 0.5 + rand() * 0.15 : 0.35 + rand() * 0.15), 1),
  }
}

/** Round to a sensible number of decimals for the magnitude involved. */
function round(value: number, magnitude: number): number {
  const decimals = magnitude >= 1000 ? 2 : magnitude >= 1 ? 4 : 6
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function sourced<T>(data: T, dataAsOf: number): Sourced<T> {
  return {
    data,
    // isDemo: true is the entire contract of this file.
    provenance: { sourceId: PROVIDER_ID, fetchedAt: Date.now(), dataAsOf, isDemo: true },
  }
}

function generationFailed(detail: string): ProviderError {
  return new ProviderError({
    kind: 'unknown',
    providerId: PROVIDER_ID,
    message: 'Demo generator produced an unusable series',
    detail,
  })
}
