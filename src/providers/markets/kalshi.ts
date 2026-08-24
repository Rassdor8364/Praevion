/**
 * Kalshi (trade-api v2, public market data).
 *
 * Kalshi is the venue itself, so the market data is first-party —
 * PRIMARY_SOURCE. Public read endpoints work keyless; KALSHI_API_KEY_ID (plus
 * a private key) only becomes necessary for trading and portfolio endpoints,
 * which this adapter does not touch. The env var is read so a later
 * authenticated upgrade has somewhere to plug in, but isConfigured() is true
 * regardless.
 *
 * API quirks this adapter absorbs (all verified against the live API):
 *
 *  - Kalshi has MIGRATED off the documented integer-cent fields. `yes_bid`,
 *    `yes_ask`, `last_price` (0–100 cents) are gone from responses; prices now
 *    arrive as DOLLAR STRINGS like "0.4200" (`yes_bid_dollars`, …), which are
 *    already in probability units — parse with a NaN guard, do NOT divide by
 *    100. Sizes/volumes arrive as fixed-point strings (`volume_fp`,
 *    `open_interest_fp`).
 *  - The market object no longer carries `category`; category lives on the
 *    EVENT. getMarkets therefore lists via /events?with_nested_markets=true
 *    (one call gets category + markets), and getMarket makes a second, small
 *    call to /events/{event_ticker}.
 *  - The bare /markets listing is flooded with auto-generated multivariate
 *    parlay stubs (KXMVE…, zero volume, zero quotes). The /events listing does
 *    not include them, which is the second reason it is the listing endpoint.
 *  - Open markets report `status: "active"`, not "open".
 *  - The order book has only BIDS: `yes_dollars` are YES bids and `no_dollars`
 *    are NO bids. See normaliseKalshiBook for the equivalence transformation.
 */

import { z } from 'zod'
import { ProviderError } from '@/core/errors'
import { err, ok } from '@/core/result'
import type {
  MarketCategory,
  MarketOrderBook,
  MarketOrderBookLevel,
  MarketStatus,
  MarketTrade,
  PredictionMarket,
} from '@/core/markets/types'
import { fetchJson } from '../http'
import type { Capability, ProviderHealth, ProviderResult, Sourced } from '../types'
import type { PredictionMarketProvider } from './types'

const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const PROVIDER_ID = 'kalshi'
const RATE_LIMIT = { capacity: 8, windowMs: 1000 } as const

// ---------------------------------------------------------------------------
// Schemas — field names verified via live curl on 2026-08-12
// ---------------------------------------------------------------------------

const KalshiMarketSchema = z.object({
  ticker: z.string(),
  event_ticker: z.string(),
  title: z.string(),
  /** Human label of the YES side, e.g. "Over 14.5 runs scored" or "OpenAI". */
  yes_sub_title: z.string().nullish(),
  no_sub_title: z.string().nullish(),
  status: z.string(),
  // All prices are dollar strings in 0..1 — probability units already.
  yes_bid_dollars: z.string().nullish(),
  yes_ask_dollars: z.string().nullish(),
  no_bid_dollars: z.string().nullish(),
  no_ask_dollars: z.string().nullish(),
  last_price_dollars: z.string().nullish(),
  // Fixed-point contract counts as strings.
  volume_fp: z.string().nullish(),
  volume_24h_fp: z.string().nullish(),
  liquidity_dollars: z.string().nullish(),
  open_interest_fp: z.string().nullish(),
  open_time: z.string().nullish(),
  close_time: z.string().nullish(),
  /** When Kalshi expects settlement; `expiration_time` is the hard deadline. */
  expected_expiration_time: z.string().nullish(),
  expiration_time: z.string().nullish(),
  rules_primary: z.string().nullish(),
  rules_secondary: z.string().nullish(),
  updated_time: z.string().nullish(),
  // Structured strikes for numeric-threshold markets (crypto price levels,
  // temperatures, index levels …). Verified live: KXBTCD markets report e.g.
  // `floor_strike: 73249.99` ("$73,250 or above"), KXBTC "between" markets
  // report both floor_strike and cap_strike. Plain numbers, not strings.
  floor_strike: z.number().nullish(),
  cap_strike: z.number().nullish(),
})

const KalshiEventSchema = z.object({
  event_ticker: z.string(),
  series_ticker: z.string().nullish(),
  title: z.string().nullish(),
  category: z.string().nullish(),
  markets: z.array(KalshiMarketSchema).nullish(),
})

