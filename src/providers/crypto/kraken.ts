/**
 * Kraken (public market data).
 *
 * Second in the candle/order-book chain behind Coinbase. Kraken earns its place
 * for two reasons: it is reachable from US infrastructure (unlike Binance), and
 * it serves a NATIVE 4h OHLC interval, which Coinbase does not — so a 4h request
 * that Coinbase refuses is answered here with real venue candles rather than
 * client-side aggregation.
 *
 * Kraken's quirk is that it signals failure inside a 200 response: the body
 * always carries an `error` array, and an empty array is the only success
 * signal. `fetchJson` therefore cannot see these failures and every method has
 * to inspect the envelope itself.
 */

import { z } from 'zod'
import { ProviderError } from '@/core/errors'
import { err, ok, type Result } from '@/core/result'
import { fetchJson } from '../http'
import type {
  Candle,
  CandleInterval,
  Capability,
  CryptoProvider,
  MarketData,
  OrderBook,
  PriceTick,
  ProviderHealth,
  ProviderResult,
  Sourced,
} from '../types'

const BASE = 'https://api.kraken.com/0/public'
const PROVIDER_ID = 'kraken'
/** Kraken's public counter allows roughly one call per second before it decays. */
const RATE_LIMIT = { capacity: 1, windowMs: 1000 } as const

/**
 * Every public endpoint shares this envelope. `result` is absent when `error` is
 * populated, so it is optional and the error array is checked first.
 */
const EnvelopeSchema = z.object({
  error: z.array(z.string()),
  result: z.record(z.string(), z.unknown()).optional(),
})

/**
 * OHLC row: [time(sec), open, high, low, close, vwap, volume, count].
 * Only `time` and `count` come back as JSON numbers — every price and volume is
 * a decimal STRING, because Kraken refuses to let a float round-trip mangle a
 * quote. z.coerce.number() would silently accept "abc" as NaN, so the strings
 * are kept as strings here and converted through `num()` which validates.
 */
const OhlcRowSchema = z.tuple([
  z.number(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.number(),
])
const OhlcPairSchema = z.array(OhlcRowSchema)

const TickerPairSchema = z.object({
  /** ask: [price, wholeLotVolume, lotVolume] */
  a: z.array(z.string()).min(1),
  /** bid: [price, wholeLotVolume, lotVolume] */
  b: z.array(z.string()).min(1),
  /** last trade closed: [price, lotVolume] */
  c: z.array(z.string()).min(1),
  /** volume: [today, last24h] */
  v: z.array(z.string()).min(2),
  /** high: [today, last24h] */
  h: z.array(z.string()).min(2),
  /** low: [today, last24h] */
  l: z.array(z.string()).min(2),
  /** today's opening price */
  o: z.string(),
})

/** Depth level: [price, volume, timestamp(sec)]. Timestamp is a number here. */
const DepthLevelSchema = z.tuple([z.string(), z.string(), z.number()])
const DepthPairSchema = z.object({
  asks: z.array(DepthLevelSchema),
  bids: z.array(DepthLevelSchema),
})

/**
 * Kraken expresses OHLC interval in MINUTES, not seconds. 240 is supported
 * natively, which is the whole reason this provider sits ahead of Binance for
 * 4h work.
 */
const INTERVAL_MINUTES: Record<CandleInterval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
}

