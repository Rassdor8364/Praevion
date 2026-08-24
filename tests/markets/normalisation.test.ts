/**
 * Pure normalisation tests for the prediction-market providers.
 *
 * Fixtures are REAL payloads captured from the live APIs via curl on
 * 2026-08-12, scrubbed down to a few representative markets (descriptions
 * trimmed, trader identity fields dropped). They pin the shapes the mappers
 * were written against, so an upstream contract change that also breaks these
 * fixtures is a signal the adapter needs revisiting — not that the tests do.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  KalshiProvider,
  kalshiUnderlyingSymbol,
  mapKalshiCategory,
  mapKalshiMarket,
  mapKalshiStatus,
  mapKalshiTrade,
  normaliseKalshiBook,
} from '@/providers/markets/kalshi'
import {
  GammaMarketSchema,
  PolymarketProvider,
  inferPolymarketCategory,
  mapPolymarketMarket,
  mapPolymarketStatus,
  mapPolymarketTrade,
  normaliseClobBook,
} from '@/providers/markets/polymarket'
import { DemoPredictionMarketProvider } from '@/providers/markets/demo'

/** noUncheckedIndexedAccess-friendly unwrap; throws instead of asserting non-null. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value, got nothing')
  return value
}

const NOW = 1_786_562_700_000 // fixed clock for deterministic updatedAt fallbacks

// ---------------------------------------------------------------------------
// Kalshi fixtures — captured live 2026-08-12
// ---------------------------------------------------------------------------

/** From /events?with_nested_markets=true — event KXOAIANTH-40 (category Financials). */
const KALSHI_OAI_MARKET = {
  ticker: 'KXOAIANTH-40-OAI',
  event_ticker: 'KXOAIANTH-40',
  title: 'Will OpenAI or Anthropic IPO first?',
  yes_sub_title: 'OpenAI',
  no_sub_title: 'OpenAI', // Kalshi duplicates the YES label here — real quirk
  status: 'active',
  yes_bid_dollars: '0.1000',
  yes_ask_dollars: '0.1200',
  no_bid_dollars: '0.8800',
  no_ask_dollars: '0.9000',
  last_price_dollars: '0.1000',
  volume_fp: '163905.32',
  volume_24h_fp: '474.71',
  liquidity_dollars: '0.0000',
  open_interest_fp: '41878.68',
  close_time: '2040-01-01T04:59:00Z',
  expected_expiration_time: '2040-01-01T15:00:00Z',
  expiration_time: '2040-01-08T15:00:00Z',
  rules_primary: 'If OpenAI confirms an IPO first, before Jan 1, 2040, then the market resolves to Yes.',
  rules_secondary: '',
  updated_time: '2026-08-12T18:51:06.891844Z',
}

/** From /markets — the day's most-traded market (Sports event, never-traded variant below). */
const KALSHI_MLB_MARKET = {
  ticker: 'KXMLBTOTAL-26AUG121340BALMIN-15',
  event_ticker: 'KXMLBTOTAL-26AUG121340BALMIN',
  title: 'Baltimore vs Minnesota Total Runs?',
  yes_sub_title: 'Over 14.5 runs scored',
  no_sub_title: 'Over 14.5 runs scored',
  status: 'active',
  yes_bid_dollars: '0.4100',
  yes_ask_dollars: '0.4200',
  no_bid_dollars: '0.5800',
  no_ask_dollars: '0.5900',
  last_price_dollars: '0.4200',
  volume_fp: '89418.79',
  volume_24h_fp: '64820.31',
  liquidity_dollars: '0.0000',
  open_interest_fp: '55649.41',
  close_time: '2026-08-15T17:40:00Z',
  expected_expiration_time: '2026-08-12T23:40:00Z',
  expiration_time: '2026-08-15T17:40:00Z',
  rules_primary: 'If Baltimore and Minnesota collectively score more 14.5 runs…, then the market resolves to Yes.',
  rules_secondary: 'Kalshi is not affiliated with the Governing League.',
  updated_time: '2026-08-12T18:51:06.891844Z',
}

