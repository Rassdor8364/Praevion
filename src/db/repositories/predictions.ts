/**
 * Prediction repository.
 *
 * ============================================================================
 * PREDICTIONS ARE APPEND-ONLY.
 *
 * A prediction row is written once and never rewritten. `settleOutcome` records
 * what actually happened in a SEPARATE row (`prediction_outcomes`) and links to
 * it; it does not touch a single probability, confidence value or factor of the
 * original. There is no function in this file that deletes a prediction, and
 * there is deliberately no `updatePrediction`.
 *
 * The reason is the whole point of the product. An accuracy record computed
 * over predictions that can be amended after the result is known is not an
 * accuracy record — it is a marketing asset. Failed predictions have to survive
 * intact, in their original form, or the calibration curve on the performance
 * page is a fabrication. If a model changes, it gets a new `model_version` and
 * writes new rows alongside the old ones.
 * ============================================================================
 *
 * Every function returns `Result<T, Error>` and never throws. A database being
 * unavailable is a routine condition the caller has to reason about (it forces
 * a degraded UI state), not an exception that should unwind into a 500.
 */

import type { Result } from '@/core/result'
import { ok, err } from '@/core/result'
import type {
  DataMode,
  Domain,
  ModelOutput,
  Outcome,
  PredictionFactor,
  Scenario,
  SourceRef,
  Timeframe,
  VixeraPrediction,
  VolatilityForecast,
} from '@/core/prediction/types'
import { clampProbability } from '@/core/prediction/probability'

import {
  createServiceClient,
  DB_UNAVAILABLE_MESSAGE,
  type VixeraSupabaseClient,
} from '../client'
import {
  PLATFORM_ORG_ID,
  type OutcomeJson,
  type PredictionFactorInsert,
  type PredictionHistoryInsert,
  type PredictionModelOutputInsert,
  type PredictionOutcomeRow,
  type PredictionRow,
  type PredictionSourceInsert,
  type ScenarioJson,
  type VixeraEventType,
  type VolatilityJson,
} from '../types'

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

