/**
 * Model-performance reads — the measurement half of the self-learning loop.
 *
 * Everything here is computed FROM SETTLED ROWS at read time rather than from
 * stored aggregates: the settled predictions and their per-model outputs are
 * the ground truth, and deriving metrics on read means the Model Lab can
 * never drift out of sync with the record it claims to summarise. If read
 * cost ever matters, the derivation moves into a materialised aggregation
 * job writing `model_metrics` — the shapes returned here are already the
 * shapes that table stores, so callers would not change.
 *
 * Only non-demo predictions count. Demo rows exist so the demo UI settles
 * properly, but an accuracy record with demo data in it is marketing, not
 * measurement — the exclusion happens here, at the aggregation boundary.
 */

import type { Result } from '@/core/result'
import { ok, err } from '@/core/result'
import type { Domain } from '@/core/prediction/types'

import { DB_UNAVAILABLE_MESSAGE, createServiceClient, type VixeraSupabaseClient } from '../client'
import type { OutcomeJson } from '../types'

export interface RepositoryOptions {
  readonly client?: VixeraSupabaseClient | null
}

function resolveClient(options?: RepositoryOptions): Result<VixeraSupabaseClient, Error> {
  const client = options?.client ?? createServiceClient()
  if (client === null) return err(new Error(DB_UNAVAILABLE_MESSAGE))
  return ok(client)
}

function toError(cause: unknown, context: string): Error {
  if (cause instanceof Error) return new Error(`${context}: ${cause.message}`, { cause })
  return new Error(`${context}: ${String(cause)}`)
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ModelScoreRow {
  readonly modelId: string
  readonly sampleSize: number
  /** Mean multiclass Brier over the scored predictions. */
  readonly brier: number
  /** Mean log loss. */
  readonly logLoss: number
  /** Fraction where the model's leading outcome occurred. */
  readonly accuracy: number
}

/** One (predicted probability, occurred) pair — calibration substrate. */
export interface CalibrationObservation {
  readonly probability: number
  readonly occurred: boolean
}

export interface ModelPerformanceSummary {
  /** Settled, non-demo predictions inspected (most recent first). */
  readonly totalSettled: number
  /** The pooled ensemble's own record, from the stored settlement scores. */
  readonly ensemble: ModelScoreRow | null
  /** Every participating individual model, scored from its own outputs. */
  readonly perModel: readonly ModelScoreRow[]
  /** One-vs-rest observations from the ensemble outcome vectors — feed to
   *  calibrationReport for the reliability curve. */
  readonly calibration: readonly CalibrationObservation[]
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** PostgREST `in()` filters travel in the URL; batches keep it bounded. */
const ID_BATCH = 100

async function fetchInBatches<T>(
  ids: readonly string[],
  fetchBatch: (batch: readonly string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<Result<T[], Error>> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const { data, error } = await fetchBatch(ids.slice(i, i + ID_BATCH))
    if (error !== null) return err(new Error(error.message))
    out.push(...(data ?? []))
  }
  return ok(out)
}

interface Accumulator {
  n: number
  brier: number
  logLoss: number
  correct: number
}

function newAccumulator(): Accumulator {
  return { n: 0, brier: 0, logLoss: 0, correct: 0 }
}

function scoreOutcomes(acc: Accumulator, outcomes: readonly OutcomeJson[], actualKey: string): void {
  const actual = outcomes.find((o) => o.key === actualKey)
  if (actual === undefined) return // never score against a key the model did not price
  let brier = 0
  let best: OutcomeJson | null = null
  for (const o of outcomes) {
    brier += (o.probability - (o.key === actualKey ? 1 : 0)) ** 2
    if (best === null || o.probability > best.probability) best = o
  }
  acc.n += 1
  acc.brier += brier
  acc.logLoss += -Math.log(Math.max(1e-12, actual.probability))
  if (best?.key === actualKey) acc.correct += 1
}

function toRow(modelId: string, acc: Accumulator): ModelScoreRow {
  return {
    modelId,
    sampleSize: acc.n,
    brier: acc.n === 0 ? Number.NaN : acc.brier / acc.n,
    logLoss: acc.n === 0 ? Number.NaN : acc.logLoss / acc.n,
    accuracy: acc.n === 0 ? Number.NaN : acc.correct / acc.n,
  }
}

// ---------------------------------------------------------------------------
// listResolvedPredictions — the prediction-history surface
// ---------------------------------------------------------------------------

export interface ResolvedPredictionRow {
  readonly id: string
  readonly subject: string
  readonly subjectLabel: string
  readonly generatedAt: string
  readonly modelVersion: string
  readonly confidence: number
  readonly outcomes: readonly OutcomeJson[]
  readonly actualKey: string
  readonly actualLabel: string | null
  readonly wasCorrect: boolean
  readonly brierScore: number | null
  readonly settledAt: string
  readonly evidence: Record<string, unknown>
}

/**
 * Settled predictions with their outcomes, newest first — the permanent
 * record the history page renders. The probabilities returned are the ones
 * persisted BEFORE kickoff; nothing here recomputes anything.
 */
export async function listResolvedPredictions(
  domain: Domain,
  options?: RepositoryOptions & { readonly limit?: number },
): Promise<Result<ResolvedPredictionRow[], Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200)

  try {
    const { data: predictions, error } = await client
      .from('predictions')
      .select('id, subject, subject_label, generated_at, model_version, confidence, outcomes')
      .eq('domain', domain)
      .neq('data_mode', 'demo')
      .not('outcome_id', 'is', null)
      .order('generated_at', { ascending: false })
      .limit(limit)

    if (error !== null) return err(toError(error, 'listResolvedPredictions'))
    const rows = predictions ?? []
    if (rows.length === 0) return ok([])

    const outcomesResult = await fetchInBatches(
      rows.map((r) => r.id),
      (batch) =>
        client
          .from('prediction_outcomes')
          .select('prediction_id, actual_key, actual_label, was_correct, brier_score, settled_at, evidence')
          .in('prediction_id', [...batch]),
    )
    if (!outcomesResult.ok) return err(toError(outcomesResult.error, 'listResolvedPredictions(outcomes)'))

    const byPrediction = new Map(outcomesResult.value.map((o) => [o.prediction_id, o]))
    const out: ResolvedPredictionRow[] = []
    for (const p of rows) {
      const outcome = byPrediction.get(p.id)
      if (outcome === undefined) continue
      out.push({
        id: p.id,
        subject: p.subject,
        subjectLabel: p.subject_label,
        generatedAt: p.generated_at,
        modelVersion: p.model_version,
        confidence: p.confidence,
        outcomes: p.outcomes,
        actualKey: outcome.actual_key,
        actualLabel: outcome.actual_label,
        wasCorrect: outcome.was_correct,
        brierScore: outcome.brier_score,
        settledAt: outcome.settled_at,
        evidence: (outcome.evidence ?? {}) as Record<string, unknown>,
      })
    }
    return ok(out)
  } catch (cause) {
    return err(toError(cause, 'listResolvedPredictions'))
  }
}