/** From /markets?series_ticker=KXBTCD&status=open — a crypto threshold market
 *  whose strike lives in STRUCTURED fields (floor_strike), not the title. */
const KALSHI_BTCD_MARKET = {
  ticker: 'KXBTCD-26AUG1317-T73249.99',
  event_ticker: 'KXBTCD-26AUG1317',
  title: 'Bitcoin price on Aug 13, 2026?',
  yes_sub_title: '$73,250 or above',
  no_sub_title: '$73,250 or above',
  status: 'active',
  yes_bid_dollars: '0.0000',
  yes_ask_dollars: '0.0100',
  no_bid_dollars: '0.9900',
  no_ask_dollars: '1.0000',
  last_price_dollars: '0.0000',
  volume_fp: '0.00',
  volume_24h_fp: '0.00',
  liquidity_dollars: '0.0000',
  open_interest_fp: '0.00',
  close_time: '2026-08-13T21:00:00Z',
  expected_expiration_time: '2026-08-13T21:05:00Z',
  expiration_time: '2026-08-13T21:05:00Z',
  rules_primary:
    "If the simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before 5 PM EDT is above 73249.99 at 5 PM EDT on Aug 13, 2026, then the market resolves to Yes.",
  rules_secondary: '',
  updated_time: '2026-08-12T18:51:06.891844Z',
  floor_strike: 73249.99,
  cap_strike: null,
}

/** From /markets/{ticker}/orderbook — trimmed to the top of each side. Both
 *  arrays are BIDS (yes_dollars = YES bids, no_dollars = NO bids), ascending
 *  by price, best LAST. */
const KALSHI_BOOK = {
  yes_dollars: [
    ['0.3500', '10.00'],
    ['0.4000', '6620.00'],
    ['0.4100', '282.00'],
  ] as [string, string][],
  no_dollars: [
    ['0.3500', '10.00'],
    ['0.5700', '5887.00'],
    ['0.5800', '716.00'],
  ] as [string, string][],
}

/** From /markets/trades?ticker=… */
const KALSHI_TRADES = [
  {
    trade_id: '91ccbd0e-8a25-44ed-cfcb-c6ecda914826',
    ticker: 'KXMLBTOTAL-26AUG121340BALMIN-15',
    count_fp: '42.00',
    yes_price_dollars: '0.4100',
    no_price_dollars: '0.5900',
    taker_side: 'no',
    created_time: '2026-08-12T19:23:51.826089Z',
  },
  {
    trade_id: 'db1e8594-8d93-4b70-43a7-185ca2f9be7b',
    ticker: 'KXMLBTOTAL-26AUG121340BALMIN-15',
    count_fp: '37.00',
    yes_price_dollars: '0.4200',
    no_price_dollars: '0.5800',
    taker_side: 'yes',
    created_time: '2026-08-12T19:23:39.932545Z',
  },
]

// ---------------------------------------------------------------------------
// Polymarket fixtures — captured live 2026-08-12
// ---------------------------------------------------------------------------

