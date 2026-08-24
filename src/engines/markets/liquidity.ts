/**
 * Liquidity assessment for prediction markets.
 *
 * ===========================================================================
 * WHY LIQUIDITY IS A FIRST-CLASS SCORE AND NOT A FOOTNOTE
 * ===========================================================================
 *
 * An edge you cannot execute is not an edge — it is trivia. A 12pp divergence
 * on a market with a 15pp bid/ask spread and $40 of resting depth is worth
 * exactly nothing, and a scoring engine that ranks it above a 5pp divergence
 * on a deep, tight market is actively misleading its user. Liquidity is
 * therefore scored on the same 0–100 scale as everything else and fed into the
 * opportunity score with real weight.
 *
 * Three components, in order of importance:
 *
 *  1. SPREAD. The spread is the toll you pay to exist in the market — you pay
 *     half of it entering and half exiting, and unlike volume it cannot be
 *     waited out. A 1pp spread is excellent; 10pp is nearly untradeable.
 *
 *  2. VOLUME. Log-scaled, because liquidity utility is logarithmic: the
 *     difference between $1k and $100k of traded volume is the difference
 *     between "nobody is here" and "a real market", while $10M vs $20M is a
 *     rounding error for any position a retail-scale participant would take.
 *
 *  3. DEPTH. Resting size near the mid, read from the order book when we have
 *     one. Note the epistemics in `src/engines/crypto/orderflow.ts`: resting
 *     orders are intentions that cost nothing to withdraw, so depth is
 *     corroborating evidence, never the headline. Crucially, a MISSING book is
 *     not a neutral fact — if we cannot see the depth we cannot certify the
 *     market as excellent, so a null depth LOWERS THE CEILING of the score
 *     rather than being silently dropped from the average.
 *
 * Pure throughout: market fields and an optional book in, an assessment out.
 */

import type { LiquidityAssessment, LiquidityGrade, MarketOrderBook } from '@/core/markets/types'

// ---------------------------------------------------------------------------
// Tunables (all documented where used)
// ---------------------------------------------------------------------------

/** Spread (in probability points) at which the spread score is exactly 50. */
const SPREAD_HALF_SCORE_PP = 0.04

/** Price band around the mid, in probability points, that counts as "near". */
const DEPTH_BAND_PP = 0.05

/** Ceiling applied when no order book is available: depth is unverifiable, so
 *  the market can grade at most 'good', never 'excellent'. */
const NO_BOOK_SCORE_CEILING = 70

/** Component weights. Spread dominates by design — see the header. */
const W_SPREAD = 0.45
const W_VOLUME = 0.3
const W_DEPTH = 0.25

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

function clamp0100(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 100) return 100
  return x
}

/**
 * Log-scaled 0–100 score: 0 at 10^lo, 100 at 10^hi, linear in log10 between.
 *
 * The +1 keeps log10 defined at zero; negative or non-finite inputs (a venue
 * bug, a NaN from a broken feed) clamp to zero rather than poisoning the score.
 */
function logScore(value: number, lo: number, hi: number): number {
  const safe = Number.isFinite(value) && value > 0 ? value : 0
  return 100 * clamp01((Math.log10(safe + 1) - lo) / (hi - lo))
}

// ---------------------------------------------------------------------------
// Component scores
// ---------------------------------------------------------------------------

/**
 * Spread score: 100 / (1 + (s / s₅₀)²) with s₅₀ = 4pp.
 *
 * Shape rationale: this is a quadratic-decay logistic ("half-score at 4pp").
 * It is nearly flat for tight spreads (1pp → ≈94, so excellent spreads are not
 * over-differentiated), crosses 50 at 4pp, and collapses fast beyond that
 * (10pp → ≈14, i.e. nearly untradeable). The quadratic exponent is what makes
 * the decay smooth at the top and steep in the middle — a linear decay would
 * punish a 1.5pp spread far too much, and an exponential decay would not
 * punish an 8pp spread enough.
 *
 * Strictly decreasing in spread, which the opportunity score's monotonicity
 * tests rely on.
 */
