/**
 * Weighted consensus with herding detection.
 *
 * ===========================================================================
 * TEN WALLETS COPYING ONE LEADER ARE ONE SIGNAL WEARING TEN HATS (§19)
 * ===========================================================================
 *
 * Naive consensus counts heads. But on-chain and social signals are cheap to
 * replicate: a copy-trading vault, a Telegram call, or a single whale split
 * across wallets produces ten "independent" data points that carry the
 * information content of one. Treating them as ten multiplies the apparent
 * evidence by ten — which is precisely how herds form and precisely the error
 * a consensus engine exists to avoid.
 *
 * The fix has two halves:
 *
 *  1. `independenceScore` looks at the raw signals and estimates how much of
 *     the flow is genuinely independent, from the observable fingerprints of
 *     copying: timestamp clustering (followers fire within seconds of the
 *     leader), identical sizing (copy engines mirror size), and single-side
 *     pile-ups (organic flow has some two-way traffic).
 *
 *  2. `weightedConsensus` pools probabilities in log-odds space (reusing the
 *     core primitives — see ensemble.ts for why log-odds pooling and not
 *     probability averaging) with each source's weight scaled by its
 *     independence, and reports an EFFECTIVE N that shrinks toward 1 as the
 *     pool collapses into a single correlated voice.
 *
 * Pure throughout.
 */

import { clampProbability, logit, normalize, sigmoid } from '@/core/prediction/probability'

// ---------------------------------------------------------------------------
// Consensus pooling
// ---------------------------------------------------------------------------

export interface ConsensusInput {
  readonly source: string
  /** The source's probability estimate, 0..1. */
  readonly probability: number
  /** Base weight (historical skill, stake size, reliability class...). */
  readonly weight: number
  /** 0..1 — how independent this source is from the rest of the pool. */
  readonly independence: number
}

export interface ConsensusResult {
  readonly probability: number
  /**
   * Effective number of independent sources. Inverse-Simpson diversity of the
   * base weights, scaled by weighted mean independence, floored at 1 when any
   * source is present: even a perfectly herded pool is still ONE signal.
   */
  readonly effectiveN: number
  /** 0..1 — fraction of the pool's raw weight destroyed by dependence. */
  readonly herdingDiscount: number
}

/** Inverse Simpson index of a set of non-negative weights: 1/Σŵᵢ². Equals n
 *  for n equal weights, approaches 1 as one weight dominates. */
function inverseSimpson(weights: readonly number[]): number {
  let sum = 0
  let sumSq = 0
  for (const w of weights) {
    sum += w
    sumSq += w * w
  }
  if (sum <= 0 || sumSq <= 0) return 0
  return (sum * sum) / sumSq
}

/**
 * Pool source probabilities into one, weighting each by weight × independence.
 *
 * Pooling is in log-odds space via the core primitives (logit/sigmoid): five
 * genuinely independent sources at 0.8 SHOULD pool above 0.8 — see the design
 * note in core/prediction/ensemble.ts. But that accumulation is exactly why
 * independence must gate the weights: log-odds pooling of ten copies of one
 * opinion would manufacture conviction out of an echo.
 *
 * Degenerate inputs degrade gracefully: an empty pool (or one whose weights
 * all sanitise to zero) returns the ignorance prior 0.5 with effectiveN 0.
 */
export function weightedConsensus(inputs: readonly ConsensusInput[]): ConsensusResult {
  // Sanitise at the boundary: non-finite or negative weights contribute
  // nothing; non-finite independence is treated as fully dependent (0) —
  // the conservative direction; probabilities clamp into [eps, 1−eps].
  const sane = inputs.map((s) => ({
    p: clampProbability(s.probability),
    w: Number.isFinite(s.weight) && s.weight > 0 ? s.weight : 0,
    ind: Number.isFinite(s.independence) ? Math.min(1, Math.max(0, s.independence)) : 0,
  }))

  const totalWeight = sane.reduce((acc, s) => acc + s.w, 0)
  if (totalWeight <= 0) {
    return { probability: 0.5, effectiveN: 0, herdingDiscount: 0 }
  }

  // Independence floor of 0.02 for the POOLING weights only: even a herd's
  // single underlying opinion is an opinion, and zeroing it entirely would
  // discard the probability along with the redundancy. The floor does not
  // apply to effectiveN, where redundancy is exactly what we are measuring.
  const combined = normalize(sane.map((s) => s.w * Math.max(0.02, s.ind)))

  let pooledLogit = 0
  sane.forEach((s, i) => {
    pooledLogit += (combined[i] ?? 0) * logit(s.p)
  })

  // How much raw weight survives the independence gate. 1 − this is the
  // herding discount: the share of the pool that was echo, not evidence.
  const meanIndependence = sane.reduce((acc, s) => acc + s.w * s.ind, 0) / totalWeight

  // Diversity of the BASE weights (how many voices there appear to be),
  // scaled by how independent those voices actually are.
  const apparentN = inverseSimpson(sane.map((s) => s.w))
  const effectiveN = Math.max(1, apparentN * meanIndependence)

  return {
    probability: sigmoid(pooledLogit),
    effectiveN,
    herdingDiscount: Math.min(1, Math.max(0, 1 - meanIndependence)),
  }
}

