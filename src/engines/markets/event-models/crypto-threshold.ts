/**
 * Crypto threshold event model — the first prediction-market event model.
 *
 * Prediction markets are full of titles like "Will BTC exceed $150,000 by
 * December 31?". This module (a) parses such a title into a structured
 * threshold query, and (b) prices the threshold event under a driftless
 * lognormal, giving the system its own probability to compare against the
 * market's.
 *
 * PARSING PHILOSOPHY: A WRONG PARSE IS WORSE THAN NO PARSE. A market this
 * model mis-parses gets priced with full confidence on the wrong question —
 * the wrong asset, the wrong strike, or the wrong direction — and the
 * resulting "edge" against the market's price is pure garbage that looks like
 * opportunity. A market it declines to parse simply gets no model price. So
 * every ambiguity resolves to null: two assets mentioned, no recognisable
 * strike, more than one distinct strike, both directional words present, or
 * no directional word at all. The parser is deliberately a coward.
 *
 * Pure throughout: strings and numbers in, values out. Deadline phrases are
 * returned as raw text rather than resolved to timestamps because resolving
 * "by Friday" requires a reference clock, and that resolution belongs to the
 * caller that owns a Clock.
 */

import { normalCdf } from '@/engines/crypto/predict'

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ThresholdSymbol = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'BNB' | 'DOGE'

export interface CryptoThresholdQuery {
  readonly symbol: ThresholdSymbol
  readonly op: 'above' | 'below'
  readonly strike: number
  /** Raw deadline phrase ("December 31", "Friday") or null when absent. */
  readonly deadline: string | null
}

/** Common-name → ticker map. Word-bounded, case-insensitive. */
const SYMBOL_PATTERNS: readonly { readonly symbol: ThresholdSymbol; readonly re: RegExp }[] = [
  { symbol: 'BTC', re: /\b(btc|xbt|bitcoin)\b/i },
  { symbol: 'ETH', re: /\b(eth|ethereum|ether)\b/i },
  { symbol: 'SOL', re: /\b(sol|solana)\b/i },
  { symbol: 'XRP', re: /\b(xrp|ripple)\b/i },
  { symbol: 'BNB', re: /\b(bnb)\b/i },
  { symbol: 'DOGE', re: /\b(doge|dogecoin)\b/i },
]

const ABOVE_RE = /\b(exceed(?:s|ed)?|above|over|surpass(?:es|ed)?|reach(?:es|ed)?|hit(?:s)?|close[sd]? above)\b/i
const BELOW_RE = /\b(below|under|beneath|(?:drop|fall|dip)s? (?:below|under)|close[sd]? below|less than)\b/i

/**
 * Strike matcher. Accepted forms, in decreasing order of confidence:
 *   $150,000  $150000  $150k  $3,500  $0.50   (dollar-prefixed)
 *   150k / 1.5m                                (k/m suffix, no $)
 *   150,000                                    (comma-grouped, no $)
 *   150000                                     (bare, but only ≥ 5 digits)
 * Bare small integers ("December 31", "Aug 15", "top 10") are NOT strikes —
 * accepting them is how a parser turns a date into a price. Hence the ≥5
 * digit rule for undecorated numbers.
 */
const NUMBER_RE = /(\$)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([km])?/gi

function extractStrikes(text: string): number[] {
  const strikes = new Set<number>()
  for (const m of text.matchAll(NUMBER_RE)) {
    const hasDollar = m[1] !== undefined
    const raw = m[2]
    const suffix = m[3]?.toLowerCase()
    if (raw === undefined) continue
    const hasCommas = raw.includes(',')
    const digitsOnly = raw.replace(/,/g, '')
    // Confidence gate — see the comment on NUMBER_RE.
    const plausible =
      hasDollar || suffix !== undefined || hasCommas || /^\d{5,}$/.test(digitsOnly)
    if (!plausible) continue
    let value = Number.parseFloat(digitsOnly)
    if (!Number.isFinite(value) || value <= 0) continue
    if (suffix === 'k') value *= 1_000
    else if (suffix === 'm') value *= 1_000_000
    strikes.add(value)
  }
  return [...strikes]
}

/** Deadline phrase: the text after the LAST "by/on/before", up to punctuation. */
function extractDeadline(text: string): string | null {
  let deadline: string | null = null
  const re = /\b(?:by|on|before)\s+([^?.!,;]+)/gi
  for (const m of text.matchAll(re)) {
    const phrase = m[1]?.trim()
    if (phrase !== undefined && phrase.length > 0) deadline = phrase
  }
  return deadline
}