/** From gamma-api /markets/3228928 — note the double-encoded arrays. */
const POLY_PSG_MARKET = {
  id: '3228928',
  question: 'Will Paris Saint-Germain win on 2026-08-12?',
  conditionId: '0xa010c8e7ab644ca49a8c7d015bd80d6524e2d822fec6077e1f1019327507c65b',
  slug: 'usc-psg-av-2026-08-12-psg',
  description: 'In the upcoming game, scheduled for August 12, 2026. If Paris Saint-Germain wins, this market will resolve to "Yes".',
  endDate: '2026-08-12T19:00:00Z',
  startDate: '2026-07-30T18:45:18Z',
  liquidity: '156371.1345',
  volume: '2731216.8687199936',
  volume24hr: 2703527.2055060016,
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.775", "0.225"]',
  clobTokenIds:
    '["61589009001195241558796708472897936503409913017383866002372087826054686967938", "66637820407304201646122137659668789933309332134728114443782639182600124598971"]',
  category: null,
  resolutionSource: 'https://www.uefa.com/uefasupercup/',
  closed: false,
  active: true,
  acceptingOrders: true,
  bestBid: 0.77,
  bestAsk: 0.78,
  lastTradePrice: 0.78,
  spread: 0.01,
  umaResolutionStatus: null,
  updatedAt: '2026-08-12T19:22:01.352417Z',
  events: [{ slug: 'usc-psg-av-2026-08-12', title: 'Paris Saint-Germain vs. Aston Villa' }],
}

/** From clob /book?token_id=… — trimmed. Real quirk preserved: BOTH sides are
 *  sorted worst→best (best bid LAST, best ask LAST). */
const POLY_BOOK = {
  market: '0xa010c8e7ab644ca49a8c7d015bd80d6524e2d822fec6077e1f1019327507c65b',
  asset_id: '61589009001195241558796708472897936503409913017383866002372087826054686967938',
  timestamp: '1786562707093',
  bids: [
    { price: '0.01', size: '1328527.89' },
    { price: '0.5', size: '2000' },
    { price: '0.81', size: '4615.3' },
  ],
  asks: [
    { price: '0.99', size: '19331.22' },
    { price: '0.9', size: '500' },
    { price: '0.82', size: '6967.44' },
  ],
}

/** From data-api /trades?market=… — identity fields scrubbed. */
const POLY_TRADES = [
  {
    asset: '69815433755527399235253950720383654969045226116027917429716895193489256245442',
    side: 'SELL',
    price: 0.999,
    size: 266.21,
    timestamp: 1786562626, // epoch SECONDS — the mapper must convert
    outcome: 'Vitality',
    outcomeIndex: 0,
  },
]

// ===========================================================================
// Kalshi
// ===========================================================================