// ---------------------------------------------------------------------------
// Independence estimation
// ---------------------------------------------------------------------------

export interface RawSignal {
  readonly traderId: string
  /** Epoch milliseconds. */
  readonly ts: number
  readonly side: string
  readonly size: number
}

/** Timestamp bucket width for clustering detection. Copy-trading engines and
 *  call-group followers fire within seconds of the leader; one minute is wide
 *  enough to catch relayed copies, narrow enough that organic flow over hours
 *  spreads across many buckets. */
const CLUSTER_WINDOW_MS = 60_000

/** Group values, count occurrences, and return diversity as a 0..1 fraction:
 *  effective distinct groups (inverse Simpson) over total count. All-same → 1/n,
 *  all-distinct → 1. */
function diversityFraction(keys: readonly string[]): number {
  if (keys.length === 0) return 1
  const counts = new Map<string, number>()
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
  return inverseSimpson([...counts.values()]) / keys.length
}

/**
 * Estimate how independent a set of raw signals is, 0..1.
 *
 * Four fingerprints, combined as a weighted GEOMETRIC mean — geometric so
 * that a single smoking gun (all ten trades in the same minute) drags the
 * score down hard even when other fingerprints look clean, which is how real
 * copy-trading presents: distinct wallets, identical everything else.
 *
 *   timestamp clustering  exponent 0.50 — the strongest tell; independent
 *                         actors do not share a clock.
 *   identical sizing      exponent 0.25 — copy engines mirror size exactly;
 *                         humans round differently.
 *   trader concentration  exponent 0.15 — one id posting ten times is ten
 *                         signals from one mind by construction.
 *   single-side pile-up   exponent 0.10 — mildest, because genuinely big news
 *                         DOES produce one-sided organic flow; floored at
 *                         0.25 so it dampens rather than condemns.
 *
 * Fewer than two signals returns 1: dependence between signals is undefined
 * for a set of one, and penalising it would double-count the small-sample
 * penalty that effectiveN already applies.
 */
export function independenceScore(signals: readonly RawSignal[]): number {
  if (signals.length < 2) return 1

  // Non-finite timestamps/sizes are bucketed under a sentinel rather than
  // dropped: a feed emitting ten NaN timestamps is exhibiting exactly the
  // kind of homogeneity this function exists to punish.
  const tsFactor = diversityFraction(
    signals.map((s) => (Number.isFinite(s.ts) ? String(Math.floor(s.ts / CLUSTER_WINDOW_MS)) : 'invalid')),
  )
  const sizeFactor = diversityFraction(
    signals.map((s) => (Number.isFinite(s.size) ? s.size.toPrecision(6) : 'invalid')),
  )
  const traderFactor = diversityFraction(signals.map((s) => s.traderId))

  let buys = 0
  let sells = 0
  for (const s of signals) {
    if (s.side === 'buy') buys += 1
    else if (s.side === 'sell') sells += 1
  }
  const sided = buys + sells
  const imbalance = sided > 0 ? Math.abs(buys - sells) / sided : 0
  const sideFactor = Math.max(0.25, 1 - imbalance * imbalance)

  const score =
    Math.pow(tsFactor, 0.5) *
    Math.pow(sizeFactor, 0.25) *
    Math.pow(traderFactor, 0.15) *
    Math.pow(sideFactor, 0.1)

  return Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0))
}