export interface RepositoryOptions {
  /**
   * Client to use. Defaults to the service-role client, which bypasses RLS —
   * correct for the ingestion/prediction jobs that own this table. Pass a
   * request-scoped server client to read as the signed-in user instead.
   */
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
// Mapping
// ---------------------------------------------------------------------------

function leadingOf(outcomes: readonly Outcome[]): Outcome | null {
  let best: Outcome | null = null
  for (const o of outcomes) {
    if (best === null || o.probability > best.probability) best = o
  }
  return best
}

/** The child rows that hang off one prediction. */
interface PredictionChildren {
  readonly factors: PredictionFactorInsert[]
  readonly modelOutputs: PredictionModelOutputInsert[]
  readonly sources: PredictionSourceInsert[]
}

function buildChildren(predictionId: string, p: VixeraPrediction): PredictionChildren {
  const factors: PredictionFactorInsert[] = []

  p.supportingFactors.forEach((f, index) => {
    factors.push({
      prediction_id: predictionId,
      factor_id: f.id,
      label: f.label,
      polarity: 'supporting',
      contribution: f.contribution,
      detail: f.detail,
      evidence_strength: f.evidenceStrength,
      position: index,
    })
  })

  p.opposingFactors.forEach((f, index) => {
    factors.push({
      prediction_id: predictionId,
      factor_id: f.id,
      label: f.label,
      polarity: 'opposing',
      contribution: f.contribution,
      detail: f.detail,
      evidence_strength: f.evidenceStrength,
      position: index,
    })
  })

  const modelOutputs: PredictionModelOutputInsert[] = p.modelOutputs.map((m) => ({
    prediction_id: predictionId,
    model_id: m.modelId,
    model_version: m.modelVersion,
    abstained: m.abstained,
    // The CHECK constraint pairs these two: a reason without an abstention (or
    // an abstention without a reason) is rejected. Normalise here so a sloppy
    // engine produces a correct row rather than a 400 from PostgREST.
    abstain_reason: m.abstained ? (m.abstainReason ?? 'unspecified') : null,
    outcomes: m.outcomes.map(toOutcomeJson),
    confidence: m.confidence,
    // The same constraint requires an abstaining model to carry zero weight:
    // an abstention removes the model from the pool, it is not a neutral vote.
    weight: m.abstained ? 0 : m.weight,
    feature_contributions: m.featureContributions.map((f) => ({
      id: f.id,
      label: f.label,
      contribution: f.contribution,
      detail: f.detail,
      evidenceStrength: f.evidenceStrength,
    })),
  }))

  const sources: PredictionSourceInsert[] = p.sources.map((s) => ({
    prediction_id: predictionId,
    provider_id: s.providerId,
    capability: s.capability,
    reliability: s.reliability,
    fetched_at: s.fetchedAt,
    data_as_of: s.dataAsOf,
    is_demo: s.isDemo,
  }))

  return { factors, modelOutputs, sources }
}

function toOutcomeJson(o: Outcome): OutcomeJson {
  return { key: o.key, label: o.label, probability: o.probability }
}

/** Rebuild a VixeraPrediction from its row plus its child rows. */
function rowToPrediction(
  row: PredictionRow,
  factors: readonly {
    factor_id: string
    label: string
    polarity: 'supporting' | 'opposing'
    contribution: number | null
    detail: string | null
    evidence_strength: number
  }[],
  modelOutputs: readonly {
    model_id: string
    model_version: string
    abstained: boolean
    abstain_reason: string | null
    outcomes: OutcomeJson[]
    confidence: number
    weight: number
    feature_contributions: unknown
  }[],
  sources: readonly {
    provider_id: string
    capability: string
    reliability: SourceRef['reliability']
    fetched_at: string
    data_as_of: string
    is_demo: boolean
  }[],
): VixeraPrediction {
  const supporting: PredictionFactor[] = []
  const opposing: PredictionFactor[] = []
  for (const f of factors) {
    const factor: PredictionFactor = {
      id: f.factor_id,
      label: f.label,
      contribution: f.contribution,
      detail: f.detail,
      evidenceStrength: f.evidence_strength,
    }
    if (f.polarity === 'supporting') supporting.push(factor)
    else opposing.push(factor)
  }

  const outputs: ModelOutput[] = modelOutputs.map((m) => ({
    modelId: m.model_id,
    modelVersion: m.model_version,
    abstained: m.abstained,
    abstainReason: m.abstain_reason,
    outcomes: m.outcomes,
    confidence: m.confidence,
    weight: m.weight,
    featureContributions: (m.feature_contributions as PredictionFactor[] | null) ?? [],
  }))

  return {
    id: row.id,
    domain: row.domain,
    subject: row.subject,
    subjectLabel: row.subject_label,
    timeframe: row.timeframe,
    outcomes: row.outcomes,
    confidence: row.confidence,
    dataQuality: row.data_quality,
    modelAgreement: row.model_agreement,
    riskLevel: row.risk_level,
    supportingFactors: supporting,
    opposingFactors: opposing,
    modelOutputs: outputs,
    scenarios: (row.scenarios as Scenario[] | null) ?? null,
    volatility: (row.volatility as VolatilityForecast | null) ?? null,
    sources: sources.map((s) => ({
      providerId: s.provider_id,
      capability: s.capability,
      reliability: s.reliability,
      fetchedAt: s.fetched_at,
      dataAsOf: s.data_as_of,
      isDemo: s.is_demo,
    })),
    dataMode: row.data_mode,
    generatedAt: row.generated_at,
    dataTimestamp: row.data_timestamp,
    modelVersion: row.model_version,
    disclaimer: row.disclaimer,
  }
}

// ---------------------------------------------------------------------------
// savePrediction
// ---------------------------------------------------------------------------

export interface SavePredictionOptions extends RepositoryOptions {
  /** Owning organisation. Defaults to the platform org for scheduled runs. */
  readonly orgId?: string
  readonly predictionRunId?: string | null
}

/**
 * Persist a prediction and its children.
 *
 * Idempotent: the write is an upsert on the natural key
 * `(domain, subject, timeframe, model_version, generated_at)`, so a retried or
 * double-fired job converges instead of duplicating. Children are upserted on
 * their own natural keys for the same reason.
 *
 * The upsert does not weaken the append-only guarantee. The conflict target
 * pins the exact model version AND the exact generation instant, and the
 * engines are pure and deterministic, so the only row an upsert can ever
 * overwrite is one produced from identical inputs by identical code — a retry,
 * not a revision. A genuinely new opinion has a later `generated_at` (or a new
 * `model_version`) and therefore lands as a new row alongside the old one.
 * `outcome_id` is never in the payload, so a settled prediction cannot be
 * un-settled by a re-run.
 *
 * Honest caveat: PostgREST gives us no cross-table transaction, so a failure
 * between the parent insert and the child inserts can leave a prediction with
 * partial children. The natural keys make a retry converge, and the settlement
 * and display paths both tolerate empty child sets. If this ever needs to be
 * atomic, it becomes a single `rpc('save_prediction', ...)` SQL function —
 * the call site does not change.
 */
export async function savePrediction(
  p: VixeraPrediction,
  options?: SavePredictionOptions,
): Promise<Result<PredictionRow, Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  const leading = leadingOf(p.outcomes)
  if (leading === null) {
    return err(new Error('savePrediction: prediction has no outcomes'))
  }