describe('mapKalshiMarket', () => {
  const ctx = { category: 'Financials', seriesTicker: 'KXOAIANTH', now: NOW }

  it('parses dollar strings as probabilities directly (no /100)', () => {
    const m = must(mapKalshiMarket(KALSHI_OAI_MARKET, ctx))
    const yes = must(m.outcomes[0])
    expect(yes.marketProbability).toBe(0.1) // last_price_dollars "0.1000"
    expect(yes.bid).toBe(0.1)
    expect(yes.ask).toBe(0.12)
  })

  it('computes spread from the YES touch in probability points', () => {
    const m = must(mapKalshiMarket(KALSHI_OAI_MARKET, ctx))
    expect(m.spread).toBeCloseTo(0.02, 10)
  })

  it('binary outcomes sum to ~1 and NO carries its own quotes', () => {
    const m = must(mapKalshiMarket(KALSHI_OAI_MARKET, ctx))
    const yes = must(m.outcomes[0])
    const no = must(m.outcomes[1])
    expect(yes.marketProbability + no.marketProbability).toBeCloseTo(1, 10)
    expect(no.bid).toBe(0.88)
    expect(no.ask).toBe(0.9)
    // The duplicated no_sub_title must not become the NO outcome's name.
    expect(no.name).toBe('No')
  })

  it('falls back to the book mid when the market has never traded (last = 0)', () => {
    const neverTraded = { ...KALSHI_MLB_MARKET, last_price_dollars: '0.0000' }
    const m = must(mapKalshiMarket(neverTraded, { category: 'Sports', seriesTicker: null, now: NOW }))
    const yes = must(m.outcomes[0])
    expect(yes.marketProbability).toBeCloseTo((0.41 + 0.42) / 2, 10)
  })

  it('uses last trade when it exists', () => {
    const m = must(mapKalshiMarket(KALSHI_MLB_MARKET, { category: 'Sports', seriesTicker: null, now: NOW }))
    expect(must(m.outcomes[0]).marketProbability).toBe(0.42)
  })

  it('returns null instead of NaN when quotes are garbage', () => {
    const broken = {
      ...KALSHI_OAI_MARKET,
      last_price_dollars: 'garbage',
      yes_bid_dollars: 'NaNsense',
      yes_ask_dollars: null,
    }
    expect(mapKalshiMarket(broken, ctx)).toBeNull()
  })

  it('guards individual quote fields without dropping the market', () => {
    const partial = { ...KALSHI_OAI_MARKET, yes_ask_dollars: 'oops' }
    const m = must(mapKalshiMarket(partial, ctx))
    const yes = must(m.outcomes[0])
    expect(yes.ask).toBeNull()
    expect(yes.bid).toBe(0.1)
    expect(m.spread).toBeNull() // no touch, no spread — never NaN
  })

  it('populates derived from structured strikes on a real KXBTCD market', () => {
    const m = must(
      mapKalshiMarket(KALSHI_BTCD_MARKET, { category: 'Crypto', seriesTicker: 'KXBTCD', now: NOW }),
    )
    expect(m.category).toBe('crypto')
    expect(m.derived).toEqual({
      underlyingSymbol: 'BTC',
      floorStrike: 73249.99, // venue-verbatim, never re-derived from the title
      capStrike: null,
    })
    // The title alone carries no strike — precisely why derived must exist.
    const yes = must(m.outcomes[0])
    expect(yes.marketProbability).toBeCloseTo(0.005, 10) // never traded → book mid
  })

  it('carries both strikes for a range ("between") market', () => {
    const between = {
      ...KALSHI_BTCD_MARKET,
      ticker: 'KXBTC-26AUG1317-B73125',
      event_ticker: 'KXBTC-26AUG1317',
      yes_sub_title: '$73,000 to 73,249.99',
      floor_strike: 73000,
      cap_strike: 73249.99,
    }
    const m = must(mapKalshiMarket(between, { category: 'Crypto', seriesTicker: 'KXBTC', now: NOW }))
    expect(m.derived).toEqual({ underlyingSymbol: 'BTC', floorStrike: 73000, capStrike: 73249.99 })
  })

  it('an unknown series with strikes yields underlyingSymbol null — never a guess', () => {
    // Weather ladders carry floor_strike too; a temperature must not become a coin.
    const weather = { ...KALSHI_BTCD_MARKET, ticker: 'KXHIGHNY-26AUG13-T88', floor_strike: 88 }
    const m = must(
      mapKalshiMarket(weather, { category: 'Climate and Weather', seriesTicker: 'KXHIGHNY', now: NOW }),
    )
    expect(m.derived).toEqual({ underlyingSymbol: null, floorStrike: 88, capStrike: null })
  })

  it('leaves derived null when the venue reports no strikes', () => {
    const m = must(mapKalshiMarket(KALSHI_OAI_MARKET, ctx))
    expect(m.derived ?? null).toBeNull()
  })

  it('falls back to the event ticker prefix when the series ticker is missing', () => {
    const m = must(mapKalshiMarket(KALSHI_BTCD_MARKET, { category: null, seriesTicker: null, now: NOW }))
    expect(m.derived?.underlyingSymbol).toBe('BTC') // from event_ticker KXBTCD-26AUG1317
  })

  it('maps event category, status, volumes and canonical ids', () => {
    const m = must(mapKalshiMarket(KALSHI_OAI_MARKET, ctx))
    expect(m.category).toBe('economics') // Financials → economics
    expect(m.status).toBe('open') // "active" → open
    expect(m.id).toBe('kalshi:KXOAIANTH-40-OAI')
    expect(m.volume).toBeCloseTo(163905.32, 5)
    expect(m.openInterest).toBeCloseTo(41878.68, 5)
    expect(m.url).toBe('https://kalshi.com/markets/kxoaianth')
    // expected_expiration_time wins over the contractual deadline
    expect(m.resolutionTime).toBe('2040-01-01T15:00:00Z')
  })
})

