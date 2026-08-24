/**
 * Binance (spot + USD-M futures public data).
 *
 * ⚠️ REACHABILITY: Binance answers HTTP 451 ("unavailable for legal reasons") to
 * requests originating from US-hosted infrastructure — verified against Vercel's
 * US regions. That is why this provider sits BELOW Coinbase and Kraken in every
 * chain it participates in: it is expected to fail in US deployments and the
 * registry must have already-working sources ahead of it. It is still worth
 * registering because (a) it works from EU/APAC regions and local development,
 * and (b) it is the ONLY source in the stack for two things we cannot get
 * elsewhere: aggressor-side (taker buy) volume per candle, which the order-flow
 * model consumes, and perpetual funding / open interest.
 *
 * A 451 is mapped by fetchJson to 'unknown' (it is neither auth nor rate limit),
 * which is non-retryable — so a US deployment fails fast and falls through to
 * the next provider instead of burning three attempts on a legal block.
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
  DerivativesData,
  MarketData,
  OrderBook,
  PriceTick,
  ProviderHealth,
  ProviderResult,
  Sourced,
} from '../types'

const SPOT = 'https://api.binance.com/api/v3'
/** USD-M futures live on a different host with a different path prefix. */
const FUTURES = 'https://fapi.binance.com/fapi/v1'
const PROVIDER_ID = 'binance'
/** Spot weight budget is 1200/min; 20/s keeps a wide margin for burst use. */
const RATE_LIMIT = { capacity: 20, windowMs: 1000 } as const

/**
 * Kline row (12 columns, mixed types):
 * [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades,
 *  takerBuyBase, takerBuyQuote, ignore]
 *
 * Prices and volumes are strings; times and the trade count are numbers. The
 * trailing "ignore" field is a documented dead column that Binance has never
 * removed, so it is matched explicitly to keep the tuple length exact.
 */
const KlineRowSchema = z.tuple([
  z.number(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.number(),
  z.string(),
  z.number(),
  z.string(),
  z.string(),
  z.string(),
])
const KlinesSchema = z.array(KlineRowSchema)

const TickerPriceSchema = z.object({
  symbol: z.string(),
  price: z.string(),
})

const Ticker24hSchema = z.object({
  symbol: z.string(),
  lastPrice: z.string(),
  priceChangePercent: z.string(),
  highPrice: z.string(),
  lowPrice: z.string(),
  volume: z.string(),
  quoteVolume: z.string(),
  closeTime: z.number(),
})

const DepthSchema = z.object({
  lastUpdateId: z.number(),
  /** [price, quantity] — a two-tuple here, unlike the three-tuple on other venues. */
  bids: z.array(z.tuple([z.string(), z.string()])),
  asks: z.array(z.tuple([z.string(), z.string()])),
})

const PremiumIndexSchema = z.object({
  symbol: z.string(),
  lastFundingRate: z.string(),
  nextFundingTime: z.number(),
  time: z.number(),
})

const OpenInterestSchema = z.object({
  symbol: z.string(),
  /** Contract units, i.e. BASE currency for USD-M linear perps. */
  openInterest: z.string(),
  time: z.number(),
})

/** Binance interval codes map 1:1 onto ours — including a native 4h. */
const INTERVAL_CODE: Record<CandleInterval, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
}

