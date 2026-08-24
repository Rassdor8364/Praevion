/**
 * Calibration.
 *
 * A system that says 70% should be right about 70% of the time. Raw ensemble
 * output is almost never calibrated out of the box — pooling tends to be
 * overconfident, and the failure is invisible unless you measure it. Everything
 * here exists so the claim on the performance page is auditable.
 */

import { clampProbability } from '../prediction/probability'

export interface CalibrationBin {
  readonly lower: number
  readonly upper: number
  readonly count: number
  /** Mean predicted probability inside the bin. */
  readonly meanPredicted: number
  /** Observed frequency of the event inside the bin. */
  readonly observedFrequency: number
}

export interface CalibrationReport {
  readonly bins: readonly CalibrationBin[]
  /** Expected Calibration Error — sample-weighted mean |predicted − observed|. */
  readonly ece: number
  /** Maximum Calibration Error — the worst bin. */
  readonly mce: number
  readonly sampleSize: number
}

export function calibrationReport(
  observations: readonly { probability: number; occurred: boolean }[],
  binCount = 10,
): CalibrationReport {
  const bins: CalibrationBin[] = []
  let ece = 0
  let mce = 0
  const n = observations.length

  for (let i = 0; i < binCount; i++) {
    const lower = i / binCount
    const upper = (i + 1) / binCount
    const inBin = observations.filter(
      (o) => o.probability >= lower && (i === binCount - 1 ? o.probability <= upper : o.probability < upper),
    )

    if (inBin.length === 0) {
      bins.push({ lower, upper, count: 0, meanPredicted: Number.NaN, observedFrequency: Number.NaN })
      continue
    }

    const meanPredicted = inBin.reduce((a, o) => a + o.probability, 0) / inBin.length
    const observedFrequency = inBin.filter((o) => o.occurred).length / inBin.length
    const gap = Math.abs(meanPredicted - observedFrequency)

    ece += (inBin.length / n) * gap
    if (gap > mce) mce = gap

    bins.push({ lower, upper, count: inBin.length, meanPredicted, observedFrequency })
  }

  return { bins, ece: n === 0 ? Number.NaN : ece, mce, sampleSize: n }
}

// ---------------------------------------------------------------------------
// Isotonic regression (pool-adjacent-violators)
// ---------------------------------------------------------------------------

export interface IsotonicCalibrator {
  readonly kind: 'isotonic'
  readonly x: readonly number[]
  readonly y: readonly number[]
  readonly sampleSize: number
}

/**
 * Fit a monotone non-decreasing mapping from predicted → observed probability.
 *
 * Isotonic is preferred over Platt scaling here because miscalibration in an
 * ensemble is usually not a clean sigmoid distortion — it is often
 * overconfidence at both tails with reasonable behaviour in the middle, a shape
 * Platt cannot express. The cost is that isotonic needs more data, so it is
 * only applied above MIN_CALIBRATION_SAMPLES; below that, predictions pass
 * through uncalibrated and the UI says so.
 */
export const MIN_CALIBRATION_SAMPLES = 500

export function fitIsotonic(
  observations: readonly { probability: number; occurred: boolean }[],
): IsotonicCalibrator {
  const sorted = [...observations].sort((a, b) => a.probability - b.probability)

  // Each observation starts as its own block.
  const values: number[] = sorted.map((o) => (o.occurred ? 1 : 0))
  const weights: number[] = sorted.map(() => 1)
  const positions: number[] = sorted.map((o) => o.probability)

  // Pool adjacent violators.
  let i = 0
  while (i < values.length - 1) {
    const vi = values[i] ?? 0
    const vNext = values[i + 1] ?? 0
    if (vi <= vNext) {
      i++
      continue
    }
    const wi = weights[i] ?? 0
    const wNext = weights[i + 1] ?? 0
    const pooledWeight = wi + wNext
    const pooledValue = (vi * wi + vNext * wNext) / pooledWeight
    const pooledPosition = ((positions[i] ?? 0) * wi + (positions[i + 1] ?? 0) * wNext) / pooledWeight

    values.splice(i, 2, pooledValue)
    weights.splice(i, 2, pooledWeight)
    positions.splice(i, 2, pooledPosition)

    if (i > 0) i--
  }

  return { kind: 'isotonic', x: positions, y: values, sampleSize: observations.length }
}

/** Apply a fitted calibrator, interpolating linearly between knots. */
export function applyIsotonic(cal: IsotonicCalibrator, probability: number): number {
  if (cal.x.length === 0) return probability
  const p = clampProbability(probability, 0)

  if (p <= (cal.x[0] ?? 0)) return clampProbability(cal.y[0] ?? p)
  const last = cal.x.length - 1
  if (p >= (cal.x[last] ?? 1)) return clampProbability(cal.y[last] ?? p)

  // Binary search for the bracketing knots.
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((cal.x[mid] ?? 0) <= p) lo = mid
    else hi = mid
  }

  const x0 = cal.x[lo] ?? 0
  const x1 = cal.x[hi] ?? 1
  const y0 = cal.y[lo] ?? 0
  const y1 = cal.y[hi] ?? 1
  const t = x1 === x0 ? 0 : (p - x0) / (x1 - x0)
  return clampProbability(y0 + t * (y1 - y0))
}

/**
 * Whether a calibrator should be trusted enough to apply. Below the sample
 * threshold the raw probability is used and the prediction is flagged
 * `uncalibrated` rather than silently passed through a bad mapping.
 */
export function isCalibratorUsable(cal: IsotonicCalibrator | null): cal is IsotonicCalibrator {
  return cal !== null && cal.sampleSize >= MIN_CALIBRATION_SAMPLES
}