describe('mapKalshiCategory / mapKalshiStatus', () => {
  it('maps live category labels, case-insensitively', () => {
    expect(mapKalshiCategory('Sports')).toBe('sports')
    expect(mapKalshiCategory('Elections')).toBe('politics')
    expect(mapKalshiCategory('Climate and Weather')).toBe('weather')
    expect(mapKalshiCategory('Science and Technology')).toBe('science')
    expect(mapKalshiCategory('Companies')).toBe('companies')
    expect(mapKalshiCategory('crypto')).toBe('crypto')
    expect(mapKalshiCategory('Transportation')).toBe('other')
    expect(mapKalshiCategory(null)).toBe('other')
  })

  it('maps lifecycle statuses conservatively', () => {
    expect(mapKalshiStatus('active')).toBe('open')
    expect(mapKalshiStatus('settled')).toBe('settled')
    expect(mapKalshiStatus('paused')).toBe('suspended')
    expect(mapKalshiStatus('who_knows')).toBe('unknown')
  })
})

describe('kalshiUnderlyingSymbol', () => {
  it('maps the known crypto series families', () => {
    expect(kalshiUnderlyingSymbol('KXBTCD')).toBe('BTC')
    expect(kalshiUnderlyingSymbol('KXBTC')).toBe('BTC')
    expect(kalshiUnderlyingSymbol('KXBTCMAXY')).toBe('BTC')
    expect(kalshiUnderlyingSymbol('BTCMAX')).toBe('BTC') // legacy, no KX prefix
    expect(kalshiUnderlyingSymbol('BTCMIN')).toBe('BTC')
    expect(kalshiUnderlyingSymbol('KXETHD')).toBe('ETH')
    expect(kalshiUnderlyingSymbol('ETHMAX')).toBe('ETH')
    expect(kalshiUnderlyingSymbol('KXSOLD')).toBe('SOL') // SOL + D, not English "sold"
    expect(kalshiUnderlyingSymbol('KXXRPD')).toBe('XRP')
    expect(kalshiUnderlyingSymbol('KXDOGED')).toBe('DOGE')
    // Event tickers work via their first '-' segment.
    expect(kalshiUnderlyingSymbol('KXBTCD-26AUG1317')).toBe('BTC')
  })

  it('refuses everything else — unknown prefixes are null, never a guess', () => {
    expect(kalshiUnderlyingSymbol('KXHIGHNY')).toBeNull() // NYC high temperature
    expect(kalshiUnderlyingSymbol('KXSOLDIER')).toBeNull() // SOL prefix, wrong family
    expect(kalshiUnderlyingSymbol('KXOAIANTH')).toBeNull()
    expect(kalshiUnderlyingSymbol(null)).toBeNull()
    expect(kalshiUnderlyingSymbol('')).toBeNull()
  })
})

