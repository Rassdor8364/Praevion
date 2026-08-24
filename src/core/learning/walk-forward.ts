/**
 * Walk-forward validation — the only honest way to evaluate a sports model.
 *
 * A random train/test shuffle across time lets a model train on March to
 * predict January, and information genuinely flows backwards through such a
 * split (league strength, team identity, even rule changes). Walk-forward
 * evaluation replays history the way live operation experiences it: train on
 * everything before a cut point, predict the window after it, roll the cut
 * forward, repeat. Every validation prediction is made by a model that has
 * never seen its own future — the same contract the live system operates
 * under, which is what makes the resulting metrics transferable.
 *
 * Generic over the sample type: the harness orders by timestamp and slices;
 * training and prediction are injected. Pure — determinism is inherited from
 * the injected trainer.
 */

import { invariant } from '../errors'

export interface ChronologicalSample {
  /** Epoch ms the sample became observable (kickoff for a match). */
  readonly timestamp: number
  /** Index of the class that actually occurred. */
  readonly label: number
}

export interface WalkForwardConfig {
  /** Minimum samples in the first training window. */
  readonly minTrainSize: number
  /** Validation window size per fold. */
  readonly validationSize: number
  /** Cap on folds (earliest are dropped first); unlimited when omitted. */
  readonly maxFolds?: number
}

export interface FoldResult {
  readonly trainSize: number
  readonly validationSize: number
  /** Epoch ms bounds of the validation window. */
  readonly from: number
  readonly to: number
  readonly brier: number
  readonly logLoss: number
  readonly accuracy: number
}

export interface WalkForwardResult {
  readonly folds: readonly FoldResult[]
  /** Sample-weighted aggregates over all validation predictions. */
  readonly totalValidated: number
  readonly brier: number
  readonly logLoss: number
  readonly accuracy: number
}

/**
 * Run walk-forward validation.
 *
 * `train` receives the chronological prefix; the returned `predict` maps a
 * held-out sample to a class-probability vector. The harness never hands
 * `predict` a sample from inside its own training window — that invariant IS
 * the leakage guard, so it is asserted, not assumed.
 */
export function walkForwardValidate<S extends ChronologicalSample>(
  samples: readonly S[],
  config: WalkForwardConfig,
  train: (trainingSlice: readonly S[]) => (sample: S) => readonly number[],
): WalkForwardResult {
  invariant(config.minTrainSize > 0, 'minTrainSize must be positive')
  invariant(config.validationSize > 0, 'validationSize must be positive')

  const ordered = [...samples].sort((a, b) => a.timestamp - b.timestamp)
  const folds: FoldResult[] = []

  let totalBrier = 0
  let totalLogLoss = 0
  let totalCorrect = 0
  let totalValidated = 0

  for (
    let cut = config.minTrainSize;
    cut + 1 <= ordered.length;
    cut += config.validationSize
  ) {
    const trainSlice = ordered.slice(0, cut)
    const validationSlice = ordered.slice(cut, cut + config.validationSize)
    if (validationSlice.length === 0) break

    const lastTrain = trainSlice[trainSlice.length - 1]
    const firstValidation = validationSlice[0]
    invariant(
      lastTrain !== undefined &&
        firstValidation !== undefined &&
        lastTrain.timestamp <= firstValidation.timestamp,
      'walk-forward slices are not chronological — leakage guard tripped',
    )

    const predict = train(trainSlice)

    let brier = 0
    let logLoss = 0
    let correct = 0
    for (const sample of validationSlice) {
      const probs = predict(sample)
      invariant(
        Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-6,
        'predicted class probabilities must sum to 1',
      )
      let best = 0
      let bestIdx = -1
      probs.forEach((p, k) => {
        const actual = k === sample.label ? 1 : 0
        brier += (p - actual) ** 2
        if (p > best) {
          best = p
          bestIdx = k
        }
      })
      logLoss -= Math.log(Math.max(1e-12, probs[sample.label] ?? 0))
      if (bestIdx === sample.label) correct += 1
    }

    folds.push({
      trainSize: trainSlice.length,
      validationSize: validationSlice.length,
      from: firstValidation.timestamp,
      to: validationSlice[validationSlice.length - 1]?.timestamp ?? firstValidation.timestamp,
      brier: brier / validationSlice.length,
      logLoss: logLoss / validationSlice.length,
      accuracy: correct / validationSlice.length,
    })

    totalBrier += brier
    totalLogLoss += logLoss
    totalCorrect += correct
    totalValidated += validationSlice.length
  }

  // Enforce maxFolds by dropping the EARLIEST folds: the recent regime is the
  // one live operation faces, so when a cap forces a choice, recency wins.
  const kept =
    config.maxFolds !== undefined && folds.length > config.maxFolds
      ? folds.slice(folds.length - config.maxFolds)
      : folds

  if (config.maxFolds !== undefined && kept.length < folds.length) {
    totalBrier = 0
    totalLogLoss = 0
    totalCorrect = 0
    totalValidated = 0
    for (const f of kept) {
      totalBrier += f.brier * f.validationSize
      totalLogLoss += f.logLoss * f.validationSize
      totalCorrect += f.accuracy * f.validationSize
      totalValidated += f.validationSize
    }
  }

  return {
    folds: kept,
    totalValidated,
    brier: totalValidated === 0 ? Number.NaN : totalBrier / totalValidated,
    logLoss: totalValidated === 0 ? Number.NaN : totalLogLoss / totalValidated,
    accuracy: totalValidated === 0 ? Number.NaN : totalCorrect / totalValidated,
  }
}