export function spreadScore(spreadPp: number): number {
  const s = clamp01(spreadPp)
  const ratio = s / SPREAD_HALF_SCORE_PP
  return 100 / (1 + ratio * ratio)
}

/**
 * Volume score: a weighted blend of whatever activity evidence the venue gave
 * us, each piece log-scaled (see the header for why log).
 *
 *  - lifetime volume:  0 at $100,   saturates at $1M   (weight 0.5)
 *  - 24h volume:       0 at ~$30,   saturates at $100k (weight 0.3)
 *  - venue liquidity:  0 at $100,   saturates at $100k (weight 0.2)
 *
 * Missing pieces are dropped and the weights renormalised over what is
 * present — a venue that does not report 24h volume is not thereby punished,
 * because absence of the FIELD is a venue characteristic, not a market one.
 * (Contrast the order book, where absence genuinely hides risk and does cap
 * the total — see assessLiquidity.)
 */
export function volumeScore(
  volume: number,
  volume24h: number | null,
  liquidity: number | null,
): number {
  const parts: { score: number; weight: number }[] = [
    { score: logScore(volume, 2, 6), weight: 0.5 },
  ]
  if (volume24h !== null) parts.push({ score: logScore(volume24h, 1.5, 5), weight: 0.3 })
  if (liquidity !== null) parts.push({ score: logScore(liquidity, 2, 5), weight: 0.2 })

  let total = 0
  let weight = 0
  for (const p of parts) {
    total += p.score * p.weight
    weight += p.weight
  }
  return weight > 0 ? total / weight : 0
}

/** Mid of the book's best quotes, tolerating a one-sided book (thin markets
 *  really do go one-sided); null when no level carries a usable price. A
 *  NaN-priced top-of-book (feed bug) is skipped rather than allowed to poison
 *  the mid — everything downstream (depth band, slippage) keys off this. */
function bookMid(book: MarketOrderBook): number | null {
  const bid = book.bids.find((l) => Number.isFinite(l.price) && l.price > 0)
  const ask = book.asks.find((l) => Number.isFinite(l.price) && l.price > 0)
  if (bid !== undefined && ask !== undefined) return (bid.price + ask.price) / 2
  if (bid !== undefined) return bid.price
  if (ask !== undefined) return ask.price
  return null
}

/**
 * Depth score: total resting size within ±5pp of the mid, both sides summed
 * symmetrically, log-scaled from 10 contracts (score 0) to 10,000 (score 100).
 *
 * Returns null only when there is no book to read. An EMPTY book that we did
 * receive scores 0 — "we looked and nothing is there" is information, and it
 * is very different information from "we could not look".
 */
export function depthScore(book: MarketOrderBook | null | undefined): number | null {
  if (book === null || book === undefined) return null
  const mid = bookMid(book)
  if (mid === null) return 0

  let size = 0
  for (const level of book.bids) {
    if (Number.isFinite(level.size) && level.size > 0 && Math.abs(level.price - mid) <= DEPTH_BAND_PP) {
      size += level.size
    }
  }
  for (const level of book.asks) {
    if (Number.isFinite(level.size) && level.size > 0 && Math.abs(level.price - mid) <= DEPTH_BAND_PP) {
      size += level.size
    }
  }
  return logScore(size, 1, 4)
}

// ---------------------------------------------------------------------------
// Slippage
// ---------------------------------------------------------------------------

/**
 * Expected average fill-price deviation from the mid when buying `notional`
 * (in venue currency — price × size units) by walking the displayed asks.
 *
 * Returns null when it cannot be estimated at all:
 *  - no book, no asks, or no computable mid;
 *  - notional non-positive or non-finite;
 *  - the displayed book cannot absorb the order. That last case is NOT zero
 *    slippage and not "large" slippage — it is unbounded, and inventing a
 *    finite number for it would let an unfillable order look merely expensive.
 *    Null here means "do not size this trade off the displayed book".
 *
 * Like everything book-derived, this is a floor on true cost, not an
 * estimate of it: displayed liquidity can vanish before you arrive.
 */