describe('normaliseKalshiBook', () => {
  it('reflects NO bids into YES asks at 1 − p (a NO bid at 0.35 IS a YES ask at 0.65)', () => {
    const book = normaliseKalshiBook(
      { yes_dollars: [], no_dollars: [['0.3500', '10.00']] },
      'T',
      'yes',
      NOW,
    )
    const ask = must(book.asks[0])
    expect(ask.price).toBe(0.65)
    expect(ask.size).toBe(10)
    expect(book.bids).toHaveLength(0)
  })

  it('orients the YES book correctly: bids best-first desc, asks best-first asc', () => {
    const book = normaliseKalshiBook(KALSHI_BOOK, 'KXMLBTOTAL-26AUG121340BALMIN-15', 'yes', NOW)
    // Best YES bid is Kalshi's LAST yes_dollars level (0.41)
    expect(must(book.bids[0]).price).toBe(0.41)
    expect(must(book.bids[0]).size).toBe(282)
    expect(must(book.bids[2]).price).toBe(0.35)
    // Best YES ask comes from the deepest NO bid: 1 − 0.58 = 0.42
    expect(must(book.asks[0]).price).toBe(0.42)
    expect(must(book.asks[0]).size).toBe(716)
    expect(must(book.asks[2]).price).toBe(0.65)
    // Getting the reflection backwards would invert the imbalance: assert the
    // touch is crossed-free (best bid < best ask).
    expect(must(book.bids[0]).price).toBeLessThan(must(book.asks[0]).price)
  })

  it('mirrors for the NO outcome', () => {
    const book = normaliseKalshiBook(KALSHI_BOOK, 'T', 'no', NOW)
    expect(must(book.bids[0]).price).toBe(0.58) // best NO bid verbatim
    expect(must(book.asks[0]).price).toBeCloseTo(0.59, 10) // 1 − best YES bid 0.41
  })

  it('drops unparseable levels instead of emitting phantom prices', () => {
    const book = normaliseKalshiBook(
      { yes_dollars: [['garbage', '5.00'], ['0.4000', '1.00']], no_dollars: null },
      'T',
      'yes',
      NOW,
    )
    expect(book.bids).toHaveLength(1)
    expect(must(book.bids[0]).price).toBe(0.4)
  })
})

describe('mapKalshiTrade', () => {
  it('prices in YES terms and signs by taker side', () => {
    const sell = must(mapKalshiTrade(must(KALSHI_TRADES[0])))
    expect(sell.price).toBe(0.41)
    expect(sell.size).toBe(42)
    expect(sell.side).toBe('sell') // taker bought NO = sold YES
    const buy = must(mapKalshiTrade(must(KALSHI_TRADES[1])))
    expect(buy.side).toBe('buy')
    expect(buy.timestamp).toBe(Date.parse('2026-08-12T19:23:39.932545Z'))
  })
})

// ===========================================================================
// Polymarket
// ===========================================================================

/** Route a raw fixture through the exact schema (double-encoding transform
 *  included) that production traffic takes, then hand it to the mapper. */
function gamma(overrides: Record<string, unknown> = {}) {
  return GammaMarketSchema.parse({ ...POLY_PSG_MARKET, ...overrides })
}

describe('GammaMarketSchema', () => {
  it('rejects a broken double-encoded array as a schema failure (→ schema_mismatch)', () => {
    expect(GammaMarketSchema.safeParse({ ...POLY_PSG_MARKET, outcomes: 'not json {{{' }).success).toBe(false)
    expect(
      GammaMarketSchema.safeParse({ ...POLY_PSG_MARKET, outcomePrices: '{"an":"object"}' }).success,
    ).toBe(false)
  })
})

