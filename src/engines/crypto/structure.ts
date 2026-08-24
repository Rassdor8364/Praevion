/**
 * Market structure analysis.
 *
 * Indicators describe what price has DONE; structure describes the shape price
 * is currently trading inside — where it has repeatedly turned, whether the
 * sequence of turns is stepping up or down, and whether a level has actually
 * given way or merely been probed.
 *
 * Everything here is pure: candles in, geometry out. No clock, no I/O, no
 * randomness. `lastTouchIndex` and friends are expressed as INDICES into the
 * supplied series rather than timestamps, so a caller replaying history and a
 * caller looking at a live window get identical answers from identical input.
 */

import { invariant } from '@/core/errors'
import { recencyWeight } from '@/core/prediction/probability'
import type { Candle } from '@/providers/types'
import { atr, bollingerBands } from './indicators'
import { percentileRank } from './volatility'

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

// ---------------------------------------------------------------------------
// Swing points
// ---------------------------------------------------------------------------

export interface SwingPoint {
  readonly index: number
  readonly price: number
  readonly type: 'high' | 'low'
}

/**
 * Fractal swing highs and lows.
 *
 * A bar is a swing high when its high strictly exceeds the highs of the
 * `lookback` bars on BOTH sides. Strict comparison on both sides is deliberate:
 * with `>=` a flat plateau of five identical highs registers five separate
 * "swings" and every downstream touch-count is inflated by the shape of the tick
 * grid rather than by market behaviour.
 *
 * The cost of the two-sided definition is that the most recent `lookback` bars
 * can never be swing points — the right-hand confirmation does not exist yet.
 * That lag is real information, not a defect: an unconfirmed extreme is exactly
 * the thing that keeps failing to hold, and pretending otherwise is how
 * repainting indicators are born.
 */