  try {
    const { data, error } = await client
      .from('predictions')
      .upsert(
        {
          org_id: options?.orgId ?? PLATFORM_ORG_ID,
          prediction_run_id: options?.predictionRunId ?? null,
          domain: p.domain,
          subject: p.subject,
          subject_label: p.subjectLabel,
          timeframe: p.timeframe,
          outcomes: p.outcomes.map(toOutcomeJson),
          leading_outcome_key: leading.key,
          leading_probability: leading.probability,
          confidence: p.confidence,
          data_quality: p.dataQuality,
          model_agreement: p.modelAgreement,
          risk_level: p.riskLevel,
          scenarios: p.scenarios === null ? null : (p.scenarios as ScenarioJson[]),
          volatility: p.volatility === null ? null : (p.volatility as VolatilityJson),
          data_mode: p.dataMode,
          generated_at: p.generatedAt,
          data_timestamp: p.dataTimestamp,
          model_version: p.modelVersion,
          disclaimer: p.disclaimer,
        },
        { onConflict: 'domain,subject,timeframe,model_version,generated_at' },
      )
      .select('*')
      .single()

    if (error !== null) return err(toError(error, 'savePrediction'))
    if (data === null) return err(new Error('savePrediction: insert returned no row'))

    const row: PredictionRow = data
    const children = buildChildren(row.id, p)

    if (children.factors.length > 0) {
      const { error: factorError } = await client
        .from('prediction_factors')
        .upsert(children.factors, { onConflict: 'prediction_id,polarity,factor_id' })
      if (factorError !== null) return err(toError(factorError, 'savePrediction(factors)'))
    }

    if (children.modelOutputs.length > 0) {
      const { error: outputError } = await client
        .from('prediction_model_outputs')
        .upsert(children.modelOutputs, { onConflict: 'prediction_id,model_id,model_version' })
      if (outputError !== null) return err(toError(outputError, 'savePrediction(modelOutputs)'))
    }

    if (children.sources.length > 0) {
      const { error: sourceError } = await client
        .from('prediction_sources')
        .upsert(children.sources, { onConflict: 'prediction_id,provider_id,capability' })
      if (sourceError !== null) return err(toError(sourceError, 'savePrediction(sources)'))
    }

    return ok(row)
  } catch (cause) {
    return err(toError(cause, 'savePrediction'))
  }
}

// ---------------------------------------------------------------------------
// getLatestPrediction
// ---------------------------------------------------------------------------

/**
 * The most recent prediction for a subject/timeframe, fully hydrated.
 *
 * Returns `ok(null)` — not an error — when nothing has been generated yet. "No
 * prediction" is a legitimate state the UI renders as an empty state; it is not
 * a failure.
 */