describe('mapPolymarketMarket', () => {
  it('parses the double-encoded outcome arrays and uses token ids as outcome ids', () => {
    const m = must(mapPolymarketMarket(gamma(), NOW))
    expect(m.outcomes).toHaveLength(2)
    const yes = must(m.outcomes[0])
    expect(yes.name).toBe('Yes')
    expect(yes.id).toBe(
      '61589009001195241558796708472897936503409913017383866002372087826054686967938',
    )
    expect(yes.marketProbability).toBe(0.775)
  })

  it('binary outcomes sum to ~1 and the second outcome gets swapped-complement quotes', () => {
    const m = must(mapPolymarketMarket(gamma(), NOW))
    const yes = must(m.outcomes[0])
    const no = must(m.outcomes[1])
    expect(yes.marketProbability + no.marketProbability).toBeCloseTo(1, 10)
    expect(yes.bid).toBe(0.77)
    expect(yes.ask).toBe(0.78)
    // bid(no) = 1 − ask(yes); ask(no) = 1 − bid(yes) — swap AND complement.
    expect(no.bid).toBeCloseTo(0.22, 10)
    expect(no.ask).toBeCloseTo(0.23, 10)
  })

  it('converts string liquidity/volume with a NaN guard', () => {
    const m = must(mapPolymarketMarket(gamma(), NOW))
    expect(m.volume).toBeCloseTo(2731216.87, 2)
    expect(m.liquidity).toBeCloseTo(156371.13, 2)
    const broken = must(mapPolymarketMarket(gamma({ liquidity: 'not-a-number', volume: null }), NOW))
    expect(broken.liquidity).toBeNull()
    expect(broken.volume).toBe(0)
  })

  it('returns null (not NaN probabilities) when a price does not parse', () => {
    expect(mapPolymarketMarket(gamma({ outcomePrices: '["0.775", "banana"]' }), NOW)).toBeNull()
  })

  it('returns null when outcomes and prices disagree in length', () => {
    expect(mapPolymarketMarket(gamma({ outcomePrices: '["0.775"]' }), NOW)).toBeNull()
  })

  it('handles multi-outcome markets generally — quotes null beyond the first token', () => {
    const m = must(
      mapPolymarketMarket(
        gamma({
          outcomes: '["Candidate A", "Candidate B", "Candidate C"]',
          outcomePrices: '["0.5", "0.3", "0.2"]',
          clobTokenIds: '["111", "222", "333"]',
        }),
        NOW,
      ),
    )
    expect(m.outcomes).toHaveLength(3)
    const probs = m.outcomes.map((o) => o.marketProbability)
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    expect(must(m.outcomes[2]).id).toBe('333')
    // The binary complement rule must NOT fire for three outcomes.
    expect(must(m.outcomes[1]).bid).toBeNull()
    expect(must(m.outcomes[2]).ask).toBeNull()
    expect(must(m.outcomes[0]).bid).toBe(0.77)
  })

  it('builds the public URL from the parent event slug', () => {
    const m = must(mapPolymarketMarket(gamma(), NOW))
    expect(m.url).toBe('https://polymarket.com/event/usc-psg-av-2026-08-12')
    expect(m.id).toBe('polymarket:3228928')
  })

  it('maps status: open while accepting orders, suspended when not, settled via UMA', () => {
    expect(mapPolymarketStatus(POLY_PSG_MARKET)).toBe('open')
    expect(mapPolymarketStatus({ ...POLY_PSG_MARKET, acceptingOrders: false })).toBe('suspended')
    expect(mapPolymarketStatus({ ...POLY_PSG_MARKET, closed: true })).toBe('closed')
    expect(mapPolymarketStatus({ ...POLY_PSG_MARKET, umaResolutionStatus: 'resolved' })).toBe(
      'settled',
    )
  })
})

describe('inferPolymarketCategory', () => {
  it('classifies from question text, defaulting to other', () => {
    expect(inferPolymarketCategory('Will Bitcoin close above $150k?')).toBe('crypto')
    expect(inferPolymarketCategory('Will Paris Saint-Germain win on 2026-08-12?')).toBe('sports')
    expect(inferPolymarketCategory('Who wins the Wisconsin Governor primary election?')).toBe('politics')
    expect(inferPolymarketCategory('Fed rate cut in September?')).toBe('economics')
    expect(inferPolymarketCategory('Will the film win Best Picture at the Oscars?')).toBe('entertainment')
    expect(inferPolymarketCategory('Category 5 hurricane landfall this season?')).toBe('weather')
    expect(inferPolymarketCategory('Something entirely unclassifiable')).toBe('other')
  })
})