export class KrakenProvider implements CryptoProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'Kraken'
  readonly reliability = 'PRIMARY_SOURCE' as const
  readonly isDemo = false
  readonly capabilities: readonly Capability[] = [
    'crypto.price',
    'crypto.candles',
    'crypto.orderbook',
    'crypto.market',
  ]

  isConfigured(): boolean {
    return true // public endpoints, no key required
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/Ticker?pair=XBTUSD`,
      schema: EnvelopeSchema,
      headers: headers(),
      timeoutMs: 6000,
      retries: 0,
    })
    // A transport-level success with a non-empty error array is still unhealthy,
    // so the envelope is unwrapped rather than trusting the HTTP status.
    const unwrapped = r.ok ? unwrapPair(r.value, TickerPairSchema) : err(r.error)
    return {
      healthy: unwrapped.ok,
      latencyMs: Date.now() - started,
      message: unwrapped.ok ? null : unwrapped.error.message,
    }
  }

  async getPrice(symbol: string): Promise<ProviderResult<PriceTick>> {
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/Ticker?pair=${toKrakenPair(symbol)}`,
      schema: EnvelopeSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const pair = unwrapPair(r.value, TickerPairSchema)
    if (!pair.ok) return err(pair.error)

    // c[0] is the last *traded* price. The mid of a/b would be a synthetic
    // number that never printed on the tape.
    const price = num(pair.value.c[0])
    if (price === null) return err(badPayload('last trade price was not numeric'))

    // Kraken's ticker carries no timestamp of its own; receipt time is the
    // honest answer and is what freshness scoring will be measured against.
    const now = Date.now()
    return ok(sourced<PriceTick>({ symbol, price, timestamp: now }, now))
  }

  async getCandles(
    symbol: string,
    interval: CandleInterval,
    limit: number,
  ): Promise<ProviderResult<Candle[]>> {
    const minutes = INTERVAL_MINUTES[interval]
    const intervalMs = minutes * 60_000

    // Kraken ignores any count parameter on OHLC and returns up to 720 rows
    // ending at `last`; `since` is the only lever, so the window is computed
    // backwards from now and the response is trimmed client-side.
    const since = Math.floor((Date.now() - limit * intervalMs) / 1000)

    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/OHLC?pair=${toKrakenPair(symbol)}&interval=${minutes}&since=${since}`,
      schema: EnvelopeSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const rows = unwrapPair(r.value, OhlcPairSchema)
    if (!rows.ok) return err(rows.error)

    const candles: Candle[] = []
    for (const [time, open, high, low, close, , volume] of rows.value) {
      const o = num(open)
      const h = num(high)
      const l = num(low)
      const c = num(close)
      const v = num(volume)
      // A row with an unparseable field is dropped rather than coerced to 0 — a
      // zero-priced candle would poison every indicator that touches it.
      if (o === null || h === null || l === null || c === null || v === null) continue
      candles.push({
        openTime: time * 1000,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
        closeTime: time * 1000 + intervalMs - 1,
        // Kraken reports a trade count per candle but no aggressor split, so
        // takerBuyVolume stays null; only Binance can fill that field.
        trades: null,
        takerBuyVolume: null,
      })
    }

    if (candles.length === 0) return err(badPayload('no usable candles returned'))
    candles.sort((a, b) => a.openTime - b.openTime)
    // Trim from the END so the most recent `limit` candles survive.
    const trimmed = candles.slice(Math.max(0, candles.length - limit))
    const newest = trimmed[trimmed.length - 1]
    return ok(sourced(trimmed, newest ? newest.closeTime : Date.now()))
  }

  async getOrderBook(symbol: string, depth: number): Promise<ProviderResult<OrderBook>> {
    // Kraken caps `count` at 500 per side.
    const count = Math.min(Math.max(depth, 1), 500)
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/Depth?pair=${toKrakenPair(symbol)}&count=${count}`,
      schema: EnvelopeSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const book = unwrapPair(r.value, DepthPairSchema)
    if (!book.ok) return err(book.error)

    const bids = toLevels(book.value.bids, depth)
    const asks = toLevels(book.value.asks, depth)
    if (bids.length === 0 || asks.length === 0) {
      return err(badPayload('order book had an empty side'))
    }

    // Each level carries its own timestamp; the newest across the book is the
    // true "as of" for imbalance purposes.
    let dataAsOf = 0
    for (const [, , ts] of [...book.value.bids, ...book.value.asks]) {
      if (ts * 1000 > dataAsOf) dataAsOf = ts * 1000
    }
    const now = Date.now()
    return ok(
      sourced<OrderBook>(
        { symbol, bids, asks, timestamp: now },
        dataAsOf > 0 ? dataAsOf : now,
      ),
    )
  }

  async getMarketData(symbol: string): Promise<ProviderResult<MarketData>> {
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/Ticker?pair=${toKrakenPair(symbol)}`,
      schema: EnvelopeSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const t = unwrapPair(r.value, TickerPairSchema)
    if (!t.ok) return err(t.error)

    const price = num(t.value.c[0])
    const open = num(t.value.o)
    // Index 1 of h/l/v is the rolling 24h figure; index 0 is "today" in UTC and
    // would collapse toward zero just after midnight.
    const high = num(t.value.h[1])
    const low = num(t.value.l[1])
    const volume = num(t.value.v[1])
    if (price === null || high === null || low === null || volume === null) {
      return err(badPayload('ticker contained non-numeric price or volume fields'))
    }

    const now = Date.now()
    return ok(
      sourced<MarketData>(
        {
          symbol,
          price,
          change24hPct: open !== null && open > 0 ? ((price - open) / open) * 100 : 0,
          high24h: high,
          low24h: low,
          volume24h: volume,
          // Kraken publishes no quote-currency volume, so it is reconstructed
          // from base volume at spot. That is an approximation across the day's
          // range, but it is derived only from figures Kraken actually returned.
          quoteVolume24h: volume * price,
          // No supply data on this venue; a market cap here would be invented.
          marketCap: null,
          timestamp: now,
        },
        now,
      ),
    )
  }
}

function headers(): Record<string, string> {
  return { 'User-Agent': 'VixeraIntelligence/1.0' }
}

/**
 * Pull the single dynamic pair entry out of a Kraken envelope and validate it.
 *
 * Kraken keys `result` by its own internal asset codes ('XXBTZUSD' for a
 * 'XBTUSD' request, but plain 'SOLUSD' for others), and the mapping is neither
 * documented nor stable. Rather than maintaining a lookup of request pair →
 * response key, we take the first key that is not the `last` cursor — a
 * single-pair request only ever has one.
 */
function unwrapPair<T>(
  envelope: z.infer<typeof EnvelopeSchema>,
  schema: z.ZodType<T>,
): Result<T, ProviderError> {
  if (envelope.error.length > 0) {
    const message = envelope.error.join('; ')
    return err(
      new ProviderError({
        // Kraken signals throttling as an error string, not a 429, so it never
        // reaches fetchJson's status mapping.
        kind: message.includes('Rate limit') ? 'rate_limited' : 'upstream_unavailable',
        providerId: PROVIDER_ID,
        message: `Kraken returned an API error: ${message}`,
      }),
    )
  }

  const result = envelope.result
  if (!result) return err(badPayload('success envelope carried no result object'))

  const key = Object.keys(result).find((k) => k !== 'last')
  if (key === undefined) return err(badPayload('result object contained no pair entry'))

  const parsed = schema.safeParse(result[key])
  if (!parsed.success) {
    return err(
      new ProviderError({
        kind: 'schema_mismatch',
        providerId: PROVIDER_ID,
        message: 'Kraken pair payload did not match the expected shape',
        detail: parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      }),
    )
  }
  return ok(parsed.data)
}

function toLevels(
  raw: readonly (readonly [string, string, number])[],
  depth: number,
): { price: number; quantity: number }[] {
  const out: { price: number; quantity: number }[] = []
  for (const [price, qty] of raw.slice(0, depth)) {
    const p = num(price)
    const q = num(qty)
    if (p === null || q === null) continue
    out.push({ price: p, quantity: q })
  }
  return out
}

/** Strict string→number: returns null instead of NaN so callers must decide. */
function num(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * 'BTC' | 'BTCUSDT' | 'BTC-USD' → 'XBTUSD'.
 *
 * Kraken predates the BTC ticker convention and still uses XBT (the ISO 4217
 * style code for a non-national currency); DOGE is likewise XDG. Callers speak
 * the common convention, so the translation is confined here.
 */
export function toKrakenPair(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[-/]/g, '')
  const base = s.endsWith('USDT') ? s.slice(0, -4) : s.endsWith('USD') ? s.slice(0, -3) : s

  const KRAKEN_BASE: Record<string, string> = {
    BTC: 'XBT',
    XBT: 'XBT',
    DOGE: 'XDG',
    XDG: 'XDG',
    ETH: 'ETH',
    SOL: 'SOL',
    XRP: 'XRP',
  }

  return `${KRAKEN_BASE[base] ?? base}USD`
}

function sourced<T>(data: T, dataAsOf: number): Sourced<T> {
  return {
    data,
    provenance: { sourceId: PROVIDER_ID, fetchedAt: Date.now(), dataAsOf, isDemo: false },
  }
}

function badPayload(detail: string): ProviderError {
  return new ProviderError({
    kind: 'schema_mismatch',
    providerId: PROVIDER_ID,
    message: 'Kraken payload was structurally valid but semantically unusable',
    detail,
  })
}
