/**
 * Coinbase Exchange (public market data).
 *
 * Primary keyless source for candles and order books. Chosen as chain head over
 * Binance because Binance returns HTTP 451 from US-hosted infrastructure, which
 * includes most Vercel regions — a "better" API you cannot reach is worse than a
 * good one you can.
 */

import { z } from 'zod'
import { ProviderError } from '@/core/errors'
import { err, ok } from '@/core/result'
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

const BASE = 'https://api.exchange.coinbase.com'
const PROVIDER_ID = 'coinbase-exchange'
const RATE_LIMIT = { capacity: 8, windowMs: 1000 } as const

/** Coinbase returns [time(sec), low, high, open, close, volume] — note the order. */
const CandleRowSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
])
const CandlesSchema = z.array(CandleRowSchema)

const TickerSchema = z.object({
  price: z.string(),
  time: z.string(),
  volume: z.string().optional(),
  bid: z.string().optional(),
  ask: z.string().optional(),
})

const StatsSchema = z.object({
  open: z.string(),
  high: z.string(),
  low: z.string(),
  last: z.string(),
  volume: z.string(),
})

const BookSchema = z.object({
  bids: z.array(z.tuple([z.string(), z.string(), z.union([z.number(), z.string()])])),
  asks: z.array(z.tuple([z.string(), z.string(), z.union([z.number(), z.string()])])),
  sequence: z.number().optional(),
})

const GRANULARITY: Record<CandleInterval, number | null> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  // Coinbase offers no native 4h; the engine aggregates 1h candles instead of
  // silently substituting a different interval.
  '4h': null,
  '1d': 86400,
}

export class CoinbaseExchangeProvider implements CryptoProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'Coinbase Exchange'
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
      url: `${BASE}/products/BTC-USD/ticker`,
      schema: TickerSchema,
      headers: headers(),
      timeoutMs: 6000,
      retries: 0,
    })
    return {
      healthy: r.ok,
      latencyMs: Date.now() - started,
      message: r.ok ? null : r.error.message,
    }
  }

  async getPrice(symbol: string): Promise<ProviderResult<PriceTick>> {
    const product = toProduct(symbol)
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/products/${product}/ticker`,
      schema: TickerSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const price = Number(r.value.price)
    const ts = Date.parse(r.value.time)
    if (!Number.isFinite(price)) return err(badPayload('ticker price was not numeric'))

    return ok(
      sourced<PriceTick>(
        { symbol, price, timestamp: Number.isFinite(ts) ? ts : Date.now() },
        Number.isFinite(ts) ? ts : Date.now(),
      ),
    )
  }

  async getCandles(
    symbol: string,
    interval: CandleInterval,
    limit: number,
  ): Promise<ProviderResult<Candle[]>> {
    const granularity = GRANULARITY[interval]
    if (granularity === null) {
      return err(
        new ProviderError({
          kind: 'unsupported_capability',
          providerId: this.id,
          message: `Coinbase does not serve a native ${interval} candle`,
        }),
      )
    }

    // Coinbase caps a response at 300 candles, so the window is requested
    // explicitly rather than relying on an undocumented default.
    const capped = Math.min(limit, 300)
    const end = Math.floor(Date.now() / 1000)
    const start = end - capped * granularity

    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/products/${toProduct(symbol)}/candles?granularity=${granularity}&start=${start}&end=${end}`,
      schema: CandlesSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    // Coinbase returns newest-first; every engine downstream assumes
    // oldest-first, so normalise here rather than in each consumer.
    const candles: Candle[] = r.value
      .map(([time, low, high, open, close, volume]) => ({
        openTime: time * 1000,
        open,
        high,
        low,
        close,
        volume,
        closeTime: (time + granularity) * 1000 - 1,
        trades: null,
        takerBuyVolume: null,
      }))
      .sort((a, b) => a.openTime - b.openTime)

    if (candles.length === 0) return err(badPayload('no candles returned'))
    const newest = candles[candles.length - 1]
    return ok(sourced(candles, newest ? newest.closeTime : Date.now()))
  }

  async getOrderBook(symbol: string, depth: number): Promise<ProviderResult<OrderBook>> {
    // Level 2 is aggregated by price — the right granularity for imbalance
    // measurement. Level 3 (per-order) would be noise for this purpose.
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/products/${toProduct(symbol)}/book?level=2`,
      schema: BookSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const now = Date.now()
    return ok(
      sourced<OrderBook>(
        {
          symbol,
          bids: r.value.bids.slice(0, depth).map(([price, qty]) => ({
            price: Number(price),
            quantity: Number(qty),
          })),
          asks: r.value.asks.slice(0, depth).map(([price, qty]) => ({
            price: Number(price),
            quantity: Number(qty),
          })),
          timestamp: now,
        },
        now,
      ),
    )
  }

  async getMarketData(symbol: string): Promise<ProviderResult<MarketData>> {
    const product = toProduct(symbol)
    const [statsR, tickerR] = await Promise.all([
      fetchJson({
        providerId: this.id,
        url: `${BASE}/products/${product}/stats`,
        schema: StatsSchema,
        headers: headers(),
        rateLimit: RATE_LIMIT,
      }),
      fetchJson({
        providerId: this.id,
        url: `${BASE}/products/${product}/ticker`,
        schema: TickerSchema,
        headers: headers(),
        rateLimit: RATE_LIMIT,
      }),
    ])
    if (!statsR.ok) return err(statsR.error)
    if (!tickerR.ok) return err(tickerR.error)

    const open = Number(statsR.value.open)
    const price = Number(tickerR.value.price)
    const volume = Number(statsR.value.volume)
    const now = Date.now()

    return ok(
      sourced<MarketData>(
        {
          symbol,
          price,
          change24hPct: open > 0 ? ((price - open) / open) * 100 : 0,
          high24h: Number(statsR.value.high),
          low24h: Number(statsR.value.low),
          volume24h: volume,
          quoteVolume24h: volume * price,
          // Coinbase does not publish market cap; null is correct here. A
          // supply-times-price estimate would be a fabricated figure.
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

/** 'BTCUSDT' | 'BTC-USD' | 'BTC/USD' → 'BTC-USD' */
function toProduct(symbol: string): string {
  const s = symbol.toUpperCase().replace('/', '-')
  if (s.includes('-')) return s
  if (s.endsWith('USDT')) return `${s.slice(0, -4)}-USD`
  if (s.endsWith('USD')) return `${s.slice(0, -3)}-USD`
  return s
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
    message: 'Coinbase payload was structurally valid but semantically unusable',
    detail,
  })
}
