/**
 * CoinGecko (aggregated market data).
 *
 * Chain head for price and market data — not because it is faster than an
 * exchange (it is not; it is an aggregate with a minute or two of lag), but
 * because it is the only source in the stack that reports circulating supply and
 * therefore MARKET CAP. Coinbase and Kraken can only ever return null there.
 *
 * For candles and order books CoinGecko is deliberately NOT registered: the free
 * tier has no order book at all and its OHLC endpoint has fixed, coarse windows.
 * Declaring capabilities it cannot honour would make the registry fall back
 * *after* a wasted round trip, or worse, serve a shape that looks right and is
 * not.
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

const BASE = 'https://api.coingecko.com/api/v3'
const PROVIDER_ID = 'coingecko'
/**
 * The keyless tier is documented at 5–15 calls/min and throttles hard past it.
 * 25/min is the demo-key allowance; the bucket is sized for the key case and the
 * keyless case simply absorbs the occasional 429 as a retryable error.
 */
const RATE_LIMIT = { capacity: 25, windowMs: 60_000 } as const

/**
 * `simple/price` is keyed by coin id, and each field is suffixed with the vs
 * currency. The response is a bare map, so the id is looked up after parsing.
 */
const SimplePriceEntrySchema = z.object({
  usd: z.number(),
  usd_market_cap: z.number().nullish(),
  usd_24h_vol: z.number().nullish(),
  usd_24h_change: z.number().nullish(),
  /** Epoch SECONDS of the last aggregate update. */
  last_updated_at: z.number().nullish(),
})
const SimplePriceSchema = z.record(z.string(), SimplePriceEntrySchema)

/**
 * `coins/markets` is the only free endpoint carrying 24h high/low. `simple/price`
 * does not, and substituting the current price for them would fabricate a
 * zero-width daily range that every volatility model would read as dead calm.
 */
const MarketEntrySchema = z.object({
  id: z.string(),
  symbol: z.string(),
  current_price: z.number(),
  market_cap: z.number().nullable(),
  total_volume: z.number().nullable(),
  high_24h: z.number().nullable(),
  low_24h: z.number().nullable(),
  price_change_percentage_24h: z.number().nullable(),
  /** ISO 8601 string. */
  last_updated: z.string().nullish(),
})
const MarketsSchema = z.array(MarketEntrySchema)

/**
 * CoinGecko addresses assets by slug id, not ticker. The map is explicit and
 * small on purpose — a guessed slug returns an empty 200, which is far harder to
 * debug than an unsupported-symbol error.
 */
const COIN_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
  BNB: 'binancecoin',
  DOGE: 'dogecoin',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  // MATIC was migrated to POL; CoinGecko keeps the old 'matic-network' entry
  // alive but FROZEN — it still answers 200 with a months-old price and a zero
  // market cap (verified). Both tickers therefore resolve to the live token, so
  // a caller using the legacy symbol gets current data rather than a plausible
  // fossil.
  MATIC: 'polygon-ecosystem-token',
  POL: 'polygon-ecosystem-token',
}

