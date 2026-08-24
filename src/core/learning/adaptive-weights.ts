/**
 * Adaptive ensemble weights — measured performance becomes pool influence.
 *
 * This is the closing arc of the self-learning loop: settled predictions are
 * scored per model (repositories/model-performance), the scores arrive here,
 * and what leaves is a weight multiplier per modelId that the ensemble
 * applies via MatchPredictionConfig.modelWeights. A model that has measurably
 * out-forecast the pool earns influence; one that has lagged loses it.
 *
 * Every stability constraint the product brief demands is enforced HERE, in
 * one place, rather than scattered as judgement calls:
 *
 *  - MINIMUM SAMPLE: below `minSample` settled predictions a model's record
 *    is noise, and its weight is exactly neutral (1.0) — a lucky 10-game
 *    streak buys nothing.
 *  - SHRINKAGE: observed skill is shrunk toward zero by sample size
 *    (n / (n + priorWeight)), so influence is earned gradually. At n = 50
 *    with the default prior a model keeps half its observed skill.
 *  - HARD CAPS: the final multiplier is clamped into [minWeight, maxWeight].
 *    No record, however long, lets one model drown out the pool — diversity
 *    is itself protective, and the caps preserve it.
 *
 * The skill measure is the Brier skill score against the UNIFORM baseline
 * over the market's outcomes (for 1X2: 2/3). Uniform, not base-rate, because
 * per-league base rates are themselves estimates with error; the uniform
 * baseline is parameter-free and identical for every model being compared,
 * which is all a RELATIVE weighting needs.
 *
 * Pure module: no clock, no I/O, no randomness.
 */

import { invariant } from '../errors'

export interface ModelPerformanceRecord {
  readonly modelId: string
  /** Settled, scored predictions backing this record. */
  readonly sampleSize: number
  /** Mean multiclass Brier over those predictions. */
  readonly brier: number
  /** Mean log loss (reported for the UI; the weight uses Brier). */
  readonly logLoss: number
}

export interface AdaptiveWeightsConfig {
  /** Below this sample size a model stays at neutral weight. */
  readonly minSample?: number
  /** Shrinkage prior: samples needed to keep half the observed skill. */
  readonly priorWeight?: number
  /** Hard clamp on the final multiplier. */
  readonly minWeight?: number
  readonly maxWeight?: number
  /** Brier of the uniform forecast for this market (3-class 1X2: 2/3). */
  readonly baselineBrier?: number
  /** Skill→weight slope: weight = 1 + slope·shrunkSkill before clamping. */
  readonly slope?: number
}

export interface ModelWeightRationale {
  readonly modelId: string
  readonly sampleSize: number
  readonly brier: number
  readonly logLoss: number
  /** 1 − brier/baseline, before shrinkage. */
  readonly skill: number
  readonly shrunkSkill: number
  readonly weight: number
  /** True when the minimum-sample gate held the weight at neutral. */
  readonly gated: boolean
}

export interface AdaptiveWeightsResult {
  /** modelId → multiplier, ready for MatchPredictionConfig.modelWeights. */
  readonly weights: Readonly<Record<string, number>>
  /** Full audit trail — the Model Lab renders this, not the bare weights. */
  readonly rationale: readonly ModelWeightRationale[]
}

export const DEFAULT_MIN_SAMPLE = 30
export const DEFAULT_PRIOR_WEIGHT = 50
export const DEFAULT_MIN_WEIGHT = 0.4
export const DEFAULT_MAX_WEIGHT = 1.6
/** Uniform three-outcome Brier: (2/3)² + 2·(1/3)² = 2/3. */
export const UNIFORM_1X2_BRIER = 2 / 3
const DEFAULT_SLOPE = 2.5

export function computeAdaptiveWeights(
  records: readonly ModelPerformanceRecord[],
  config: AdaptiveWeightsConfig = {},
): AdaptiveWeightsResult {
  const minSample = config.minSample ?? DEFAULT_MIN_SAMPLE
  const priorWeight = config.priorWeight ?? DEFAULT_PRIOR_WEIGHT
  const minWeight = config.minWeight ?? DEFAULT_MIN_WEIGHT
  const maxWeight = config.maxWeight ?? DEFAULT_MAX_WEIGHT
  const baseline = config.baselineBrier ?? UNIFORM_1X2_BRIER
  const slope = config.slope ?? DEFAULT_SLOPE

  invariant(baseline > 0, 'baseline Brier must be positive')
  invariant(minWeight > 0 && maxWeight >= minWeight, 'weight clamp must satisfy 0 < min <= max')
  invariant(minSample >= 0 && priorWeight > 0, 'sample thresholds must be non-negative')

  const weights: Record<string, number> = {}
  const rationale: ModelWeightRationale[] = []

  for (const r of records) {
    invariant(r.sampleSize >= 0, `sampleSize must be non-negative for ${r.modelId}`)

    const gated = r.sampleSize < minSample || !Number.isFinite(r.brier)
    const skill = gated ? 0 : 1 - r.brier / baseline
    const shrunkSkill = gated ? 0 : skill * (r.sampleSize / (r.sampleSize + priorWeight))
    const weight = gated
      ? 1
      : Math.min(maxWeight, Math.max(minWeight, 1 + slope * shrunkSkill))

    weights[r.modelId] = weight
    rationale.push({
      modelId: r.modelId,
      sampleSize: r.sampleSize,
      brier: r.brier,
      logLoss: r.logLoss,
      skill,
      shrunkSkill,
      weight,
      gated,
    })
  }

  return { weights, rationale }
}