const EventsPageSchema = z.object({
  cursor: z.string().nullish(),
  events: z.array(KalshiEventSchema),
})

/** /markets?series_ticker=… page — used by the curated crypto listing path. */
const MarketsPageSchema = z.object({
  cursor: z.string().nullish(),
  markets: z.array(KalshiMarketSchema),
})

const SingleMarketSchema = z.object({ market: KalshiMarketSchema })
const SingleEventSchema = z.object({ event: KalshiEventSchema })

/** [price_dollars, size_fp] — both strings, e.g. ["0.3500", "10.00"]. */
const BookLevelSchema = z.tuple([z.string(), z.string()])

const OrderBookSchema = z.object({
  // The legacy integer-cent `orderbook` envelope is gone; the live API serves
  // `orderbook_fp` with dollar-string levels. Empty sides arrive as [] or null.
  orderbook_fp: z.object({
    yes_dollars: z.array(BookLevelSchema).nullish(),
    no_dollars: z.array(BookLevelSchema).nullish(),
  }),
})

const TradeSchema = z.object({
  trade_id: z.string(),
  ticker: z.string(),
  count_fp: z.string(),
  yes_price_dollars: z.string(),
  no_price_dollars: z.string().nullish(),
  /** Which side the aggressor took: "yes" or "no". */
  taker_side: z.string().nullish(),
  created_time: z.string(),
})

const TradesPageSchema = z.object({
  cursor: z.string().nullish(),
  trades: z.array(TradeSchema),
})

type KalshiRawMarket = z.infer<typeof KalshiMarketSchema>
type KalshiRawBook = z.infer<typeof OrderBookSchema>['orderbook_fp']
type KalshiRawTrade = z.infer<typeof TradeSchema>

// ---------------------------------------------------------------------------
// Crypto series curation
// ---------------------------------------------------------------------------

/**
 * Curated liquid crypto series for the category-'crypto' listing path.
 *
 * Rationale: Kalshi's /events listing surfaces crypto markets only as they
 * happen to fall on a page, so category-'crypto' scans saw almost none. These
 * are the DAILY above/below/range series (settle on a 60-second average of the
 * CF Benchmarks real-time index at 5 PM EDT) — terminal-price thresholds, i.e.
 * exactly the event shape the crypto-threshold model prices, and the liquid
 * core of Kalshi's crypto offering. All verified live on 2026-08-12 to exist
 * and return open markets via /markets?series_ticker=X&status=open:
 *
 *   KXBTCD / KXETHD           — daily BTC/ETH "or above" ladders
 *   KXBTC  / KXETH            — daily BTC/ETH range ladders (floor+cap bands)
 *   KXSOLD / KXXRPD / KXDOGED — daily SOL/XRP/DOGE ladders
 *
 * Deliberately EXCLUDED: KXBTCMAXY / KXBTCMINY / KXETHMAXY / KXETHMINY (huge
 * volume, but they resolve on TOUCHING the level at any point before year end
 * — a barrier event the terminal-distribution model would systematically
 * underprice).
 */
const CRYPTO_SERIES: readonly string[] = [
  'KXBTCD',
  'KXETHD',
  'KXBTC',
  'KXETH',
  'KXSOLD',
  'KXXRPD',
  'KXDOGED',
]

/**
 * Series/event-ticker prefix → underlying symbol.
 *
 * Matches the known Kalshi crypto series families — an optional KX prefix,
 * the asset, and an optional known family suffix (D = daily, H = hourly,
 * MAX/MIN/MAXY/MINY = touch series, Y = yearly) — so `KXSOLD` maps to SOL
 * while an unrelated series that merely starts with the same letters (e.g. a
 * hypothetical KXSOLDIER) does not. Covers the KXBTC…, BTCMAX…, BTCMIN…
 * families → BTC; KXETH…, ETHMAX…, ETHMIN… → ETH; KXSOL… → SOL; KXXRP… → XRP;
 * KXDOGE… → DOGE. Unknown prefix → null: an underlying is venue-structured
 * data, never a guess.
 */
const UNDERLYING_RE = /^(?:KX)?(BTC|ETH|SOL|XRP|DOGE)(?:D|H|Y|MAXY?|MINY?)?$/
const UNDERLYING_MAP: Readonly<Record<string, string>> = {
  BTC: 'BTC',
  ETH: 'ETH',
  SOL: 'SOL',
  XRP: 'XRP',
  DOGE: 'DOGE',
}

