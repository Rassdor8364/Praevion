/**
 * Polymarket (Gamma metadata API + CLOB order books + data-api trades).
 *
 * Polymarket is the venue itself — PRIMARY_SOURCE — and all three APIs are
 * keyless for read-only market data. Three separate hosts, because Polymarket
 * splits the surface: gamma-api (market metadata + prices), clob (books, keyed
 * by outcome TOKEN id, not market id), data-api (trades, keyed by the on-chain
 * conditionId).
 *
 * API quirks this adapter absorbs (all verified against the live API):
 *
 *  - `outcomes`, `outcomePrices` and `clobTokenIds` are DOUBLE-ENCODED: JSON
 *    arrays serialised into JSON strings ('["Yes","No"]'). Parsed inside the
 *    zod schema so a bad inner payload surfaces as `schema_mismatch`, exactly
 *    like any other shape violation.
 *  - `liquidity` and `volume` are decimal strings → Number with a NaN guard.
 *  - `bestBid`/`bestAsk` quote the FIRST outcome's token only. For a binary
 *    market the second outcome's quotes are the complement with bid/ask
 *    SWAPPED (see mapPolymarketMarket); beyond two outcomes they are unknowable
 *    from this payload and stay null.
 *  - The CLOB book sorts BOTH sides worst→best (best bid is the LAST bid, best
 *    ask is the LAST ask) — the opposite tail from every exchange convention.
 *    normaliseClobBook re-sorts to bids-descending / asks-ascending.
 *  - data-api trade timestamps are epoch SECONDS; CLOB book timestamps are
 *    epoch MILLISECONDS as strings. Both normalised to ms numbers.
 *  - Markets carry no usable `category` (null in practice), so category is
 *    inferred from question/slug keywords — deliberately conservative,
 *    defaulting to 'other' rather than mislabelling.
 */

import { z } from 'zod'
import { ProviderError } from '@/core/errors'
import { err, ok } from '@/core/result'
import type {
  MarketCategory,
  MarketOrderBook,
  MarketOutcome,
  MarketStatus,
  MarketTrade,
  PredictionMarket,
} from '@/core/markets/types'
import { fetchJson } from '../http'
import type { Capability, ProviderHealth, ProviderResult, Sourced } from '../types'
import type { PredictionMarketProvider } from './types'

const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB = 'https://clob.polymarket.com'
const DATA = 'https://data-api.polymarket.com'
const PROVIDER_ID = 'polymarket'
const RATE_LIMIT = { capacity: 8, windowMs: 1000 } as const

// ---------------------------------------------------------------------------
// Schemas — field names verified via live curl on 2026-08-12
// ---------------------------------------------------------------------------

/**
 * A JSON array of strings, itself serialised into a JSON string — Gamma's
 * double encoding. Parse failure is reported through the zod issue machinery
 * so fetchJson turns it into `schema_mismatch` (never a throw): a payload
 * whose inner JSON is broken is exactly as untrustworthy as one with a
 * missing field.
 */
const JsonStringArray = z.string().transform((value, ctx) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'double-encoded array was not valid JSON' })
    return z.NEVER
  }
  const inner = z.array(z.string()).safeParse(parsed)
  if (!inner.success) {
    ctx.addIssue({ code: 'custom', message: 'double-encoded value was not a string array' })
    return z.NEVER
  }
  return inner.data
})

/** Exported so the normalisation tests can drive fixtures through the exact
 *  transform (double-encoded arrays included) that production traffic takes. */