describe('normaliseClobBook', () => {
  it('re-sorts the venue worst→best arrays into best-first on both sides', () => {
    const book = normaliseClobBook(POLY_BOOK, '3228928', 'token-1')
    // Venue: best bid LAST (0.81), best ask LAST (0.82).
    expect(must(book.bids[0]).price).toBe(0.81)
    expect(must(book.bids[2]).price).toBe(0.01)
    expect(must(book.asks[0]).price).toBe(0.82)
    expect(must(book.asks[2]).price).toBe(0.99)
    expect(must(book.bids[0]).price).toBeLessThan(must(book.asks[0]).price)
    expect(book.timestamp).toBe(1786562707093) // ms-string parsed
    expect(book.marketId).toBe('polymarket:3228928')
  })

  it('drops NaN levels instead of crashing or zeroing', () => {
    const book = normaliseClobBook(
      { ...POLY_BOOK, bids: [{ price: 'x', size: '1' }, { price: '0.5', size: '2' }] },
      'm',
      't',
    )
    expect(book.bids).toHaveLength(1)
    expect(must(book.bids[0]).price).toBe(0.5)
  })
})

describe('mapPolymarketTrade', () => {
  it('converts epoch seconds to ms and lowercases the side', () => {
    const t = must(mapPolymarketTrade(must(POLY_TRADES[0]), '3471044'))
    expect(t.timestamp).toBe(1786562626000)
    expect(t.side).toBe('sell')
    expect(t.price).toBe(0.999)
    expect(t.outcomeId).toBe(
      '69815433755527399235253950720383654969045226116027917429716895193489256245442',
    )
  })
})

// ===========================================================================
// Malformed payloads must surface as schema_mismatch, never a crash
// ===========================================================================

describe('malformed upstream payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetchJson(payload: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    )
  }

  it('Polymarket: broken double-encoded arrays produce schema_mismatch', async () => {
    stubFetchJson([{ ...POLY_PSG_MARKET, outcomes: 'not json at all {{{' }])
    const r = await new PolymarketProvider().getMarkets({ limit: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_mismatch')
  })

  it('Kalshi: a structurally wrong events page produces schema_mismatch', async () => {
    stubFetchJson({ cursor: '', events: [{ event_ticker: 42 }] })
    const r = await new KalshiProvider().getMarkets({ limit: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_mismatch')
  })

  it('Kalshi: a wrong orderbook envelope produces schema_mismatch', async () => {
    stubFetchJson({ orderbook: { yes: [[35, 10]], no: [] } }) // the RETIRED format
    const r = await new KalshiProvider().getOrderBook('T', 'yes')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_mismatch')
  })
})

// ===========================================================================
// Demo provider — determinism and isDemo contract
// ===========================================================================

describe('DemoPredictionMarketProvider', () => {
  it('is deterministic across instances and flags every payload isDemo', async () => {
    const a = await new DemoPredictionMarketProvider().getMarkets({ limit: 10 })
    const b = await new DemoPredictionMarketProvider().getMarkets({ limit: 10 })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.value.provenance.isDemo).toBe(true)
      expect(a.value.data.markets).toEqual(b.value.data.markets)
      expect(a.value.data.markets.length).toBe(10)
      for (const m of a.value.data.markets) {
        const yes = must(m.outcomes[0])
        const no = must(m.outcomes[1])
        expect(yes.marketProbability + no.marketProbability).toBeCloseTo(1, 10)
        expect(yes.marketProbability).toBeGreaterThan(0)
        expect(yes.marketProbability).toBeLessThan(1)
      }
    }
  })

  it('serves a coherent, non-crossed book per outcome', async () => {
    const r = await new DemoPredictionMarketProvider().getOrderBook('DEMO-CB-CUT', 'yes')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const { bids, asks } = r.value.data
      expect(must(bids[0]).price).toBeLessThan(must(asks[0]).price)
      expect(r.value.provenance.isDemo).toBe(true)
    }
  })

  it('filters by category', async () => {
    const r = await new DemoPredictionMarketProvider().getMarkets({ limit: 10, category: 'sports' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.data.markets.length).toBeGreaterThan(0)
      for (const m of r.value.data.markets) expect(m.category).toBe('sports')
    }
  })
})