export class BinanceProvider implements CryptoProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'Binance'
  readonly reliability = 'PRIMARY_SOURCE' as const
  readonly isDemo = false
  readonly capabilities: readonly Capability[] = [
    'crypto.price',
    'crypto.candles',
    'crypto.orderbook',
    'crypto.market',
    'crypto.derivatives',
  ]

  /**
   * Opt-OUT rather than opt-in: a deployment that knows it is geo-blocked can
   * set VIXERA_ENABLE_BINANCE=false to stop the registry from even placing it in
   * a chain, saving one doomed round trip per request.
   */
  isConfigured(): boolean {
    return process.env.VIXERA_ENABLE_BINANCE !== 'false'
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const r = await fetchJson({
      providerId: this.id,
      url: `${SPOT}/ticker/price?symbol=BTCUSDT`,
      schema: TickerPriceSchema,
      headers: headers(),
      timeoutMs: 6000,
      retries: 0,
    })
    return {
      healthy: r.ok,
      latencyMs: Date.now() - started,
      // The message is surfaced verbatim so a 451 is visibly a geo-block rather
      // than an anonymous outage on the status page.
      message: r.ok ? null : r.error.message,
    }
  }

  async getPrice(symbol: string): Promise<ProviderResult<PriceTick>> {
    const r = await fetchJson({
      providerId: this.id,
      url: `${SPOT}/ticker/price?symbol=${toBinanceSymbol(symbol)}`,
      schema: TickerPriceSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const price = num(r.value.price)
    if (price === null) return err(badPayload('ticker price was not numeric'))

    const now = Date.now()
    return ok(sourced<PriceTick>({ symbol, price, timestamp: now }, now))
  }

  async getCandles(
    symbol: string,
    interval: CandleInterval,
    limit: number,
  ): Promise<ProviderResult<Candle[]>> {
    // 1000 is the hard server-side cap; asking for more is rejected outright.
    const capped = Math.min(Math.max(limit, 1), 1000)
    const r = await fetchJson({
      providerId: this.id,
      url: `${SPOT}/klines?symbol=${toBinanceSymbol(symbol)}&interval=${INTERVAL_CODE[interval]}&limit=${capped}`,
      schema: KlinesSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const candles: Candle[] = []
    for (const row of r.value) {
      const [openTime, open, high, low, close, volume, closeTime, , trades, takerBuyBase] = row
      const o = num(open)
      const h = num(high)
      const l = num(low)
      const c = num(close)
      const v = num(volume)
      if (o === null || h === null || l === null || c === null || v === null) continue
      candles.push({
        openTime,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
        closeTime,
        trades,
        // The whole reason Binance stays in the chain: takerBuyBase is volume
        // that lifted the offer, so (takerBuy / total) is a direct read on
        // aggressor imbalance. No other provider here reports it.
        takerBuyVolume: num(takerBuyBase),
      })
    }

    if (candles.length === 0) return err(badPayload('no usable klines returned'))
    // Binance already returns oldest-first, but the sort makes the invariant
    // local to this file rather than a fact you have to remember.
    candles.sort((a, b) => a.openTime - b.openTime)
    const newest = candles[candles.length - 1]
    return ok(sourced(candles, newest ? newest.closeTime : Date.now()))
  }

  async getOrderBook(symbol: string, depth: number): Promise<ProviderResult<OrderBook>> {
    // Binance only accepts a fixed set of limit values; anything else is a 400.
    const allowed = [5, 10, 20, 50, 100, 500, 1000, 5000]
    const limit = allowed.find((n) => n >= depth) ?? 5000

    const r = await fetchJson({
      providerId: this.id,
      url: `${SPOT}/depth?symbol=${toBinanceSymbol(symbol)}&limit=${limit}`,
      schema: DepthSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const bids = toLevels(r.value.bids, depth)
    const asks = toLevels(r.value.asks, depth)
    if (bids.length === 0 || asks.length === 0) {
      return err(badPayload('order book had an empty side'))
    }

    // The REST depth snapshot carries no timestamp (only a sequence id), so
    // receipt time is the only defensible "as of".
    const now = Date.now()
    return ok(sourced<OrderBook>({ symbol, bids, asks, timestamp: now }, now))
  }

  async getMarketData(symbol: string): Promise<ProviderResult<MarketData>> {
    const r = await fetchJson({
      providerId: this.id,
      url: `${SPOT}/ticker/24hr?symbol=${toBinanceSymbol(symbol)}`,
      schema: Ticker24hSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const price = num(r.value.lastPrice)
    const high = num(r.value.highPrice)
    const low = num(r.value.lowPrice)
    const volume = num(r.value.volume)
    const quoteVolume = num(r.value.quoteVolume)
    if (price === null || high === null || low === null || volume === null) {
      return err(badPayload('24hr ticker contained non-numeric fields'))
    }

    return ok(
      sourced<MarketData>(
        {
          symbol,
          price,
          change24hPct: num(r.value.priceChangePercent) ?? 0,
          high24h: high,
          low24h: low,
          volume24h: volume,
          quoteVolume24h: quoteVolume ?? volume * price,
          // An exchange knows nothing about circulating supply; only CoinGecko
          // can fill this.
          marketCap: null,
          timestamp: r.value.closeTime,
        },
        r.value.closeTime,
      ),
    )
  }

  async getDerivatives(symbol: string): Promise<ProviderResult<DerivativesData>> {
    const pair = toBinanceSymbol(symbol)
    const [premiumR, oiR] = await Promise.all([
      fetchJson({
        providerId: this.id,
        url: `${FUTURES}/premiumIndex?symbol=${pair}`,
        schema: PremiumIndexSchema,
        headers: headers(),
        rateLimit: RATE_LIMIT,
      }),
      fetchJson({
        providerId: this.id,
        url: `${FUTURES}/openInterest?symbol=${pair}`,
        schema: OpenInterestSchema,
        headers: headers(),
        rateLimit: RATE_LIMIT,
      }),
    ])

    // Funding is the primary signal; open interest is enriching. If premiumIndex
    // fails there is nothing worth returning, but a missing OI is reported as
    // null rather than sinking the whole call.
    if (!premiumR.ok) return err(premiumR.error)

    const fundingRate = num(premiumR.value.lastFundingRate)
    const openInterest = oiR.ok ? num(oiR.value.openInterest) : null

    // premiumIndex has no mark price field in this schema, so OI is valued at
    // spot-equivalent only when we have both numbers; otherwise null. A notional
    // computed from a stale or absent price would misstate leverage in the market.
    const priceR = await this.getPrice(symbol)
    const markPrice = priceR.ok ? priceR.value.data.price : null

    return ok(
      sourced<DerivativesData>(
        {
          symbol,
          fundingRate,
          nextFundingTime: premiumR.value.nextFundingTime,
          openInterest,
          openInterestValue:
            openInterest !== null && markPrice !== null ? openInterest * markPrice : null,
          timestamp: premiumR.value.time,
        },
        premiumR.value.time,
      ),
    )
  }
}

function headers(): Record<string, string> {
  return { 'User-Agent': 'VixeraIntelligence/1.0' }
}

/**
 * 'BTC' | 'BTC-USD' | 'BTC/USD' → 'BTCUSDT'.
 *
 * Binance's deep spot liquidity is in USDT pairs, not USD (its USD books are
 * thin or absent), so a USD request is routed to the USDT book. The basis
 * between them is a few basis points and materially better than an empty book.
 */
export function toBinanceSymbol(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[-/]/g, '')
  if (s.endsWith('USDT')) return s
  if (s.endsWith('USD')) return `${s.slice(0, -3)}USDT`
  return `${s}USDT`
}

function toLevels(
  raw: readonly (readonly [string, string])[],
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

/** Strict string→number: null instead of NaN so callers must handle it. */
function num(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
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
    message: 'Binance payload was structurally valid but semantically unusable',
    detail,
  })
}