export async function getLatestPrediction(
  domain: Domain,
  subject: string,
  timeframe: Timeframe,
  options?: RepositoryOptions,
): Promise<Result<VixeraPrediction | null, Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  try {
    const { data, error } = await client
      .from('predictions')
      .select('*')
      .eq('domain', domain)
      .eq('subject', subject)
      .eq('timeframe', timeframe)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error !== null) return err(toError(error, 'getLatestPrediction'))
    if (data === null) return ok(null)

    const row: PredictionRow = data

    const [factorsResponse, outputsResponse, sourcesResponse] = await Promise.all([
      client
        .from('prediction_factors')
        .select('factor_id,label,polarity,contribution,detail,evidence_strength')
        .eq('prediction_id', row.id)
        .order('position', { ascending: true }),
      client
        .from('prediction_model_outputs')
        .select(
          'model_id,model_version,abstained,abstain_reason,outcomes,confidence,weight,feature_contributions',
        )
        .eq('prediction_id', row.id),
      client
        .from('prediction_sources')
        .select('provider_id,capability,reliability,fetched_at,data_as_of,is_demo')
        .eq('prediction_id', row.id),
    ])

    if (factorsResponse.error !== null) {
      return err(toError(factorsResponse.error, 'getLatestPrediction(factors)'))
    }
    if (outputsResponse.error !== null) {
      return err(toError(outputsResponse.error, 'getLatestPrediction(modelOutputs)'))
    }
    if (sourcesResponse.error !== null) {
      return err(toError(sourcesResponse.error, 'getLatestPrediction(sources)'))
    }

    return ok(
      rowToPrediction(
        row,
        factorsResponse.data ?? [],
        outputsResponse.data ?? [],
        sourcesResponse.data ?? [],
      ),
    )
  } catch (cause) {
    return err(toError(cause, 'getLatestPrediction'))
  }
}

// ---------------------------------------------------------------------------
// listPredictions
// ---------------------------------------------------------------------------

export interface PredictionFilters {
  readonly domain?: Domain
  readonly subject?: string
  readonly subjects?: readonly string[]
  readonly timeframe?: Timeframe
  readonly orgId?: string
  readonly dataMode?: DataMode
  /** true = settled only, false = unsettled only, undefined = both. */
  readonly settled?: boolean
  readonly generatedAfter?: string
  readonly generatedBefore?: string
  readonly minConfidence?: number
  readonly limit?: number
  readonly offset?: number
}

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 500

/**
 * List prediction rows (without children — list screens do not need per-model
 * output, and fetching it would be both slower and a tier leak).
 */
export async function listPredictions(
  filters: PredictionFilters = {},
  options?: RepositoryOptions,
): Promise<Result<PredictionRow[], Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)
  const offset = Math.max(filters.offset ?? 0, 0)

  try {
    let query = client.from('predictions').select('*')

    if (filters.domain !== undefined) query = query.eq('domain', filters.domain)
    if (filters.subject !== undefined) query = query.eq('subject', filters.subject)
    if (filters.subjects !== undefined && filters.subjects.length > 0) {
      query = query.in('subject', [...filters.subjects])
    }
    if (filters.timeframe !== undefined) query = query.eq('timeframe', filters.timeframe)
    if (filters.orgId !== undefined) query = query.eq('org_id', filters.orgId)
    if (filters.dataMode !== undefined) query = query.eq('data_mode', filters.dataMode)
    if (filters.settled === true) query = query.not('outcome_id', 'is', null)
    if (filters.settled === false) query = query.is('outcome_id', null)
    if (filters.generatedAfter !== undefined) {
      query = query.gte('generated_at', filters.generatedAfter)
    }
    if (filters.generatedBefore !== undefined) {
      query = query.lte('generated_at', filters.generatedBefore)
    }
    if (filters.minConfidence !== undefined) {
      query = query.gte('confidence', filters.minConfidence)
    }

    const { data, error } = await query
      .order('generated_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error !== null) return err(toError(error, 'listPredictions'))
    return ok(data ?? [])
  } catch (cause) {
    return err(toError(cause, 'listPredictions'))
  }
}