/** Underlying symbol from a series ticker (or the event ticker's first '-' segment). */
export function kalshiUnderlyingSymbol(seriesOrEventTicker: string | null): string | null {
  if (seriesOrEventTicker === null || seriesOrEventTicker === '') return null
  const head = seriesOrEventTicker.split('-')[0]
  if (head === undefined) return null
  const m = UNDERLYING_RE.exec(head.toUpperCase())
  const asset = m?.[1]
  if (asset === undefined) return null
  return UNDERLYING_MAP[asset] ?? null
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class KalshiProvider implements PredictionMarketProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'Kalshi'
  readonly reliability = 'PRIMARY_SOURCE' as const
  readonly isDemo = false
  readonly capabilities: readonly Capability[] = [
    'markets.list',
    'markets.detail',
    'markets.orderbook',
    'markets.trades',
  ]

  isConfigured(): boolean {
    // Public market data needs no key. KALSHI_API_KEY_ID is optional headroom
    // for authenticated endpoints (higher limits, portfolio) later.
    return true
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/events?status=open&limit=1`,
      schema: EventsPageSchema,
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

  async getMarkets(params: {
    category?: MarketCategory
    limit: number
    cursor?: string
  }): Promise<ProviderResult<{ markets: PredictionMarket[]; nextCursor: string | null }>> {
    // Crypto gets its own listing path: the /events feed only surfaces crypto
    // markets incidentally, so a category-'crypto' scan through it was near
    // empty. The curated liquid series are fetched directly instead. Every
    // other category — including undefined — keeps the events-based path.
    if (params.category === 'crypto') return this.getCryptoMarkets(params.limit)

    // `limit` here bounds EVENTS, not markets: the cursor advances whole
    // events, so trimming the flattened market list mid-event would silently
    // orphan the tail of the last event (it never reappears on the next page).
    // Callers therefore get "at least limit-ish" semantics; Kalshi caps a page
    // at 200 events.
    const limit = clamp(params.limit, 1, 200)
    const cursorParam = params.cursor ? `&cursor=${encodeURIComponent(params.cursor)}` : ''
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/events?status=open&with_nested_markets=true&limit=${limit}${cursorParam}`,
      schema: EventsPageSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const now = Date.now()
    const markets: PredictionMarket[] = []
    for (const event of r.value.events) {
      const category = mapKalshiCategory(event.category ?? null)
      // Kalshi has no server-side category filter on /events, so filtering is
      // client-side: a filtered page may be short, but never mislabelled.
      if (params.category !== undefined && category !== params.category) continue
      for (const raw of event.markets ?? []) {
        const mapped = mapKalshiMarket(raw, {
          category: event.category ?? null,
          seriesTicker: event.series_ticker ?? null,
          now,
        })
        // Null = quotes unusable (all NaN). Dropping the row beats emitting a
        // market whose "probability" is a parse artefact.
        if (mapped) markets.push(mapped)
      }
    }

    // Kalshi signals exhaustion with an empty cursor string.
    const nextCursor = r.value.cursor ? r.value.cursor : null
    return ok(sourced({ markets, nextCursor }, now))
  }

  /**
   * Curated crypto listing: open markets from each series in CRYPTO_SERIES,
   * fetched concurrently. An individual series failure degrades the result
   * (that ladder is simply absent) rather than aborting the scan; only a
   * whole-board failure surfaces as an error. `limit` bounds markets PER
   * SERIES — one series is one strike ladder, and trimming across ladders
   * would arbitrarily drop whole assets. No pagination: the curated snapshot
   * is the product.
   */
  private async getCryptoMarkets(
    limit: number,
  ): Promise<ProviderResult<{ markets: PredictionMarket[]; nextCursor: string | null }>> {
    const perSeries = clamp(limit, 1, 200)
    const now = Date.now()
    const failures: string[] = []
    const markets: PredictionMarket[] = []

    const pages = await Promise.all(
      CRYPTO_SERIES.map(async (series) => {
        const r = await fetchJson({
          providerId: this.id,
          url: `${BASE}/markets?series_ticker=${series}&status=open&limit=${perSeries}`,
          schema: MarketsPageSchema,
          headers: headers(),
          rateLimit: RATE_LIMIT,
        })
        return { series, result: r }
      }),
    )

    for (const { series, result } of pages) {
      if (!result.ok) {
        failures.push(`${series}: ${result.error.message}`)
        continue
      }
      for (const raw of result.value.markets) {
        // /markets carries no event category, but every curated series is a
        // crypto series by construction — the label is known, not guessed.
        const mapped = mapKalshiMarket(raw, { category: 'Crypto', seriesTicker: series, now })
        if (mapped) markets.push(mapped)
      }
    }

    if (markets.length === 0 && failures.length > 0) {
      return err(
        new ProviderError({
          kind: 'upstream_unavailable',
          providerId: this.id,
          message: 'All curated Kalshi crypto series failed to list',
          detail: failures.join('; '),
        }),
      )
    }

    return ok(sourced({ markets, nextCursor: null }, now))
  }

  async getMarket(externalId: string): Promise<ProviderResult<PredictionMarket>> {
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/markets/${encodeURIComponent(externalId)}`,
      schema: SingleMarketSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    // The market object carries no category since the dollars migration; it
    // lives on the event, so a second (cheap, cacheable) call fetches it. If
    // that call fails the market is still returned — with category 'other' —
    // because a missing label must not take down a priced market.
    let eventCategory: string | null = null
    let seriesTicker: string | null = null
    const eventR = await fetchJson({
      providerId: this.id,
      url: `${BASE}/events/${encodeURIComponent(r.value.market.event_ticker)}`,
      schema: SingleEventSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (eventR.ok) {
      eventCategory = eventR.value.event.category ?? null
      seriesTicker = eventR.value.event.series_ticker ?? null
    }

    const now = Date.now()
    const mapped = mapKalshiMarket(r.value.market, { category: eventCategory, seriesTicker, now })
    if (!mapped) return err(badPayload(`market ${externalId} had no parseable price`))
    return ok(sourced(mapped, now))
  }

  async getOrderBook(
    externalId: string,
    outcomeId: string,
  ): Promise<ProviderResult<MarketOrderBook>> {
    if (outcomeId !== 'yes' && outcomeId !== 'no') {
      return err(
        new ProviderError({
          kind: 'not_found',
          providerId: this.id,
          message: `Kalshi outcomes are 'yes' or 'no', got "${outcomeId}"`,
        }),
      )
    }
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/markets/${encodeURIComponent(externalId)}/orderbook`,
      schema: OrderBookSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const now = Date.now()
    return ok(sourced(normaliseKalshiBook(r.value.orderbook_fp, externalId, outcomeId, now), now))
  }

  async getTrades(externalId: string, limit: number): Promise<ProviderResult<MarketTrade[]>> {
    const capped = clamp(limit, 1, 1000)
    const r = await fetchJson({
      providerId: this.id,
      url: `${BASE}/markets/trades?ticker=${encodeURIComponent(externalId)}&limit=${capped}`,
      schema: TradesPageSchema,
      headers: headers(),
      rateLimit: RATE_LIMIT,
    })
    if (!r.ok) return err(r.error)

    const trades: MarketTrade[] = []
    for (const raw of r.value.trades) {
      const mapped = mapKalshiTrade(raw)
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
 * Kalshi event category → MarketCategory.
 *
 * Live categories observed: Sports, Economics, Financials, Elections,
 * Politics, Entertainment, "Science and Technology", "Climate and Weather",
 * Companies, Health, World, Social, Transportation. Matching is
 * case-insensitive; anything unrecognised is 'other' rather than a guess.
 */
export function mapKalshiCategory(category: string | null): MarketCategory {
  switch ((category ?? '').toLowerCase()) {
    case 'politics':
    case 'elections':
    case 'world': // geopolitics — closest bucket we have
      return 'politics'
    case 'economics':
    case 'financials':
      return 'economics'
    case 'crypto':
    case 'cryptocurrency':
      return 'crypto'
    case 'sports':
      return 'sports'
    case 'climate and weather':
      return 'weather'
    case 'entertainment':
      return 'entertainment'
    case 'science and technology':
    case 'health':
      return 'science'
    case 'companies':
      return 'companies'
    default:
      return 'other'
  }
}

/** Kalshi reports "active" for tradeable markets; map the full lifecycle. */
export function mapKalshiStatus(status: string): MarketStatus {
  switch (status.toLowerCase()) {
    case 'active':
    case 'open':
      return 'open'
    case 'closed':
      return 'closed'
    case 'settled':
    case 'finalized':
    case 'determined':
      return 'settled'
    case 'paused':
    case 'inactive':
      return 'suspended'
    default:
      return 'unknown'
  }
}

/**
 * Normalise one Kalshi market. Returns null when the quote fields are
 * unusable (non-numeric strings) — a market with no parseable price is worse
 * than a missing market.
 */
export function mapKalshiMarket(
  raw: KalshiRawMarket,
  ctx: { category: string | null; seriesTicker: string | null; now: number },
): PredictionMarket | null {
  // Dollar strings are ALREADY probabilities (0..1). The old integer-cent
  // fields (divide by 100) no longer exist on the live API.
  const yesBid = toProb(raw.yes_bid_dollars)
  const yesAsk = toProb(raw.yes_ask_dollars)
  const noBid = toProb(raw.no_bid_dollars)
  const noAsk = toProb(raw.no_ask_dollars)
  const last = toProb(raw.last_price_dollars)

  // marketProbability for YES: last trade, falling back to the book mid.
  // Rationale: last trade is the venue's own headline number, but a market
  // that has never traded reports last = 0, and "0% probability" would be a
  // fabrication — the quoted mid is the market's actual current belief there.
  // (When neither exists the market is unpriceable and dropped.)
  const mid = yesBid !== null && yesAsk !== null ? (yesBid + yesAsk) / 2 : null
  const pYes = last !== null && last > 0 ? last : mid
  if (pYes === null) return null

  // Kalshi duplicates yes_sub_title into no_sub_title (both say "OpenAI" /
  // "Over 14.5 runs scored"), so the sub title only names the YES side; the
  // NO outcome gets a plain 'No' rather than a misleading duplicate.
  const yesName = raw.yes_sub_title ? raw.yes_sub_title : 'Yes'

  const outcomes = [
    { id: 'yes', name: yesName, marketProbability: pYes, bid: yesBid, ask: yesAsk },
    // Binary complement: P(no) = 1 − P(yes), so the two always sum to 1.
    { id: 'no', name: 'No', marketProbability: 1 - pYes, bid: noBid, ask: noAsk },
  ]

  const volume = toFinite(raw.volume_fp)

  // Structured strikes → derived underlying data. The strikes are taken
  // verbatim from the venue; only the UNDERLYING is inferred, and strictly
  // from the series/event ticker prefix (kalshiUnderlyingSymbol returns null
  // for anything unrecognised — weather ladders also carry floor_strike, and
  // a temperature must never be priced as a coin). floor only = "above";
  // cap only = "below"; both = range market.
  const floorStrike = typeof raw.floor_strike === 'number' && Number.isFinite(raw.floor_strike)
    ? raw.floor_strike
    : null
  const capStrike = typeof raw.cap_strike === 'number' && Number.isFinite(raw.cap_strike)
    ? raw.cap_strike
    : null
  const derived =
    floorStrike !== null || capStrike !== null
      ? {
          underlyingSymbol: kalshiUnderlyingSymbol(ctx.seriesTicker ?? raw.event_ticker),
          floorStrike,
          capStrike,
        }
      : null

  return {
    id: `${PROVIDER_ID}:${raw.ticker}`,
    provider: PROVIDER_ID,
    externalId: raw.ticker,
    ticker: raw.ticker,
    title: raw.title,
    // The market object has no prose of its own; the YES sub title is the
    // closest thing to a one-line description ("Over 14.5 runs scored").
    description: raw.yes_sub_title ? raw.yes_sub_title : null,
    category: mapKalshiCategory(ctx.category),
    outcomes,
    // volume_fp counts CONTRACTS (each settles at $1), not dollars traded.
    volume: volume ?? 0,
    volume24h: toFinite(raw.volume_24h_fp),
    liquidity: toFinite(raw.liquidity_dollars),
    openInterest: toFinite(raw.open_interest_fp),
    // Already probability units — no /100.
    spread: yesBid !== null && yesAsk !== null ? round4(yesAsk - yesBid) : null,
    closeTime: raw.close_time ?? null,
    // expected_expiration_time is when Kalshi anticipates settling;
    // expiration_time is the contractual deadline (often days later). The
    // expected time is the one a "time to resolution" display wants.
    resolutionTime: raw.expected_expiration_time ?? raw.expiration_time ?? null,
    resolutionRules: joinRules(raw.rules_primary, raw.rules_secondary),
    status: mapKalshiStatus(raw.status),
    // The trade API exposes no web slug, so per-market deep links cannot be
    // built; the series page is the closest stable URL.
    url: ctx.seriesTicker ? `https://kalshi.com/markets/${ctx.seriesTicker.toLowerCase()}` : null,
    updatedAt: raw.updated_time ?? new Date(ctx.now).toISOString(),
    derived,
  }
}

/**
 * Normalise Kalshi's one-sided book into a bid/ask book for one outcome.
 *
 * Kalshi's book contains ONLY resting bids: `yes_dollars` are bids to buy
 * YES, `no_dollars` are bids to buy NO. There is no ask array. The
 * equivalence that recovers the ask side:
 *
 *   a NO bid at price p IS a YES ask at (1 − p)
 *
 * because filling that NO bid mints a contract pair — the NO bidder pays p,
 * the counterparty pays (1 − p) for the YES side. So someone bidding 0.35 for
 * NO is offering YES at 0.65. (In the retired integer-cent format this was
 * 100 − p; in dollars it is 1 − p.)
 *
 * Getting this backwards INVERTS book imbalance — deep NO interest would read
 * as YES buying pressure — so the transformation is asserted directly in the
 * normalisation tests.
 *
 * Kalshi lists each side ascending by price (best bid LAST); output follows
 * the house convention: bids best-first descending, asks best-first ascending.
 */
export function normaliseKalshiBook(
  raw: KalshiRawBook,
  externalId: string,
  outcomeId: 'yes' | 'no',
  timestamp: number,
): MarketOrderBook {
  const yesBids = levels(raw.yes_dollars)
  const noBids = levels(raw.no_dollars)

  // For the YES outcome: bids are the YES bids verbatim; asks are the NO bids
  // reflected through 1 − p. For NO, the mirror image.
  const bids = outcomeId === 'yes' ? yesBids : noBids
  const asks = (outcomeId === 'yes' ? noBids : yesBids).map((l) => ({
    price: round4(1 - l.price),
    size: l.size,
  }))

  return {
    marketId: `${PROVIDER_ID}:${externalId}`,
    outcomeId,
    bids: [...bids].sort((a, b) => b.price - a.price),
    asks: [...asks].sort((a, b) => a.price - b.price),
    timestamp,
  }
}

/**
 * One Kalshi trade, priced in YES probability. `taker_side: "yes"` means the
 * aggressor bought YES (buy pressure); "no" means the aggressor bought NO,
 * which is selling YES — mapped to 'sell' so order-flow signs stay coherent
 * with the YES-denominated price.
 */
export function mapKalshiTrade(raw: KalshiRawTrade): MarketTrade | null {
  const price = toProb(raw.yes_price_dollars)
  const size = toFinite(raw.count_fp)
  const ts = Date.parse(raw.created_time)
  if (price === null || size === null || !Number.isFinite(ts)) return null
  const taker = (raw.taker_side ?? '').toLowerCase()
  return {
    marketId: `${PROVIDER_ID}:${raw.ticker}`,
    outcomeId: 'yes',
    price,
    size,
    side: taker === 'yes' ? 'buy' : taker === 'no' ? 'sell' : 'unknown',
    timestamp: ts,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function levels(
  raw: readonly (readonly [string, string])[] | null | undefined,
): MarketOrderBookLevel[] {
  const out: MarketOrderBookLevel[] = []
  for (const [priceStr, sizeStr] of raw ?? []) {
    const price = Number(priceStr)
    const size = Number(sizeStr)
    // A level that does not parse is dropped, not zeroed — a phantom level at
    // price 0 would distort depth and imbalance measures.
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue
    out.push({ price, size })
  }
  return out
}

/** Dollar-string → probability with NaN + range guard. */
function toProb(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 1) return null
  return n
}

function toFinite(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function joinRules(primary: string | null | undefined, secondary: string | null | undefined): string | null {
  const parts = [primary, secondary].filter((s): s is string => typeof s === 'string' && s.length > 0)
  return parts.length > 0 ? parts.join('\n\n') : null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)))
}

/** Avoid 0.65000000000000002-style float noise on derived prices. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

function headers(): Record<string, string> {
  return { 'User-Agent': 'VixeraIntelligence/1.0' }
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
    message: 'Kalshi payload was structurally valid but semantically unusable',
    detail,
  })
}