// ---------------------------------------------------------------------------
// getModelPerformance
// ---------------------------------------------------------------------------

export interface ModelPerformanceOptions extends RepositoryOptions {
  /** Most recent settled predictions to score. Bounded — the record grows
   *  forever and this read is request-path. */
  readonly limit?: number
}

const DEFAULT_PERFORMANCE_LIMIT = 500
const MAX_PERFORMANCE_LIMIT = 2000

export async function getModelPerformance(
  domain: Domain,
  options?: ModelPerformanceOptions,
): Promise<Result<ModelPerformanceSummary, Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  const limit = Math.min(Math.max(options?.limit ?? DEFAULT_PERFORMANCE_LIMIT, 1), MAX_PERFORMANCE_LIMIT)

  try {
    const { data: predictions, error: predictionsError } = await client
      .from('predictions')
      .select('id, outcomes')
      .eq('domain', domain)
      .neq('data_mode', 'demo')
      .not('outcome_id', 'is', null)
      .order('generated_at', { ascending: false })
      .limit(limit)

    if (predictionsError !== null) return err(toError(predictionsError, 'getModelPerformance(predictions)'))

    const rows = predictions ?? []
    if (rows.length === 0) {
      return ok({ totalSettled: 0, ensemble: null, perModel: [], calibration: [] })
    }

    const ids = rows.map((r) => r.id)

    const outcomesResult = await fetchInBatches(ids, (batch) =>
      client
        .from('prediction_outcomes')
        .select('prediction_id, actual_key')
        .in('prediction_id', [...batch]),
    )
    if (!outcomesResult.ok) return err(toError(outcomesResult.error, 'getModelPerformance(outcomes)'))

    const outputsResult = await fetchInBatches(ids, (batch) =>
      client
        .from('prediction_model_outputs')
        .select('prediction_id, model_id, outcomes, abstained')
        .in('prediction_id', [...batch]),
    )
    if (!outputsResult.ok) return err(toError(outputsResult.error, 'getModelPerformance(modelOutputs)'))

    const actualByPrediction = new Map<string, string>()
    for (const o of outcomesResult.value) actualByPrediction.set(o.prediction_id, o.actual_key)

    // Ensemble record + calibration substrate from the prediction rows.
    const ensembleAcc = newAccumulator()
    const calibration: CalibrationObservation[] = []
    for (const p of rows) {
      const actualKey = actualByPrediction.get(p.id)
      if (actualKey === undefined) continue
      const outcomes: OutcomeJson[] = p.outcomes
      scoreOutcomes(ensembleAcc, outcomes, actualKey)
      for (const o of outcomes) {
        calibration.push({ probability: o.probability, occurred: o.key === actualKey })
      }
    }

    // Per-model records from their own emitted distributions.
    const perModelAcc = new Map<string, Accumulator>()
    for (const output of outputsResult.value) {
      if (output.abstained) continue
      const actualKey = actualByPrediction.get(output.prediction_id)
      if (actualKey === undefined) continue
      let acc = perModelAcc.get(output.model_id)
      if (acc === undefined) {
        acc = newAccumulator()
        perModelAcc.set(output.model_id, acc)
      }
      scoreOutcomes(acc, output.outcomes, actualKey)
    }

    const perModel = [...perModelAcc.entries()]
      .map(([modelId, acc]) => toRow(modelId, acc))
      .sort((a, b) => a.brier - b.brier || a.modelId.localeCompare(b.modelId))

    return ok({
      totalSettled: ensembleAcc.n,
      ensemble: ensembleAcc.n > 0 ? toRow('ensemble', ensembleAcc) : null,
      perModel,
      calibration,
    })
  } catch (cause) {
    return err(toError(cause, 'getModelPerformance'))
  }
}