export const GammaMarketSchema = z.object({
  id: z.string(),
  question: z.string(),
  slug: z.string().nullish(),
  /** On-chain id — the key data-api trades are queried by. */
  conditionId: z.string().nullish(),
  description: z.string().nullish(),
  endDate: z.string().nullish(),
  liquidity: z.string().nullish(),
  volume: z.string().nullish(),
  volume24hr: z.number().nullish(),
  outcomes: JsonStringArray,
  outcomePrices: JsonStringArray,
  /** Absent on legacy AMM-only markets, hence optional. */
  clobTokenIds: JsonStringArray.nullish(),
  category: z.string().nullish(),
  resolutionSource: z.string().nullish(),
  closed: z.boolean(),
  active: z.boolean(),
  acceptingOrders: z.boolean().nullish(),
  bestBid: z.number().nullish(),
  bestAsk: z.number().nullish(),
  lastTradePrice: z.number().nullish(),
  umaResolutionStatus: z.string().nullish(),
  updatedAt: z.string().nullish(),
  /** The parent event supplies the public URL slug and a broader title. */
  events: z
    .array(z.object({ slug: z.string().nullish(), title: z.string().nullish() }))
    .nullish(),
})

const GammaMarketsSchema = z.array(GammaMarketSchema)

const ClobLevelSchema = z.object({ price: z.string(), size: z.string() })

const ClobBookSchema = z.object({
  market: z.string().nullish(),
  asset_id: z.string().nullish(),
  /** Epoch MILLISECONDS as a string — unlike data-api's epoch seconds. */
  timestamp: z.string().nullish(),
  bids: z.array(ClobLevelSchema),
  asks: z.array(ClobLevelSchema),
})

const DataTradeSchema = z.object({
  /** Outcome token id the trade executed against. */
  asset: z.string(),
  side: z.string().nullish(),
  price: z.number(),
  size: z.number(),
  /** Epoch SECONDS. */
  timestamp: z.number(),
})

const DataTradesSchema = z.array(DataTradeSchema)