export function swingPoints(candles: readonly Candle[], lookback = 2): SwingPoint[] {
  invariant(Number.isInteger(lookback) && lookback > 0, 'swing lookback must be a positive integer')
  const out: SwingPoint[] = []
  const n = candles.length
  if (n < 2 * lookback + 1) return out

  for (let i = lookback; i < n - lookback; i++) {
    const c = candles[i]
    if (c === undefined) continue

    let isHigh = true
    let isLow = true
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue
      const other = candles[j]
      if (other === undefined) continue
      if (other.high >= c.high) isHigh = false
      if (other.low <= c.low) isLow = false
    }
    if (isHigh) out.push({ index: i, price: c.high, type: 'high' })
    if (isLow) out.push({ index: i, price: c.low, type: 'low' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Trend structure
// ---------------------------------------------------------------------------

export type StructurePattern = 'HH-HL' | 'LH-LL' | 'ranging' | 'transition'

export interface TrendStructure {
  readonly pattern: StructurePattern
  /** 0..1 — confidence in the classification, not the strength of the move. */
  readonly strength: number
  readonly lastSwingHigh: SwingPoint | null
  readonly lastSwingLow: SwingPoint | null
}

/**
 * Classify recent structure from the sequence of swings.
 *
 * An uptrend is not "price went up" — it is the pattern higher-high /
 * higher-low, i.e. buyers repeatedly stepping in above the previous demand.
 * That distinction matters because a violent rally that makes a higher high on a
 * LOWER low is a very different (and far less durable) thing than an orderly
 * staircase, and a price-only measure scores them the same.
 *
 * `strength` blends two independent pieces of evidence:
 *  - CONSISTENCY: what fraction of consecutive swing pairs agree with the label.
 *    Four rising highs in a row is stronger evidence than two.
 *  - DISPLACEMENT: how far the structure has actually travelled, as a fraction
 *    of price, saturating at 5%. A textbook HH-HL sequence spanning 0.2% of
 *    price is noise wearing a trend's clothes.
 *
 * They are blended rather than multiplied so that a perfectly consistent but
 * small move still scores meaningfully — the pattern is genuinely present, we
 * just do not want it to score 1.0.
 */
export function trendStructure(
  candles: readonly Candle[],
  lookback = 2,
  maxSwings = 4,
): TrendStructure {
  const swings = swingPoints(candles, lookback)
  const highs = swings.filter((s) => s.type === 'high').slice(-maxSwings)
  const lows = swings.filter((s) => s.type === 'low').slice(-maxSwings)

  const lastSwingHigh = highs.length > 0 ? (highs[highs.length - 1] ?? null) : null
  const lastSwingLow = lows.length > 0 ? (lows[lows.length - 1] ?? null) : null

  // Two of each is the minimum needed to speak of a "sequence" at all. Below
  // that we report ranging with zero confidence rather than guessing.
  if (highs.length < 2 || lows.length < 2) {
    return { pattern: 'ranging', strength: 0, lastSwingHigh, lastSwingLow }
  }

  const highUp = directionalFraction(highs, 'up')
  const highDown = 1 - highUp
  const lowUp = directionalFraction(lows, 'up')
  const lowDown = 1 - lowUp

  const upConsistency = (highUp + lowUp) / 2
  const downConsistency = (highDown + lowDown) / 2

  const reference = referencePrice(candles)
  const highSpan = relativeSpan(highs, reference)
  const lowSpan = relativeSpan(lows, reference)
  // Saturate displacement at 5% of price: beyond that the structure is
  // unambiguously a real move and extra distance adds no classification value.
  const displacement = clamp01(Math.max(highSpan, lowSpan) / 0.05)

  const CONSISTENCY_THRESHOLD = 0.75
  if (upConsistency >= CONSISTENCY_THRESHOLD) {
    return {
      pattern: 'HH-HL',
      strength: clamp01(0.6 * upConsistency + 0.4 * displacement),
      lastSwingHigh,
      lastSwingLow,
    }
  }
  if (downConsistency >= CONSISTENCY_THRESHOLD) {
    return {
      pattern: 'LH-LL',
      strength: clamp01(0.6 * downConsistency + 0.4 * displacement),
      lastSwingHigh,
      lastSwingLow,
    }
  }

  // No directional agreement. Two very different states share this bucket:
  // swings that are mixed AND tightly compressed (a range), and swings that are
  // mixed but wide (a trend changing hands). Displacement separates them.
  const RANGE_DISPLACEMENT = 0.4
  if (displacement < RANGE_DISPLACEMENT) {
    return {
      pattern: 'ranging',
      strength: clamp01(1 - displacement / RANGE_DISPLACEMENT),
      lastSwingHigh,
      lastSwingLow,
    }
  }
  return {
    pattern: 'transition',
    strength: clamp01(displacement),
    lastSwingHigh,
    lastSwingLow,
  }
}

/** Fraction of consecutive pairs moving in the requested direction. */
function directionalFraction(points: readonly SwingPoint[], direction: 'up' | 'down'): number {
  if (points.length < 2) return 0.5
  let agree = 0
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const cur = points[i]
    const prev = points[i - 1]
    if (cur === undefined || prev === undefined) continue
    total++
    if (direction === 'up' ? cur.price > prev.price : cur.price < prev.price) agree++
  }
  return total === 0 ? 0.5 : agree / total
}

/** |last − first| of a swing sequence, as a fraction of price. */
function relativeSpan(points: readonly SwingPoint[], reference: number): number {
  const first = points[0]
  const last = points[points.length - 1]
  if (first === undefined || last === undefined || reference <= 0) return 0
  return Math.abs(last.price - first.price) / reference
}

function referencePrice(candles: readonly Candle[]): number {
  const last = candles[candles.length - 1]
  return last === undefined || last.close <= 0 ? 1 : last.close
}

// ---------------------------------------------------------------------------
// Support and resistance
// ---------------------------------------------------------------------------

export interface PriceLevel {
  readonly price: number
  /** 0..1 — how much the evidence supports this being a real level. */
  readonly strength: number
  readonly type: 'support' | 'resistance'
  readonly touches: number
  readonly lastTouchIndex: number
}

export interface SupportResistanceOptions {
  /** Fractal lookback used to find the candidate swing points. */
  readonly swingLookback?: number
  /**
   * Cluster tolerance as a FRACTION of price (0.005 = 0.5%).
   *
   * Relative rather than absolute, and this is not a stylistic preference — an
   * absolute tolerance is meaningless across an asset universe. "$50" is the
   * entire trading range of a token priced at $0.15 and is less than one tick of
   * noise on BTC at $118,000. A single absolute tolerance therefore either
   * merges every level on cheap assets into one useless blob, or splits every
   * level on expensive assets into dozens of one-touch fragments. Percentage
   * distance is the only scale-free way to ask "are these the same level?", and
   * it also matches how the market actually behaves: participants reason in
   * percentages, and the noise band around a level scales with price.
   */
  readonly tolerancePct?: number
  readonly minTouches?: number
  readonly maxLevels?: number
}

/**
 * Cluster swing points into support/resistance levels and score them.
 *
 * Scoring blends three independent sources of evidence, because any one alone is
 * easy to fool:
 *  - TOUCHES: how often price actually turned here. Saturates quickly — the
 *    difference between 1 and 4 touches is enormous, between 8 and 11 is not.
 *  - RECENCY: a level defended three months ago and ignored since is a fact
 *    about a market that no longer exists. Exponential decay via the shared
 *    `recencyWeight` helper, with a half-life of a quarter of the window.
 *  - VOLUME: how much size actually traded THROUGH the level. Levels forged on
 *    real volume are remembered by real participants with real positions;
 *    levels drawn through a thin overnight session are remembered by nobody.
 */
export function supportResistance(
  candles: readonly Candle[],
  opts: SupportResistanceOptions = {},
): PriceLevel[] {
  const swingLookback = opts.swingLookback ?? 2
  const tolerancePct = opts.tolerancePct ?? 0.005
  const minTouches = opts.minTouches ?? 2
  const maxLevels = opts.maxLevels ?? 8
  invariant(tolerancePct > 0, 'tolerancePct must be positive')

  const n = candles.length
  if (n === 0) return []

  const swings = swingPoints(candles, swingLookback)
  if (swings.length === 0) return []

  const sorted = [...swings].sort((a, b) => a.price - b.price)

  // Greedy single-pass clustering over the price-sorted swings. A swing joins
  // the open cluster while it is within `tolerancePct` of that cluster's running
  // mean; otherwise the cluster closes and a new one opens.
  const clusters: SwingPoint[][] = []
  let current: SwingPoint[] = []
  let mean = 0

  for (const point of sorted) {
    if (current.length === 0) {
      current = [point]
      mean = point.price
      continue
    }
    const relativeDistance = mean === 0 ? Infinity : Math.abs(point.price - mean) / mean
    if (relativeDistance <= tolerancePct) {
      current.push(point)
      mean = current.reduce((acc, p) => acc + p.price, 0) / current.length
    } else {
      clusters.push(current)
      current = [point]
      mean = point.price
    }
  }
  if (current.length > 0) clusters.push(current)

  let totalVolume = 0
  for (const c of candles) totalVolume += c.volume

  const lastClose = referencePrice(candles)
  // Half-life of a quarter of the series: a level untouched for half the window
  // retains ~25% of its recency credit.
  const lambda = Math.LN2 / Math.max(1, n / 4)

  const levels: PriceLevel[] = []
  for (const cluster of clusters) {
    if (cluster.length < minTouches) continue
    const price = cluster.reduce((acc, p) => acc + p.price, 0) / cluster.length
    if (!Number.isFinite(price) || price <= 0) continue

    let lastTouchIndex = -1
    for (const p of cluster) if (p.index > lastTouchIndex) lastTouchIndex = p.index

    // Volume traded NEAR the level: any candle whose range overlaps a band of
    // ±tolerancePct around it. A band rather than exact containment, for the
    // same scale-free reason the clustering uses one — and because a candle that
    // traded to within a tick of the level plainly participated in forming it.
    const bandLow = price * (1 - tolerancePct)
    const bandHigh = price * (1 + tolerancePct)
    let volumeAt = 0
    for (const c of candles) {
      if (c.high >= bandLow && c.low <= bandHigh) volumeAt += c.volume
    }

    const touchScore = clamp01((cluster.length - 1) / 3)
    const recencyScore = recencyWeight(Math.max(0, n - 1 - lastTouchIndex), lambda)
    // 15% of all volume passing through one level is treated as saturated.
    const volumeScore = totalVolume === 0 ? 0 : clamp01(volumeAt / totalVolume / 0.15)

    levels.push({
      price,
      strength: clamp01(0.4 * touchScore + 0.3 * recencyScore + 0.3 * volumeScore),
      type: price < lastClose ? 'support' : 'resistance',
      touches: cluster.length,
      lastTouchIndex,
    })
  }

  return levels.sort((a, b) => b.strength - a.strength).slice(0, maxLevels)
}

// ---------------------------------------------------------------------------
// Fibonacci
// ---------------------------------------------------------------------------

export const FIB_RETRACEMENTS: readonly number[] = [0.236, 0.382, 0.5, 0.618, 0.786]
export const FIB_EXTENSIONS: readonly number[] = [1.272, 1.618]

export interface FibLevel {
  readonly ratio: number
  readonly price: number
  readonly kind: 'retracement' | 'extension'
}

/**
 * Fibonacci retracements and extensions of an impulse leg.
 *
 * `direction: 'up'` means the impulse ran low → high, so retracements sit BELOW
 * the high (potential support on the pullback) and extensions project ABOVE it.
 * `'down'` mirrors both. Getting this backwards is the usual bug, so both are
 * expressed from the same anchor: retracement = low + range·(1 − r) for an up
 * leg, extension = low + range·r, and the reflection for a down leg.
 *
 * No claim is made here that these ratios have predictive power on their own.
 * They are consumed as candidate levels that the support/resistance scorer and
 * the models can confirm or ignore — self-fulfilling levels still function as
 * levels when enough participants watch them, and that is the only mechanism
 * being relied on.
 */
export function fibonacciLevels(high: number, low: number, direction: 'up' | 'down'): FibLevel[] {
  invariant(Number.isFinite(high) && Number.isFinite(low), 'fibonacci anchors must be finite')
  invariant(high >= low, 'fibonacci high must be >= low')
  const range = high - low
  const out: FibLevel[] = []

  for (const r of FIB_RETRACEMENTS) {
    out.push({
      ratio: r,
      price: direction === 'up' ? high - range * r : low + range * r,
      kind: 'retracement',
    })
  }
  for (const r of FIB_EXTENSIONS) {
    out.push({
      ratio: r,
      price: direction === 'up' ? low + range * r : high - range * r,
      kind: 'extension',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Volume profile
// ---------------------------------------------------------------------------

export interface VolumeBin {
  readonly priceLow: number
  readonly priceHigh: number
  readonly volume: number
}

export interface VolumeProfile {
  readonly bins: readonly VolumeBin[]
  /** Midpoint of the highest-volume bin — the price the market agreed on most. */
  readonly pointOfControl: number
  readonly valueAreaHigh: number
  readonly valueAreaLow: number
  readonly totalVolume: number
}

/**
 * Volume-at-price histogram, plus point of control and the 70% value area.
 *
 * Each candle's volume is spread across the bins its high–low range OVERLAPS,
 * in proportion to the overlap. The cheaper alternative — dumping the whole
 * bar's volume into the bin containing its close — systematically concentrates
 * the profile at closing prices, which are an artefact of the candle interval
 * rather than of where trading occurred. On a 4h candle spanning 3% of price,
 * that is a large lie.
 *
 * It is still an approximation (uniform distribution within the bar), and it is
 * labelled as such: without tick data there is no way to know where inside the
 * bar the volume actually printed. Uniform is the maximum-entropy assumption —
 * the one that adds the least invented structure.
 *
 * The 70% value area follows the standard market-profile construction: start at
 * the point of control and repeatedly annex whichever adjacent bin holds more
 * volume until 70% of total volume is enclosed.
 */
export function volumeProfile(candles: readonly Candle[], binCount = 24): VolumeProfile {
  invariant(Number.isInteger(binCount) && binCount > 0, 'binCount must be a positive integer')

  const empty: VolumeProfile = {
    bins: [],
    pointOfControl: 0,
    valueAreaHigh: 0,
    valueAreaLow: 0,
    totalVolume: 0,
  }
  if (candles.length === 0) return empty

  let priceLow = Infinity
  let priceHigh = -Infinity
  let totalVolume = 0
  for (const c of candles) {
    if (c.low < priceLow) priceLow = c.low
    if (c.high > priceHigh) priceHigh = c.high
    totalVolume += c.volume
  }
  if (!Number.isFinite(priceLow) || !Number.isFinite(priceHigh)) return empty

  // A perfectly flat series has zero range; one degenerate bin is the honest
  // profile rather than a divide-by-zero.
  if (priceHigh === priceLow) {
    return {
      bins: [{ priceLow, priceHigh, volume: totalVolume }],
      pointOfControl: priceLow,
      valueAreaHigh: priceHigh,
      valueAreaLow: priceLow,
      totalVolume,
    }
  }

  const binWidth = (priceHigh - priceLow) / binCount
  const volumes = new Array<number>(binCount).fill(0)

  for (const c of candles) {
    if (c.volume === 0) continue
    const span = c.high - c.low
    if (span <= 0) {
      const idx = binIndexOf(c.close, priceLow, binWidth, binCount)
      volumes[idx] = (volumes[idx] ?? 0) + c.volume
      continue
    }
    const firstBin = binIndexOf(c.low, priceLow, binWidth, binCount)
    const lastBin = binIndexOf(c.high, priceLow, binWidth, binCount)
    for (let b = firstBin; b <= lastBin; b++) {
      const binLow = priceLow + b * binWidth
      const binHigh = binLow + binWidth
      const overlap = Math.min(c.high, binHigh) - Math.max(c.low, binLow)
      if (overlap <= 0) continue
      volumes[b] = (volumes[b] ?? 0) + c.volume * (overlap / span)
    }
  }

  const bins: VolumeBin[] = volumes.map((v, i) => ({
    priceLow: priceLow + i * binWidth,
    priceHigh: priceLow + (i + 1) * binWidth,
    volume: v,
  }))

  let pocIndex = 0
  for (let i = 1; i < volumes.length; i++) {
    if ((volumes[i] ?? 0) > (volumes[pocIndex] ?? 0)) pocIndex = i
  }

  // Expand outward from the POC, always taking the richer neighbour.
  const target = totalVolume * 0.7
  let lowIdx = pocIndex
  let highIdx = pocIndex
  let accumulated = volumes[pocIndex] ?? 0
  while (accumulated < target && (lowIdx > 0 || highIdx < binCount - 1)) {
    const below = lowIdx > 0 ? (volumes[lowIdx - 1] ?? 0) : -1
    const above = highIdx < binCount - 1 ? (volumes[highIdx + 1] ?? 0) : -1
    if (above >= below) {
      highIdx++
      accumulated += above
    } else {
      lowIdx--
      accumulated += below
    }
  }

  return {
    bins,
    pointOfControl: priceLow + (pocIndex + 0.5) * binWidth,
    valueAreaHigh: priceLow + (highIdx + 1) * binWidth,
    valueAreaLow: priceLow + lowIdx * binWidth,
    totalVolume,
  }
}

function binIndexOf(price: number, priceLow: number, binWidth: number, binCount: number): number {
  if (binWidth <= 0) return 0
  const raw = Math.floor((price - priceLow) / binWidth)
  if (raw < 0) return 0
  if (raw > binCount - 1) return binCount - 1
  return raw
}

// ---------------------------------------------------------------------------
// Breakouts
// ---------------------------------------------------------------------------

export type BreakoutType = 'breakout' | 'breakdown' | 'rejection' | 'none'

export interface BreakoutSignal {
  readonly type: BreakoutType
  readonly level: PriceLevel | null
  readonly confirmedByVolume: boolean
  /** 0..1 */
  readonly strength: number
}

export interface BreakoutOptions {
  /** How many prior bars must have stayed on the original side of the level. */
  readonly confirmBars?: number
  /** Volume multiple over the trailing average required for confirmation. */
  readonly volumeMultiple?: number
  /** Bars used for the trailing volume average. */
  readonly volumeWindow?: number
  /** Minimum penetration beyond the level, as a fraction of price. */
  readonly bufferPct?: number
  /** When true (default) an unconfirmed break is downgraded to 'none'. */
  readonly requireVolumeConfirmation?: boolean
}

/**
 * Classify the most recent bar against a set of levels.
 *
 * Two hard requirements, both learned the expensive way:
 *
 * 1. THE CLOSE MUST BE BEYOND THE LEVEL, NOT THE WICK. Wick-based detection
 *    ("high > resistance ⇒ breakout") fires on essentially every touch, because
 *    poking through a level and being rejected is the single most common thing
 *    price does at a level — that is what makes it a level. Worse, the failed
 *    probe is often a stop run in the OPPOSITE direction of the subsequent move,
 *    so wick detection is not merely noisy, it is anti-correlated with the
 *    outcome it claims to predict. A close beyond the level is the market
 *    holding the new price for a full period, which is a genuine (if weak)
 *    commitment. The `rejection` type exists precisely to capture the pierce-and-
 *    fail case as its own signal rather than mislabelling it as a break.
 *
 * 2. VOLUME MUST CONFIRM. A break on below-average volume is a break nobody
 *    participated in; it is most often drift through a thin book that reverses
 *    as soon as real size shows up. With `requireVolumeConfirmation` (the
 *    default) such a break is reported as `'none'` — but the tested `level` is
 *    still returned, so the caller can see WHICH level was probed rather than
 *    receiving an opaque negative.
 */
export function detectBreakout(
  candles: readonly Candle[],
  levels: readonly PriceLevel[],
  opts: BreakoutOptions = {},
): BreakoutSignal {
  const confirmBars = opts.confirmBars ?? 3
  const volumeMultiple = opts.volumeMultiple ?? 1.5
  const volumeWindow = opts.volumeWindow ?? 20
  const bufferPct = opts.bufferPct ?? 0.001
  const requireVolume = opts.requireVolumeConfirmation ?? true

  const none: BreakoutSignal = { type: 'none', level: null, confirmedByVolume: false, strength: 0 }
  const n = candles.length
  if (n < confirmBars + 2 || levels.length === 0) return none

  const last = candles[n - 1]
  if (last === undefined) return none

  // Trailing volume average EXCLUDING the bar under test — including it would
  // dilute exactly the spike we are trying to detect.
  let volSum = 0
  let volCount = 0
  for (let i = Math.max(0, n - 1 - volumeWindow); i < n - 1; i++) {
    const c = candles[i]
    if (c === undefined) continue
    volSum += c.volume
    volCount++
  }
  const avgVolume = volCount === 0 ? 0 : volSum / volCount
  const volumeRatio = avgVolume === 0 ? 0 : last.volume / avgVolume
  const confirmedByVolume = avgVolume > 0 && volumeRatio >= volumeMultiple

  // Penetration is measured in ATR units so that "meaningfully beyond the level"
  // means the same thing in a quiet market and a violent one.
  const atrSeries = atr(candles, Math.min(14, Math.max(2, Math.floor(n / 3))))
  const atrValue = atrSeries[n - 1] ?? null
  const penetrationScale = atrValue !== null && atrValue > 0 ? atrValue : last.close * 0.005

  let best: BreakoutSignal | null = null

  for (const level of levels) {
    const upper = level.price * (1 + bufferPct)
    const lower = level.price * (1 - bufferPct)

    const priorAllBelow = priorClosesAllBelow(candles, n - 1, confirmBars, level.price)
    const priorAllAbove = priorClosesAllAbove(candles, n - 1, confirmBars, level.price)

    let type: BreakoutType = 'none'
    if (priorAllBelow && last.close > upper) type = 'breakout'
    else if (priorAllAbove && last.close < lower) type = 'breakdown'
    else if (priorAllBelow && last.high > level.price && last.close <= level.price) type = 'rejection'
    else if (priorAllAbove && last.low < level.price && last.close >= level.price) type = 'rejection'
    if (type === 'none') continue

    const penetration =
      type === 'rejection'
        ? clamp01(Math.abs(last.high - level.price) / penetrationScale)
        : clamp01(Math.abs(last.close - level.price) / penetrationScale)
    const volumeScore = clamp01(volumeRatio / (volumeMultiple * 2))

    const strength = clamp01(
      0.35 * level.strength + 0.35 * volumeScore + 0.3 * penetration,
    )

    const candidate: BreakoutSignal = {
      type: requireVolume && !confirmedByVolume && type !== 'rejection' ? 'none' : type,
      level,
      confirmedByVolume,
      strength: requireVolume && !confirmedByVolume && type !== 'rejection' ? strength * 0.4 : strength,
    }
    if (best === null || candidate.strength > best.strength) best = candidate
  }

  return best ?? none
}

function priorClosesAllBelow(
  candles: readonly Candle[],
  endExclusive: number,
  count: number,
  level: number,
): boolean {
  let seen = 0
  for (let i = endExclusive - 1; i >= 0 && seen < count; i--, seen++) {
    const c = candles[i]
    if (c === undefined) return false
    if (c.close > level) return false
  }
  return seen === count
}

function priorClosesAllAbove(
  candles: readonly Candle[],
  endExclusive: number,
  count: number,
  level: number,
): boolean {
  let seen = 0
  for (let i = endExclusive - 1; i >= 0 && seen < count; i--, seen++) {
    const c = candles[i]
    if (c === undefined) return false
    if (c.close < level) return false
  }
  return seen === count
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

/**
 * How range-bound the last `window` bars are, 0..1.
 *
 * Two orthogonal views, averaged:
 *
 *  - PATH-TO-RANGE RATIO. Sum the per-bar true ranges and divide by the total
 *    high-to-low range of the window. In a clean trend the bars stack end to end
 *    and the ratio is near 1; in chop the same distance is walked repeatedly
 *    inside a narrow band and the ratio grows without bound. This is the
 *    directional-efficiency idea expressed in ATR units, and it is scale-free by
 *    construction. Saturated at 4× (mapped to 1.0).
 *
 *  - BANDWIDTH PERCENTILE. Where the current Bollinger bandwidth sits in its own
 *    history. This is what makes the score self-referential rather than
 *    absolute: 1.5% bandwidth is a coiled spring for BTC and a dead calm for a
 *    small-cap. A low percentile means the market is quiet BY ITS OWN standards,
 *    which is the only standard that predicts anything.
 *
 * Both are needed. The ratio alone cannot tell a tight coil from a wide, choppy
 * range; the percentile alone cannot tell a quiet drift from a quiet range.
 * Insufficient history returns 0 — "no evidence of consolidation" — rather than
 * throwing, matching the indicator layer's convention.
 */
export function consolidationScore(candles: readonly Candle[], window = 20): number {
  invariant(Number.isInteger(window) && window >= 2, 'consolidation window must be >= 2')
  const n = candles.length
  if (n < window + 2) return 0

  let pathLength = 0
  let hh = -Infinity
  let ll = Infinity
  for (let i = n - window; i < n; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    if (c === undefined || prev === undefined) continue
    pathLength += Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    )
    if (c.high > hh) hh = c.high
    if (c.low < ll) ll = c.low
  }

  const range = hh - ll
  // A literally flat window (range 0) is maximal consolidation by definition.
  const ratio = range <= 0 ? Infinity : pathLength / range
  const ratioScore = range <= 0 ? 1 : clamp01((ratio - 1) / 3)

  const bands = bollingerBands(candles.map((c) => c.close), window)
  const defined = bands.bandwidth.filter((v): v is number => v !== null)
  const current = defined[defined.length - 1]
  const bandwidthScore =
    current === undefined || defined.length < 3 ? ratioScore : 1 - percentileRank(defined, current)

  return clamp01(0.5 * ratioScore + 0.5 * bandwidthScore)
}
