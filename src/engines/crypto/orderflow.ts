/**
 * Order flow analysis.
 *
 * ===========================================================================
 * EPISTEMICS: RESTING ORDERS ARE NOT COMMITMENTS
 * ===========================================================================
 *
 * Everything in this file that reads an order book is reading INTENTIONS THAT
 * COST NOTHING TO WITHDRAW. That single fact should govern how heavily any model
 * downstream weights these numbers, and it is worth stating plainly because the
 * order book is seductive: it is high-frequency, high-resolution, precise to the
 * tick, and it updates in real time. It looks like the highest-quality data in
 * the entire system. It is not.
 *
 * A limit order is a free option to trade, cancellable in microseconds, and on
 * crypto venues the overwhelming majority of resting size is never filled.
 * Consequences we have to design around:
 *
 *  - SPOOFING AND LAYERING ARE ROUTINE. Placing large orders with no intention
 *    of execution, to manufacture the appearance of demand or supply, is
 *    prosecuted in regulated futures markets and is an ordinary Tuesday on an
 *    offshore perpetuals venue. A "wall" is at least as likely to be an attempt
 *    to move you as it is to be real demand — and the classic pattern is a wall
 *    on the bid that vanishes the instant price approaches it, having already
 *    induced the buying it was placed to induce.
 *
 *  - THE BOOK IS ADVERSARIAL, NOT DESCRIPTIVE. Displayed size is a message
 *    aimed at other participants (and increasingly at models exactly like this
 *    one). Anything visible enough for us to read cheaply is visible enough to
 *    be worth faking.
 *
 *  - ICEBERGS AND HIDDEN LIQUIDITY CUT THE OTHER WAY. Real size is routinely
 *    concealed, so a thin-looking book may be deep. Absence of displayed
 *    liquidity is not evidence of absence of liquidity.
 *
 * EXECUTED FLOW IS DIFFERENT IN KIND. A trade that printed is a commitment
 * someone paid the spread to make and cannot cancel. Aggressor imbalance —
 * volume that lifted the offer versus volume that hit the bid — is a record of
 * revealed preference, not stated preference. The economic content per byte is
 * far higher.
 *
 * The rule this file encodes, and that the model layer must respect: WEIGHT
 * EXECUTED FLOW WELL ABOVE RESTING DEPTH. Book-derived features are
 * corroborating evidence and liquidity context; they should never be a primary
 * driver of a directional view.
 *
 * This is also exactly why `aggressorImbalance` RETURNS NULL when the venue does
 * not report taker-side volume, instead of estimating it from the candle's shape
 * or falling back to book imbalance. That null is INFORMATION: it says "the good
 * evidence is unavailable here", which correctly causes the model to abstain and
 * the ensemble to drop its vote. Substituting a plausible guess would convert a
 * known absence of evidence into apparent evidence, and — because the guess
 * would be derived from price itself — would smuggle a circular feature into the
 * model that looks predictive in backtest and is worthless live. A gap you can
 * see is worth more than a hole you have papered over.
 *
 * Pure throughout: an OrderBook or Candle array in, numbers out.
 */

import { invariant } from '@/core/errors'
import type { Candle, OrderBook, OrderBookLevel } from '@/providers/types'

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/**
 * Mid price, tolerating a one-sided book.
 *
 * Returns null only for a genuinely empty book. A one-sided book is degenerate
 * but real (thin alt pairs, exchange halts) and the best available price is the
 * side that exists.
 */
export function midPrice(book: OrderBook): number | null {
  const bestBid = book.bids[0]
  const bestAsk = book.asks[0]
  if (bestBid !== undefined && bestAsk !== undefined) return (bestBid.price + bestAsk.price) / 2
  if (bestBid !== undefined) return bestBid.price
  if (bestAsk !== undefined) return bestAsk.price
  return null
}

// ---------------------------------------------------------------------------
// Imbalance
// ---------------------------------------------------------------------------

export interface BookImbalance {
  /** Share of counted depth resting on the bid, 0..1. */
  readonly buyPressure: number
  readonly sellPressure: number
  /**
   * (bid − ask) / (bid + ask), in −1..1. BID-POSITIVE by convention: +1 means
   * every counted unit of depth is on the bid (nothing offered), −1 means every
   * counted unit is on the ask. 0 is a perfectly symmetric book.
   */
  readonly imbalance: number
  readonly bidVolume: number
  readonly askVolume: number
  readonly spread: number
  readonly spreadBps: number
  readonly midPrice: number
}