export function estimateSlippage(
  book: MarketOrderBook | null | undefined,
  notional: number,
): number | null {
  if (book === null || book === undefined) return null
  if (!Number.isFinite(notional) || notional <= 0) return null

  const mid = bookMid(book)
  if (mid === null) return null

  // Sort defensively: providers should send asks ascending, but a scoring
  // engine that trusts feed ordering is a scoring engine with latent bugs.
  const asks = [...book.asks]
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price)
  if (asks.length === 0) return null

  let remaining = notional
  let cost = 0
  let contracts = 0
  for (const level of asks) {
    const levelNotional = level.price * level.size
    const spend = Math.min(remaining, levelNotional)
    cost += spend
    contracts += spend / level.price
    remaining -= spend
    if (remaining <= 1e-12) break
  }
  if (remaining > 1e-9) return null // book exhausted: unbounded slippage

  const avgFill = cost / contracts
  return Math.max(0, avgFill - mid)
}

// ---------------------------------------------------------------------------
// The assessment
// ---------------------------------------------------------------------------

export function gradeFromScore(score: number): LiquidityGrade {
  if (score >= 80) return 'excellent'
  if (score >= 60) return 'good'
  if (score >= 40) return 'fair'
  if (score >= 20) return 'poor'
  return 'illiquid'
}

export function assessLiquidity(params: {
  /** Bid/ask spread in probability points (0..1), or null when unreported. */
  spread: number | null
  volume: number
  volume24h: number | null
  liquidity: number | null
  book?: MarketOrderBook | null
}): LiquidityAssessment {
  const notes: string[] = []

  // --- Spread ---------------------------------------------------------------
  // A missing or garbage spread is treated as UNKNOWN, not as zero: an unknown
  // spread earns a conservative low-middling score with a note, because "the
  // venue did not tell us the toll" is a reason for caution, not optimism.
  const spreadValid = params.spread !== null && Number.isFinite(params.spread)
  const spreadPp = spreadValid ? clamp01(params.spread as number) : null
  const sSpread = spreadPp !== null ? spreadScore(spreadPp) : 35
  if (spreadPp === null) notes.push('Spread unreported — spread component scored conservatively at 35/100')

  // --- Volume ---------------------------------------------------------------
  const vol24Valid = params.volume24h !== null && Number.isFinite(params.volume24h)
  const liqValid = params.liquidity !== null && Number.isFinite(params.liquidity)
  const sVolume = volumeScore(
    params.volume,
    vol24Valid ? (params.volume24h as number) : null,
    liqValid ? (params.liquidity as number) : null,
  )
  if (!Number.isFinite(params.volume) || params.volume <= 0) {
    notes.push('No usable lifetime volume — activity evidence is thin')
  }

  // --- Depth ----------------------------------------------------------------
  const sDepth = depthScore(params.book)

  // --- Combination ----------------------------------------------------------
  // With a book: straightforward weighted sum.
  // Without a book: renormalise the remaining weights so spread/volume still
  // fill the 0–100 range, THEN cap at NO_BOOK_SCORE_CEILING. The cap is the
  // load-bearing part — dropping the depth term without a cap would let a
  // bookless market grade 'excellent' on spread and volume alone, and depth is
  // exactly the thing spread and volume cannot certify.
  let score: number
  if (sDepth !== null) {
    score = W_SPREAD * sSpread + W_VOLUME * sVolume + W_DEPTH * sDepth
  } else {
    score = (W_SPREAD * sSpread + W_VOLUME * sVolume) / (W_SPREAD + W_VOLUME)
    if (score > NO_BOOK_SCORE_CEILING) {
      score = NO_BOOK_SCORE_CEILING
      notes.push(
        `Order book unavailable — depth unverifiable, score capped at ${NO_BOOK_SCORE_CEILING} (grade at most 'good')`,
      )
    } else {
      notes.push('Order book unavailable — depth unverifiable')
    }
  }

  score = clamp0100(score)
  return {
    score,
    grade: gradeFromScore(score),
    spreadPp,
    depthScore: sDepth !== null ? clamp0100(sDepth) : null,
    volumeScore: clamp0100(sVolume),
    notes,
  }
}