type GammaRawMarket = z.infer<typeof GammaMarketSchema>
type ClobRawBook = z.infer<typeof ClobBookSchema>
type DataRawTrade = z.infer<typeof DataTradeSchema>

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class PolymarketProvider implements PredictionMarketProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'Polymarket'
  readonly reliability = 'PRIMARY_SOURCE' as const
  readonly isDemo = false
  readonly capabilities: readonly Capability[] = [
    'markets.list',
    'markets.detail',
    'markets.orderbook',
    'markets.trades',
  ]

  isConfigured(): boolean {
    return true // all three read APIs are keyless
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const r = await fetchJson({
      providerId: this.id,
      url: `${GAMMA}/markets?limit=1&active=true&closed=false`,
      schema: GammaMarketsSchema,
      timeoutMs: 6000,
      retries: 0,
    })
    return {
      healthy: r.ok,
      latencyMs: Date.now() - started,
      message: r.ok ? null : r.error.message,
    }
  }

  async getMarkets(params: {
    category?: MarketCategory
    limit: number
    cursor?: string
  }): Promise<ProviderResult<{ markets: PredictionMarket[]; nextCursor: string | null }>> {
    const limit = clamp(params.limit, 1, 100)
    // Gamma paginates with limit/offset; the opaque cursor is just the offset
    // in decimal. Anything unparseable restarts from the top rather than 500ing.
    const offset = params.cursor && /^\d+$/.test(params.cursor) ? Number(params.cursor) : 0
    const r = await fetchJson({
      providerId: this.id,
      url: `${GAMMA}/markets?limit=${limit}&offset=${offset}&active=true&closed=false&order=volume24hr&ascending=false`,
      schema: GammaMarketsSchema,
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const now = Date.now()
    const markets: PredictionMarket[] = []
    for (const raw of r.value) {
      const mapped = mapPolymarketMarket(raw, now)
      if (!mapped) continue // unusable prices — dropped, not fabricated
      // Category is inferred, and Gamma's tag filter needs numeric tag ids we
      // cannot hardcode reliably — so filtering is client-side. A filtered
      // page may be short; nextCursor still advances by the RAW page so no
      // markets are skipped on the following page.
      if (params.category !== undefined && mapped.category !== params.category) continue
      markets.push(mapped)
    }

    // A full raw page means there is probably more; a short one means the end.
    const nextCursor = r.value.length === limit ? String(offset + limit) : null
    return ok(sourced({ markets, nextCursor }, now))
  }

  async getMarket(externalId: string): Promise<ProviderResult<PredictionMarket>> {
    const r = await fetchJson({
      providerId: this.id,
      url: `${GAMMA}/markets/${encodeURIComponent(externalId)}`,
      schema: GammaMarketSchema,
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const now = Date.now()
    const mapped = mapPolymarketMarket(r.value, now)
    if (!mapped) return err(badPayload(`market ${externalId} had no parseable prices`))
    return ok(sourced(mapped, now))
  }

  async getOrderBook(
    externalId: string,
    outcomeId: string,
  ): Promise<ProviderResult<MarketOrderBook>> {
    // Polymarket books are keyed by outcome TOKEN id — which is exactly what
    // this adapter uses as MarketOutcome.id — so the CLOB is hit directly and
    // externalId is only needed to stamp the canonical marketId.
    const r = await fetchJson({
      providerId: this.id,
      url: `${CLOB}/book?token_id=${encodeURIComponent(outcomeId)}`,
      schema: ClobBookSchema,
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    return ok(
      sourced(normaliseClobBook(r.value, externalId, outcomeId), bookTimestamp(r.value)),
    )
  }

  async getTrades(externalId: string, limit: number): Promise<ProviderResult<MarketTrade[]>> {
    // data-api keys trades by the on-chain conditionId, not the Gamma market
    // id, so the market must be fetched first to translate. Two calls, but
    // the metadata call is small and the alternative — making callers carry
    // Polymarket's three different id systems — is worse.
    const marketR = await fetchJson({
      providerId: this.id,
      url: `${GAMMA}/markets/${encodeURIComponent(externalId)}`,
      schema: GammaMarketSchema,
      rateLimit: RATE_LIMIT,
    })
    if (!marketR.ok) return err(marketR.error)
    const conditionId = marketR.value.conditionId
    if (!conditionId) {
      return err(badPayload(`market ${externalId} has no conditionId — trades unavailable`))
    }

    const capped = clamp(limit, 1, 500)
    const r = await fetchJson({
      providerId: this.id,
      url: `${DATA}/trades?market=${encodeURIComponent(conditionId)}&limit=${capped}`,
      schema: DataTradesSchema,
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const trades: MarketTrade[] = []
    for (const raw of r.value) {
      const mapped = mapPolymarketTrade(raw, externalId)
      if (mapped) trades.push(mapped)
    }
    const newest = trades[0]
    return ok(sourced(trades, newest ? newest.timestamp : Date.now()))
  }
}

// ---------------------------------------------------------------------------
// Pure mappers — exported for the normalisation tests
// ---------------------------------------------------------------------------

/**
 * Category inference from question/slug text. Gamma's `category` field is
 * null on essentially every live market, so keywords are all there is. The
 * table is ordered most-specific-first and errs toward 'other' — a wrong
 * label poisons category-level statistics, a missing one merely widens them.
 */
export function inferPolymarketCategory(text: string): MarketCategory {
  const t = text.toLowerCase()
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|dogecoin|crypto|stablecoin|defi)\b/.test(t)) {
    return 'crypto'
  }
  if (
    /\b(nba|nfl|mlb|nhl|ufc|f1|tennis|golf|premier league|champions league|la liga|serie a|bundesliga|world cup|super bowl|olympics|counter-strike|esports|grand slam|wnba)\b/.test(t) ||
    /\bwin on \d{4}-\d{2}-\d{2}\b/.test(t) // Gamma's daily fixture phrasing
  ) {
    return 'sports'
  }
  if (
    /\b(election|president|presidential|senate|congress|governor|mayor|primary|parliament|prime minister|nominee|nomination|impeach|cabinet|supreme court|legislation|ceasefire|nato)\b/.test(t)
  ) {
    return 'politics'
  }
  if (
    /\b(fed|fomc|rate cut|rate hike|interest rate|inflation|cpi|gdp|recession|unemployment|jobs report|tariff|treasury|s&p 500|nasdaq)\b/.test(t)
  ) {
    return 'economics'
  }
  if (/\b(ipo|acquisition|merger|acquire|ceo|market cap|earnings|bankruptcy)\b/.test(t)) {
    return 'companies'
  }
  if (/\b(oscar|oscars|grammy|emmy|box office|album|movie|film|song|billboard|netflix|rotten tomatoes)\b/.test(t)) {
    return 'entertainment'
  }
  if (/\b(hurricane|temperature|heatwave|snow|rainfall|storm|tornado|earthquake|wildfire)\b/.test(t)) {
    return 'weather'
  }
  if (/\b(spacex|nasa|rocket launch|vaccine|fda|ai model|openai|gpt|nobel)\b/.test(t)) {
    return 'science'
  }
  return 'other'
}

/** Lifecycle mapping. `closed` wins over `active`; UMA resolution ⇒ settled. */
export function mapPolymarketStatus(raw: {
  closed: boolean
  active: boolean
  acceptingOrders?: boolean | null
  umaResolutionStatus?: string | null
}): MarketStatus {
  if ((raw.umaResolutionStatus ?? '').toLowerCase().includes('resolved')) return 'settled'
  if (raw.closed) return 'closed'
  if (raw.active) {
    // Live but not accepting orders = the venue paused trading.
    return raw.acceptingOrders === false ? 'suspended' : 'open'
  }
  return 'unknown'
}

/**
 * Normalise one Gamma market. Returns null when the outcome arrays are
 * inconsistent or the prices unusable — fabricating a probability for a
 * broken row is strictly worse than omitting the row.
 *
 * Handles any number of outcomes: Gamma binary pairs are the norm, but
 * nothing here assumes length 2 beyond the (correct) complement rule that
 * only applies when there ARE exactly two.
 */
export function mapPolymarketMarket(raw: GammaRawMarket, now: number): PredictionMarket | null {
  // The double-encoded arrays must line up index-for-index; a mismatch means
  // the payload is internally inconsistent and cannot be trusted.
  if (raw.outcomes.length === 0 || raw.outcomes.length !== raw.outcomePrices.length) return null
  const tokenIds = raw.clobTokenIds ?? []

  const prices: number[] = []
  for (const p of raw.outcomePrices) {
    const n = Number(p)
    if (!Number.isFinite(n) || n < 0 || n > 1) return null // NaN guard
    prices.push(n)
  }

  const bestBid = finiteOrNull(raw.bestBid)
  const bestAsk = finiteOrNull(raw.bestAsk)

  const outcomes: MarketOutcome[] = raw.outcomes.map((name, i) => {
    // MarketOutcome.id doubles as the CLOB token id so getOrderBook can hit
    // the book directly. Legacy markets without token ids get a synthetic but
    // stable id (no order book will exist for them anyway).
    const id = tokenIds[i] ?? `${raw.id}:${i}`
    const price = prices[i] ?? 0

    // bestBid/bestAsk quote outcome 0's token only. For a binary market the
    // second outcome's book is the same book seen from the other side:
    // bid(no) = 1 − ask(yes) and ask(no) = 1 − bid(yes) — note the SWAP as
    // well as the complement. With more than two outcomes each token has its
    // own independent book that this payload does not carry, so null.
    let bid: number | null = null
    let ask: number | null = null
    if (i === 0) {
      bid = bestBid
      ask = bestAsk
    } else if (raw.outcomes.length === 2) {
      bid = bestAsk !== null ? round4(1 - bestAsk) : null
      ask = bestBid !== null ? round4(1 - bestBid) : null
    }

    // outcomePrices is the venue's own per-outcome mid/mark — already what
    // marketProbability means, no fallback gymnastics needed.
    return { id, name, marketProbability: price, bid, ask }
  })

  // Public page lives under the parent EVENT's slug; the market's own slug is
  // only a fallback (it usually also resolves via the event router).
  const slug = raw.events?.[0]?.slug ?? raw.slug ?? null

  return {
    id: `${PROVIDER_ID}:${raw.id}`,
    provider: PROVIDER_ID,
    externalId: raw.id,
    ticker: raw.slug ?? null,
    title: raw.question,
    description: raw.description ?? null,
    // Prefer the (rare) explicit category; fall back to keyword inference over
    // every text field we have.
    category: raw.category
      ? inferPolymarketCategory(raw.category)
      : inferPolymarketCategory(`${raw.question} ${raw.slug ?? ''} ${raw.events?.[0]?.title ?? ''}`),
    outcomes,
    // Decimal strings → Number with NaN guard; USD notional.
    volume: finiteOrNull(numberish(raw.volume)) ?? 0,
    volume24h: finiteOrNull(raw.volume24hr),
    liquidity: finiteOrNull(numberish(raw.liquidity)),
    // Polymarket does not report open interest through Gamma.
    openInterest: null,
    spread: bestBid !== null && bestAsk !== null ? round4(bestAsk - bestBid) : null,
    closeTime: raw.endDate ?? null,
    // Gamma has no separate settlement timestamp; endDate is both.
    resolutionTime: raw.endDate ?? null,
    resolutionRules: raw.resolutionSource ? `Resolution source: ${raw.resolutionSource}` : null,
    status: mapPolymarketStatus(raw),
    url: slug ? `https://polymarket.com/event/${slug}` : null,
    updatedAt: raw.updatedAt ?? new Date(now).toISOString(),
  }
}

/**
 * Normalise a CLOB book. Prices are already probabilities (0..1) as strings.
 *
 * The venue sorts BOTH arrays worst→best — best bid is bids[last], best ask
 * is asks[last] (verified live: asks arrive descending). Consumers assume
 * best-first, so both sides are explicitly re-sorted rather than trusting
 * either tail.
 */
export function normaliseClobBook(
  raw: ClobRawBook,
  externalId: string,
  outcomeId: string,
): MarketOrderBook {
  const parse = (side: readonly { price: string; size: string }[]) => {
    const out: { price: number; size: number }[] = []
    for (const level of side) {
      const price = Number(level.price)
      const size = Number(level.size)
      // Drop, don't zero: a phantom 0-price level would distort imbalance.
      if (!Number.isFinite(price) || !Number.isFinite(size)) continue
      out.push({ price, size })
    }
    return out
  }

  return {
    marketId: `${PROVIDER_ID}:${externalId}`,
    outcomeId,
    bids: parse(raw.bids).sort((a, b) => b.price - a.price),
    asks: parse(raw.asks).sort((a, b) => a.price - b.price),
    timestamp: bookTimestamp(raw),
  }
}

/** data-api trade → MarketTrade. Timestamps are epoch SECONDS upstream. */
export function mapPolymarketTrade(raw: DataRawTrade, externalId: string): MarketTrade | null {
  if (!Number.isFinite(raw.price) || !Number.isFinite(raw.size)) return null
  const side = (raw.side ?? '').toUpperCase()
  return {
    marketId: `${PROVIDER_ID}:${externalId}`,
    outcomeId: raw.asset,
    price: raw.price,
    size: raw.size,
    side: side === 'BUY' ? 'buy' : side === 'SELL' ? 'sell' : 'unknown',
    timestamp: raw.timestamp * 1000, // seconds → ms
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** CLOB timestamps are ms-as-string; fall back to now if absent/garbled. */
function bookTimestamp(raw: ClobRawBook): number {
  const ts = raw.timestamp ? Number(raw.timestamp) : NaN
  return Number.isFinite(ts) && ts > 0 ? ts : Date.now()
}

function numberish(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  return Number(value)
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)))
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
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
    message: 'Polymarket payload was structurally valid but semantically unusable',
    detail,
  })
}