/**
 * Depth imbalance within `depthPct` of the mid.
 *
 * Only levels close to the mid are counted, and the cutoff is doing real work.
 * Resting size 5% away from the mid has almost no bearing on where price goes in
 * the next few minutes: it will not be touched, it is the cheapest place in the
 * book to display size you never intend to trade, and it is dominated by
 * market-maker inventory management and stale orders. Including it does not add
 * signal, it adds a large, slow-moving, easily-manipulated quantity that swamps
 * the near-touch depth that actually gets filled.
 *
 * The cutoff is a PERCENTAGE for the same reason level clustering is (see
 * `structure.supportResistance`): an absolute band cannot be shared between
 * assets priced four orders of magnitude apart.
 *
 * Sizes are summed in BASE units (quantity), matching the provider contract.
 * Callers comparing across price levels within a very wide `depthPct` may prefer
 * notional; near the touch the difference is immaterial.
 */
export function orderBookImbalance(book: OrderBook, depthPct = 0.005): BookImbalance {
  invariant(depthPct > 0, 'depthPct must be positive')

  const mid = midPrice(book)
  const empty: BookImbalance = {
    buyPressure: 0.5,
    sellPressure: 0.5,
    imbalance: 0,
    bidVolume: 0,
    askVolume: 0,
    spread: 0,
    spreadBps: 0,
    midPrice: 0,
  }
  if (mid === null || mid <= 0) return empty

  const bidFloor = mid * (1 - depthPct)
  const askCeiling = mid * (1 + depthPct)

  let bidVolume = 0
  for (const level of book.bids) {
    if (level.price >= bidFloor) bidVolume += level.quantity
  }
  let askVolume = 0
  for (const level of book.asks) {
    if (level.price <= askCeiling) askVolume += level.quantity
  }

  const total = bidVolume + askVolume
  const bestBid = book.bids[0]
  const bestAsk = book.asks[0]
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk.price - bestBid.price : 0

  return {
    // A book with no counted depth on either side is balanced by ignorance, not
    // by evidence — 0.5/0.5 and a zero imbalance is the neutral encoding.
    buyPressure: total === 0 ? 0.5 : bidVolume / total,
    sellPressure: total === 0 ? 0.5 : askVolume / total,
    imbalance: total === 0 ? 0 : (bidVolume - askVolume) / total,
    bidVolume,
    askVolume,
    spread,
    spreadBps: (spread / mid) * 10_000,
    midPrice: mid,
  }
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

export interface BookWall {
  readonly price: number
  readonly quantity: number
  readonly side: 'bid' | 'ask'
  /** How many times the local median level size this level is. */
  readonly multiple: number
  /** Absolute distance from mid, as a fraction (0.012 = 1.2% away). */
  readonly distancePct: number
}

export interface WallOptions {
  /** Size multiple over the local median that qualifies as a wall. */
  readonly minMultiple?: number
  /** Only consider levels within this fraction of mid. */
  readonly depthPct?: number
  /** Minimum levels on a side before a median is meaningful. */
  readonly minLevels?: number
}

/**
 * Levels whose displayed size dwarfs their neighbours.
 *
 * Compared against the MEDIAN of nearby levels rather than the mean, because the
 * mean is dragged upward by the very outlier we are hunting — a single 500× level
 * in a 20-level window raises the mean by ~25× and can hide itself. The median is
 * unmoved by up to half the sample being extreme.
 *
 * Read the file header before acting on these. A wall is a hypothesis about
 * someone's intention, and the most common intention behind a visible wall is
 * for you to see it.
 */
export function detectWalls(book: OrderBook, opts: WallOptions = {}): BookWall[] {
  const minMultiple = opts.minMultiple ?? 5
  const depthPct = opts.depthPct ?? 0.05
  const minLevels = opts.minLevels ?? 5
  invariant(minMultiple > 1, 'minMultiple must exceed 1')
  invariant(depthPct > 0, 'depthPct must be positive')

  const mid = midPrice(book)
  if (mid === null || mid <= 0) return []

  const out: BookWall[] = []
  for (const [side, levels] of [
    ['bid', book.bids],
    ['ask', book.asks],
  ] as const) {
    const local: OrderBookLevel[] = levels.filter(
      (l) => Math.abs(l.price - mid) / mid <= depthPct && l.quantity > 0,
    )
    if (local.length < minLevels) continue

    const median = medianOf(local.map((l) => l.quantity))
    if (median <= 0) continue

    for (const level of local) {
      const multiple = level.quantity / median
      if (multiple < minMultiple) continue
      out.push({
        price: level.price,
        quantity: level.quantity,
        side,
        multiple,
        distancePct: Math.abs(level.price - mid) / mid,
      })
    }
  }

  // Nearest first: a wall two ticks away is a price-relevant obstacle, one 4%
  // away is decoration.
  return out.sort((a, b) => a.distancePct - b.distancePct)
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

// ---------------------------------------------------------------------------
// Depth quality
// ---------------------------------------------------------------------------

/**
 * A 0..1 liquidity heuristic for the book as a whole.
 *
 * Four scale-free components, because there is no absolute quantity of depth
 * that means "liquid" across assets:
 *
 *  - SPREAD (35%): the only component that is a direct, unfakeable cost. You pay
 *    it to cross. Decays exponentially with a ~10bps scale.
 *  - LEVEL COUNT near the touch (30%): a continuous book absorbs size; a book of
 *    three levels gaps.
 *  - BALANCE (20%): a wildly one-sided book is cheap to trade one way and
 *    expensive the other, which is not liquidity.
 *  - UNIFORMITY (15%): depth concentrated in a single level is one cancellation
 *    away from not existing. Distributed depth is more robust — and harder to
 *    fake convincingly.
 *
 * This is a comparative measure (is this book better than that one, is it worse
 * than an hour ago), not an absolute one, and it should be used to SIZE
 * confidence in other order-flow features rather than as a signal itself.
 */
export function bookDepthScore(book: OrderBook, depthPct = 0.01): number {
  const mid = midPrice(book)
  if (mid === null || mid <= 0) return 0
  if (book.bids.length === 0 || book.asks.length === 0) return 0

  const imbalance = orderBookImbalance(book, depthPct)
  const spreadScore = Math.exp(-Math.max(0, imbalance.spreadBps) / 10)

  const near = [...book.bids, ...book.asks].filter(
    (l) => Math.abs(l.price - mid) / mid <= depthPct && l.quantity > 0,
  )
  const levelScore = clamp01(near.length / 40)
  const balanceScore = clamp01(1 - Math.abs(imbalance.imbalance))

  let total = 0
  let largest = 0
  for (const l of near) {
    total += l.quantity
    if (l.quantity > largest) largest = l.quantity
  }
  const uniformityScore = total === 0 ? 0 : clamp01(1 - largest / total)

  return clamp01(
    0.35 * spreadScore + 0.3 * levelScore + 0.2 * balanceScore + 0.15 * uniformityScore,
  )
}

// ---------------------------------------------------------------------------
// Executed flow
// ---------------------------------------------------------------------------

export interface AggressorFlow {
  /** Volume that lifted the offer (buyer-initiated). */
  readonly buyVolume: number
  /** Volume that hit the bid (seller-initiated). */
  readonly sellVolume: number
  /** (buy − sell) / total, −1..1. Bid-positive, matching `BookImbalance`. */
  readonly imbalance: number
  /** buy / total, 0..1. */
  readonly buyRatio: number
  /** Fraction of the supplied candles that actually reported taker volume. */
  readonly coverage: number
  readonly candlesUsed: number
}

/**
 * Executed (aggressor) imbalance from `takerBuyVolume`.
 *
 * Every trade has a buyer and a seller, so "buy volume" here does not mean net
 * buying — it means volume where the BUYER was the aggressor, crossing the
 * spread to get filled immediately. That impatience is the informative part:
 * paying the spread is a revealed willingness to trade at a worse price now
 * rather than a better price maybe, and it is the closest thing in public market
 * data to a statement of conviction.
 *
 * Sell volume is derived as `volume − takerBuyVolume` because that identity is
 * exact by construction, and clamped at 0 against venue rounding.
 *
 * RETURNS NULL when no candle in the range reports `takerBuyVolume`. See the
 * file header: this is the single most important behaviour in this module. Some
 * venues simply do not publish taker side. When they do not, the correct output
 * is "unknown", which propagates into a model abstention, rather than a number
 * reverse-engineered from price action that would be both circular and
 * indistinguishable from real flow once it entered the feature vector.
 *
 * Partial coverage is reported rather than rejected: candles missing the field
 * are skipped and `coverage` tells the caller how much of the window actually
 * contributed, so a downstream confidence can be scaled by it.
 */
export function aggressorImbalance(candles: readonly Candle[]): AggressorFlow | null {
  if (candles.length === 0) return null

  let buyVolume = 0
  let sellVolume = 0
  let reported = 0

  for (const c of candles) {
    if (c.takerBuyVolume === null) continue
    reported++
    const taker = Math.max(0, Math.min(c.takerBuyVolume, c.volume))
    buyVolume += taker
    sellVolume += Math.max(0, c.volume - taker)
  }

  // The venue does not report it at all — not a gap to paper over.
  if (reported === 0) return null

  const total = buyVolume + sellVolume
  return {
    buyVolume,
    sellVolume,
    imbalance: total === 0 ? 0 : (buyVolume - sellVolume) / total,
    buyRatio: total === 0 ? 0.5 : buyVolume / total,
    coverage: reported / candles.length,
    candlesUsed: reported,
  }
}
