/**
 * The PredictionModel contract.
 *
 * Every quantitative model in the system — technical, momentum, structure,
 * order-flow, sentiment, macro, Elo, Dixon–Coles — implements this shape. The
 * contract is deliberately narrow:
 *
 *  - `run` is PURE and synchronous. All I/O happens upstream in the feature
 *    builder; a model receives a frozen snapshot of features and cannot reach
 *    for more. This is what makes point-in-time backtesting sound.
 *  - A model that lacks its inputs ABSTAINS. It does not emit 50%.
 *  - The interface is transport-agnostic: a future Python-hosted model slots in
 *    behind an async adapter that satisfies the same output type, and the
 *    orchestrator never knows.
 */

import type { ModelOutput, Outcome, PredictionFactor } from '@/core/prediction/types'

export interface ModelContext {
  /** Epoch ms of the evaluation instant — injected, never Date.now(). */
  readonly nowMs: number
  /** Identifier of the run for tracing. */
  readonly runId: string
}

export interface PredictionModel<F> {
  readonly id: string
  readonly version: string
  /** Outcome keys this model emits, in order. */
  readonly outcomeKeys: readonly string[]
  run(features: F, ctx: ModelContext): ModelOutput
}

/** Convenience constructor for an abstention. */
export function abstain(
  modelId: string,
  version: string,
  outcomeKeys: readonly string[],
  reason: string,
): ModelOutput {
  return {
    modelId,
    modelVersion: version,
    abstained: true,
    abstainReason: reason,
    outcomes: outcomeKeys.map((key) => ({ key, label: key, probability: Number.NaN })),
    confidence: 0,
    weight: 0,
    featureContributions: [],
  }
}

/** Convenience constructor for a live output. */
export function emit(params: {
  modelId: string
  version: string
  outcomes: readonly Outcome[]
  confidence: number
  factors?: readonly PredictionFactor[]
}): ModelOutput {
  return {
    modelId: params.modelId,
    modelVersion: params.version,
    abstained: false,
    abstainReason: null,
    outcomes: params.outcomes,
    confidence: params.confidence,
    // Weight is assigned by the combiner from historical skill; a model never
    // sets its own weight.
    weight: 1,
    featureContributions: params.factors ?? [],
  }
}