export function parseCryptoThreshold(
  title: string,
  description: string | null,
): CryptoThresholdQuery | null {
  // Symbol, operator and strike are parsed from the TITLE ONLY. Descriptions
  // routinely mention other assets and other numbers ("unlike ETH, which...",
  // "the previous high of $69,000"), and mining them multiplies the
  // mis-parse surface for almost no recall gain.
  const matched = SYMBOL_PATTERNS.filter((s) => s.re.test(title))
  if (matched.length !== 1) return null // zero = unknown asset; two+ = ambiguous
  const first = matched[0]
  if (first === undefined) return null

  const isAbove = ABOVE_RE.test(title)
  const isBelow = BELOW_RE.test(title)
  if (isAbove === isBelow) return null // neither, or contradictory both

  const strikes = extractStrikes(title)
  if (strikes.length !== 1) return null // no strike, or two different ones
  const strike = strikes[0]
  if (strike === undefined) return null

  // Deadline is informational and null-safe downstream, so the description
  // may be consulted when the title lacks one.
  const deadline =
    extractDeadline(title) ?? (description !== null ? extractDeadline(description) : null)

  return {
    symbol: first.symbol,
    op: isAbove ? 'above' : 'below',
    strike,
    deadline,
  }
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** One hour, in years. Below this the lognormal model is not meaningful. */
const ONE_HOUR_YEARS = 1 / (24 * 365.25)

/**
 * P(threshold satisfied at the deadline) under a DRIFTLESS lognormal.
 *
 * DERIVATION — this is the Black–Scholes digital (cash-or-nothing) price with
 * the drift set to zero. Model the terminal price as
 *
 *     S_T = S · exp(σ√T · Z),   Z ~ N(0, 1)
 *
 * i.e. the log price diffuses with annual volatility σ and NO drift term.
 * Then:
 *
 *     P(S_T ≥ K) = P( S · exp(σ√T·Z) ≥ K )
 *                = P( Z ≥ ln(K/S) / (σ√T) )
 *                = Φ( ln(S/K) / (σ√T) )          [symmetry of the normal]
 *
 * and P(S_T < K) is its complement (the boundary has probability zero under
 * a continuous distribution, so ≥ vs > is immaterial).
 *
 * THE ZERO-DRIFT ASSUMPTION, stated plainly: we set the drift of the LOG
 * price to zero, which makes "spot equals strike" price at exactly 50% at any
 * horizon. Two honest alternatives exist and both are worse:
 *  - Extrapolating recent returns as drift bakes the last month's trend into
 *    a months-ahead forecast. Crypto drift estimates over model-relevant
 *    windows are statistically indistinguishable from zero — the standard
 *    error of a mean return dwarfs the mean — so extrapolated drift is noise
 *    presented as signal, and it is precisely the noise that momentum-chasing
 *    market participants have already priced in.
 *  - The risk-neutral Black–Scholes drift (r − σ²/2) prices a HEDGED payoff
 *    in a market with a funding leg; we are estimating a real-world
 *    probability, not pricing a replicating portfolio, and we have no crypto
 *    risk-free leg to anchor r.
 * Zero drift is the maximum-humility default: it says "we have a defensible
 * estimate of the DISPERSION of outcomes (σ) and no defensible estimate of
 * their CENTRE". Note the deliberate omission of the −σ²T/2 Itô correction as
 * well: including it makes the MEAN price the anchor while shifting the
 * MEDIAN below spot, i.e. it would make "coin at its own price" less than
 * 50/50 — a claim we have no evidence for. Anchoring the median at spot is
 * the formulation under which spot = strike ⇒ P = 0.5 exactly.
 *
 * EDGE CASES:
 *  - deadline in the past (T < 0)  → null: the event has resolved; a
 *    probability model has nothing to say.
 *  - T < 1 hour → deterministic step by spot vs strike (0.5 exactly at the
 *    money). At that horizon the diffusion term is a fraction of the spread
 *    and the answer is dominated by microstructure noise the model does not
 *    represent; pretending to a smooth probability there is false precision.
 *  - vol ≤ 0 → null: a zero or negative volatility is not a degenerate
 *    forecast, it is missing/broken input.
 */
export function thresholdProbability(params: {
  readonly spot: number
  readonly strike: number
  readonly op: 'above' | 'below'
  /** Annualised volatility as a fraction (0.55 = 55%). */
  readonly annualVol: number
  readonly yearsToDeadline: number
}): number | null {
  const { spot, strike, op, annualVol, yearsToDeadline } = params

  if (!(spot > 0) || !(strike > 0)) return null
  if (!(annualVol > 0)) return null
  if (!Number.isFinite(yearsToDeadline) || yearsToDeadline < 0) return null

  if (yearsToDeadline < ONE_HOUR_YEARS) {
    // Step function: already beyond the strike → ~certain; not → ~impossible;
    // exactly at it → a coin flip. See the edge-case note above.
    if (spot === strike) return 0.5
    const satisfiedNow = op === 'above' ? spot > strike : spot < strike
    return satisfiedNow ? 1 : 0
  }

  const d = Math.log(spot / strike) / (annualVol * Math.sqrt(yearsToDeadline))
  const pAbove = normalCdf(d)
  return op === 'above' ? pAbove : 1 - pAbove
}

// ---------------------------------------------------------------------------
// Structured (venue-reported) thresholds
// ---------------------------------------------------------------------------

/**
 * A threshold query built from a venue's STRUCTURED fields rather than parsed
 * from a title. Same role as CryptoThresholdQuery, but strikes come as a
 * floor/cap pair (floor only = "above", cap only = "below", both = range) and
 * the deadline is already an ISO timestamp rather than a prose phrase.
 */
export interface StructuredThresholdQuery {
  readonly symbol: string
  readonly floor: number | null
  readonly cap: number | null
  /** resolutionTime ?? closeTime, verbatim from the market. Null when absent. */
  readonly deadlineIso: string | null
}

/**
 * Build a StructuredThresholdQuery from a market's `derived` block.
 *
 * Returns null unless the venue reported BOTH a recognised underlying symbol
 * and at least one positive finite strike — the same cowardice contract as
 * the title parser: a market this function cannot describe exactly gets no
 * model price, never a guessed one. (A degenerate cap ≤ floor pair is left
 * for rangeProbability to reject; the strikes themselves are venue data and
 * are not reinterpreted here.)
 */
export function thresholdFromDerived(market: {
  readonly derived?: {
    readonly underlyingSymbol: string | null
    readonly floorStrike: number | null
    readonly capStrike: number | null
  } | null
  readonly closeTime: string | null
  readonly resolutionTime: string | null
}): StructuredThresholdQuery | null {
  const derived = market.derived ?? null
  if (derived === null) return null
  const { underlyingSymbol } = derived
  if (underlyingSymbol === null || underlyingSymbol === '') return null

  const floor =
    derived.floorStrike !== null && Number.isFinite(derived.floorStrike) && derived.floorStrike > 0
      ? derived.floorStrike
      : null
  const cap =
    derived.capStrike !== null && Number.isFinite(derived.capStrike) && derived.capStrike > 0
      ? derived.capStrike
      : null
  if (floor === null && cap === null) return null

  return {
    symbol: underlyingSymbol,
    floor,
    cap,
    deadlineIso: market.resolutionTime ?? market.closeTime,
  }
}

/**
 * P(floor/cap threshold satisfied at the deadline) under the same driftless
 * lognormal as thresholdProbability, of which this is a pure composition:
 *
 *   floor only → P(S_T > floor)                     ("above" market)
 *   cap only   → P(S_T < cap)                       ("below" market)
 *   both       → P(floor < S_T < cap)
 *              = P(S_T > floor) − P(S_T > cap)
 *
 * The subtraction is EXACT, not an approximation: under one terminal
 * distribution the event {S_T > cap} is a subset of {S_T > floor} whenever
 * cap > floor, so the band is their set difference and its probability is the
 * difference of theirs. The clamp to [0,1] only mops up floating-point
 * residue near the boundaries — mathematically the difference is already in
 * range.
 *
 * A degenerate pair (cap ≤ floor) is an empty or contradictory band and
 * returns null rather than 0: it signals broken input, not a priced event.
 */
export function rangeProbability(params: {
  readonly spot: number
  readonly floor: number | null
  readonly cap: number | null
  /** Annualised volatility as a fraction (0.55 = 55%). */
  readonly annualVol: number
  readonly yearsToDeadline: number
}): number | null {
  const { spot, floor, cap, annualVol, yearsToDeadline } = params

  if (floor === null && cap === null) return null

  if (floor !== null && cap === null) {
    return thresholdProbability({ spot, strike: floor, op: 'above', annualVol, yearsToDeadline })
  }
  if (cap !== null && floor === null) {
    return thresholdProbability({ spot, strike: cap, op: 'below', annualVol, yearsToDeadline })
  }
  if (floor === null || cap === null) return null // unreachable; narrows types
  if (cap <= floor) return null

  const pAboveFloor = thresholdProbability({
    spot,
    strike: floor,
    op: 'above',
    annualVol,
    yearsToDeadline,
  })
  const pAboveCap = thresholdProbability({
    spot,
    strike: cap,
    op: 'above',
    annualVol,
    yearsToDeadline,
  })
  if (pAboveFloor === null || pAboveCap === null) return null
  return Math.min(1, Math.max(0, pAboveFloor - pAboveCap))
}