// ---------------------------------------------------------------------------
// recordPredictionHistory
// ---------------------------------------------------------------------------

export interface PredictionHistoryPoint {
  readonly predictionId: string | null
  readonly orgId?: string
  readonly domain: Domain
  readonly subject: string
  readonly timeframe: Timeframe
  readonly outcomeKey: string
  readonly probability: number
  readonly previousProbability?: number | null
  readonly confidence: number
  readonly dataQuality: number
  /** What caused the probability to move. 'INITIAL' for the first point. */
  readonly eventType?: VixeraEventType
  readonly eventId?: string | null
  /** Machine-computed description of the change. Never LLM-authored. */
  readonly delta?: Record<string, unknown>
  readonly recordedAt?: string
}

/**
 * Append one point to a subject's probability time-series.
 *
 * This is what makes both the probability-over-time chart and the "What
 * Changed?" panel show real data instead of an interpolation. Called by the
 * cascade in §13 every time a prediction is regenerated, with the triggering
 * event carried through so the UI can say *why* the line moved.
 *
 * Append-only, like predictions: there is no update or delete counterpart.
 */
export async function recordPredictionHistory(
  points: PredictionHistoryPoint | readonly PredictionHistoryPoint[],
  options?: RepositoryOptions,
): Promise<Result<number, Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  const list = Array.isArray(points) ? points : [points as PredictionHistoryPoint]
  if (list.length === 0) return ok(0)

  const rows: PredictionHistoryInsert[] = list.map((point) => ({
    org_id: point.orgId ?? PLATFORM_ORG_ID,
    prediction_id: point.predictionId,
    domain: point.domain,
    subject: point.subject,
    timeframe: point.timeframe,
    outcome_key: point.outcomeKey,
    probability: point.probability,
    previous_probability: point.previousProbability ?? null,
    confidence: point.confidence,
    data_quality: point.dataQuality,
    event_type: point.eventType ?? 'SCHEDULED',
    event_id: point.eventId ?? null,
    delta: (point.delta ?? {}) as PredictionHistoryInsert['delta'],
    ...(point.recordedAt !== undefined ? { recorded_at: point.recordedAt } : {}),
  }))

  try {
    // Idempotent on (prediction_id, outcome_key, recorded_at): replaying the
    // event that produced a snapshot must not duplicate the chart point.
    const { error } = await client
      .from('prediction_history')
      .upsert(rows, {
        onConflict: 'prediction_id,outcome_key,recorded_at',
        ignoreDuplicates: true,
      })

    if (error !== null) return err(toError(error, 'recordPredictionHistory'))
    return ok(rows.length)
  } catch (cause) {
    return err(toError(cause, 'recordPredictionHistory'))
  }
}

// ---------------------------------------------------------------------------
// settleOutcome
// ---------------------------------------------------------------------------

/**
 * Record what actually happened.
 *
 * READ THIS BEFORE CHANGING IT. `settleOutcome` writes a NEW row in
 * `prediction_outcomes` and sets `predictions.outcome_id` to point at it. It
 * does not touch `outcomes`, `confidence`, `leading_probability` or any factor
 * of the original prediction, and it never deletes anything.
 *
 * A wrong prediction stays in the database, wrong, forever. That is the design.
 * The Brier score, the calibration curve and every accuracy claim the product
 * makes are computed from these rows, and all three are meaningless if the
 * losses can quietly disappear.
 *
 * Idempotent: `prediction_outcomes.prediction_id` is unique, so re-running the
 * settlement job over the same game or candle close is a no-op.
 */