export class CoinGeckoProvider implements CryptoProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'CoinGecko'
  readonly reliability = 'HIGH_RELIABILITY' as const
  readonly isDemo = false
  readonly capabilities: readonly Capability[] = ['crypto.price', 'crypto.market']

  /**
   * True regardless of key presence: the free tier works keyless, so gating
   * registration on COINGECKO_API_KEY would remove the only market-cap source
   * from a perfectly functional deployment.
   */
  isConfigured(): boolean {
    return true
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/simple/price?ids=bitcoin&vs_currencies=usd`,
      schema: SimplePriceSchema,
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
    const id = toCoinId(symbol)
    if (id === null) return err(unknownSymbol(symbol))

    const r = await fetchJson({
      providerId: this.id,
      url:
        `${BASE}/simple/price?ids=${id}&vs_currencies=usd` +
        `&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`,
      schema: SimplePriceSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const entry = r.value[id]
    // An unknown id yields `{}` with a 200 status, so absence is the signal.
    if (!entry) return err(badPayload(`no entry for coin id "${id}"`))

    // last_updated_at is when CoinGecko refreshed its aggregate, which is the
    // real age of this number — using receipt time would overstate freshness.
    const dataAsOf =
      typeof entry.last_updated_at === 'number' ? entry.last_updated_at * 1000 : Date.now()

    return ok(sourced<PriceTick>({ symbol, price: entry.usd, timestamp: dataAsOf }, dataAsOf))
  }

  async getCandles(
    _symbol: string,
    interval: CandleInterval,
    _limit: number,
  ): Promise<ProviderResult<Candle[]>> {
    // Declared unsupported rather than approximated. CoinGecko's OHLC endpoint
    // picks the granularity itself from the day range (30m/4h/4d), so it cannot
    // honour a specific interval contract, and market_chart returns prices
    // without highs or lows.
    return err(
      new ProviderError({
        kind: 'unsupported_capability',
        providerId: this.id,
        message: `CoinGecko does not serve fixed-interval (${interval}) candles on the free tier`,
      }),
    )
  }

  async getOrderBook(_symbol: string, _depth: number): Promise<ProviderResult<OrderBook>> {
    // CoinGecko is an aggregator with no book of its own. Synthesising one from
    // tickers across venues would produce a book that exists nowhere.
    return err(
      new ProviderError({
        kind: 'unsupported_capability',
        providerId: this.id,
        message: 'CoinGecko aggregates trades and has no order book',
      }),
    )
  }

  async getMarketData(symbol: string): Promise<ProviderResult<MarketData>> {
    const id = toCoinId(symbol)
    if (id === null) return err(unknownSymbol(symbol))

    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/coins/markets?vs_currency=usd&ids=${id}`,
      schema: MarketsSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const entry = r.value[0]
    if (!entry) return err(badPayload(`coins/markets returned no row for "${id}"`))

    const parsedAt = entry.last_updated ? Date.parse(entry.last_updated) : Number.NaN
    // Reported honestly even when it is hours or months old: a stale
    // `last_updated` is exactly the signal the freshness scorer exists to catch,
    // and substituting fetch time here would hide a dead listing.
    const dataAsOf = Number.isFinite(parsedAt) ? parsedAt : Date.now()
    const quoteVolume = positive(entry.total_volume)

    return ok(
      sourced<MarketData>(
        {
          symbol,
          price: entry.current_price,
          change24hPct: entry.price_change_percentage_24h ?? 0,
          // CoinGecko encodes "unknown" as 0 rather than null on delisted or
          // stale entries, and a zero high with a non-zero price is impossible.
          // Both spellings of missing collapse to a fallback of spot, which
          // makes the range degenerate — visibly useless — instead of asserting
          // a 100% drawdown that a volatility model would treat as real.
          high24h: positive(entry.high_24h) ?? entry.current_price,
          low24h: positive(entry.low_24h) ?? entry.current_price,
          // total_volume is denominated in the vs currency (USD), so it is the
          // QUOTE volume; base volume is derived from it rather than the reverse.
          volume24h:
            quoteVolume !== null && entry.current_price > 0 ? quoteVolume / entry.current_price : 0,
          quoteVolume24h: quoteVolume ?? 0,
          // The reason this provider heads the market chain — but a zero cap is
          // CoinGecko saying "I don't know", not a token worth nothing, so it
          // becomes null like every other absent figure in the system.
          marketCap: positive(entry.market_cap),
          timestamp: dataAsOf,
        },
        dataAsOf,
      ),
    )
  }
}

/**
 * The demo key raises the rate ceiling and is sent on the documented header.
 * Pro keys use `x-cg-pro-api-key` against a different host, which this adapter
 * does not target.
 */
function headers(): Record<string, string> {
  const base: Record<string, string> = { 'User-Agent': 'VixeraIntelligence/1.0' }
  const key = process.env.COINGECKO_API_KEY
  if (key) base['x-cg-demo-api-key'] = key
  return base
}

/** 'BTC' | 'BTCUSDT' | 'BTC-USD' → 'bitcoin'; null when unmapped. */
export function toCoinId(symbol: string): string | null {
  const s = symbol.toUpperCase().replace(/[-/]/g, '')
  const base = s.endsWith('USDT') ? s.slice(0, -4) : s.endsWith('USD') ? s.slice(0, -3) : s
  return COIN_IDS[base] ?? null
}

/**
 * Treat non-positive as absent.
 *
 * CoinGecko uses 0 and null interchangeably for "no data" on thin, delisted or
 * frozen listings. Every price, cap and volume in this system is strictly
 * positive when it exists, so 0 is never a legitimate value to propagate.
 */
function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null
}

function unknownSymbol(symbol: string): ProviderError {
  return new ProviderError({
    kind: 'not_found',
    providerId: PROVIDER_ID,
    message: `No CoinGecko coin id mapped for symbol "${symbol}"`,
  })
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
    message: 'CoinGecko payload was structurally valid but semantically unusable',
    detail,
  })
}