export async function settleOutcome(
  predictionId: string,
  actualKey: string,
  options?: RepositoryOptions & {
    readonly actualLabel?: string | null
    readonly settledBy?: string
    readonly evidence?: Record<string, unknown>
  },
): Promise<Result<PredictionOutcomeRow, Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  try {
    const { data: prediction, error: readError } = await client
      .from('predictions')
      .select('id,outcomes,outcome_id')
      .eq('id', predictionId)
      .maybeSingle()

    if (readError !== null) return err(toError(readError, 'settleOutcome(read)'))
    if (prediction === null) {
      return err(new Error(`settleOutcome: prediction ${predictionId} not found`))
    }

    const outcomes: OutcomeJson[] = prediction.outcomes
    const matched = outcomes.find((o) => o.key === actualKey)
    if (matched === undefined) {
      // Settling against a key the prediction never assigned a probability to
      // would silently score it as 0 and make the accuracy record wrong in the
      // model's favour or against it, arbitrarily. Refuse.
      return err(
        new Error(
          `settleOutcome: actual key '${actualKey}' is not among the predicted outcomes [${outcomes
            .map((o) => o.key)
            .join(', ')}]`,
        ),
      )
    }

    // Multiclass Brier over the full probability vector, and log loss on the
    // probability assigned to what actually happened.
    let brier = 0
    for (const o of outcomes) {
      const actual = o.key === actualKey ? 1 : 0
      brier += (o.probability - actual) ** 2
    }
    const logLossValue = -Math.log(clampProbability(matched.probability))

    let wasCorrect = true
    for (const o of outcomes) {
      if (o.key !== actualKey && o.probability > matched.probability) {
        wasCorrect = false
        break
      }
    }

    const { data: outcomeRow, error: writeError } = await client
      .from('prediction_outcomes')
      .upsert(
        {
          prediction_id: predictionId,
          actual_key: actualKey,
          actual_label: options?.actualLabel ?? matched.label,
          predicted_probability: matched.probability,
          was_correct: wasCorrect,
          brier_score: brier,
          log_loss: logLossValue,
          settled_by: options?.settledBy ?? 'settlement_job',
          evidence: (options?.evidence ?? {}) as PredictionOutcomeRow['evidence'],
        },
        { onConflict: 'prediction_id' },
      )
      .select('*')
      .single()

    if (writeError !== null) return err(toError(writeError, 'settleOutcome(write)'))
    if (outcomeRow === null) return err(new Error('settleOutcome: upsert returned no row'))

    // The ONLY mutation ever made to a prediction row: the settlement pointer.
    // It also removes the row from the partial unsettled index, which is what
    // keeps the settlement job's scan proportional to open predictions.
    const { error: linkError } = await client
      .from('predictions')
      .update({ outcome_id: outcomeRow.id })
      .eq('id', predictionId)

    if (linkError !== null) return err(toError(linkError, 'settleOutcome(link)'))

    return ok(outcomeRow)
  } catch (cause) {
    return err(toError(cause, 'settleOutcome'))
  }
}

// ---------------------------------------------------------------------------
// getUnsettled
// ---------------------------------------------------------------------------

const DEFAULT_UNSETTLED_LIMIT = 200

/**
 * Predictions still awaiting a result, oldest first.
 *
 * Backed by the partial index `predictions_unsettled_idx (generated_at) where
 * outcome_id is null`, so this scan stays proportional to the number of open
 * predictions rather than to the size of the history. Demo-mode predictions are
 * included: they still need settling for the demo UI to behave, and they are
 * excluded from accuracy statistics later, at aggregation time, by data_mode.
 */
export async function getUnsettled(
  limit: number = DEFAULT_UNSETTLED_LIMIT,
  options?: RepositoryOptions & { readonly domain?: Domain; readonly before?: string },
): Promise<Result<PredictionRow[], Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT)

  try {
    let query = client.from('predictions').select('*').is('outcome_id', null)

    if (options?.domain !== undefined) query = query.eq('domain', options.domain)
    if (options?.before !== undefined) query = query.lte('generated_at', options.before)

    const { data, error } = await query
      .order('generated_at', { ascending: true })
      .limit(safeLimit)

    if (error !== null) return err(toError(error, 'getUnsettled'))
    return ok(data ?? [])
  } catch (cause) {
    return err(toError(cause, 'getUnsettled'))
  }
}
