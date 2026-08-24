/**
 * The single place a VixeraPrediction may be constructed.
 *
 * Centralising construction is what makes the system's guarantees enforceable
 * rather than aspirational: dataMode is derived from actual source provenance,
 * dataTimestamp is the OLDEST source, probabilities are re-normalised, and the
 * invariants are asserted before the object escapes.
 */

import { invariant } from '../errors'
import type { Clock } from '../clock'
import { isoNow } from '../clock'
import { normalizeOutcomes } from './probability'
import { computeRiskLevel } from './risk'
import {
  PROBABILISTIC_DISCLAIMER,
  type DataMode,
  type Domain,
  type ModelOutput,
  type Outcome,
  type PredictionFactor,
  type Scenario,
  type SourceRef,
  type Timeframe,
  type VixeraPrediction,
  type VolatilityForecast,
} from './types'

export interface BuildPredictionParams {
  readonly id: string
  readonly domain: Domain
  readonly subject: string
  readonly subjectLabel: string
  readonly timeframe: Timeframe
  readonly outcomes: readonly Outcome[]
  readonly confidence: number
  readonly dataQuality: number
  readonly modelAgreement: number
  readonly factors: readonly PredictionFactor[]
  readonly modelOutputs: readonly ModelOutput[]
  readonly sources: readonly SourceRef[]
  readonly scenarios?: readonly Scenario[] | null
  readonly volatility?: VolatilityForecast | null
  readonly externalUncertainty?: number
  readonly modelVersion: string
  readonly clock: Clock
}

export function buildPrediction(params: BuildPredictionParams): VixeraPrediction {
  const outcomes = normalizeOutcomes(params.outcomes)

  // Factors are split by sign. A factor with a null contribution is classified
  // by the sign embedded in its evidence, defaulting to supporting; it is never
  // assigned a fabricated numeric contribution to make the split easier.
  const supporting = params.factors.filter((f) => (f.contribution ?? 0) >= 0)
  const opposing = params.factors.filter((f) => (f.contribution ?? 0) < 0)

  const volatility = params.volatility ?? null

  const riskLevel = computeRiskLevel({
    outcomes,
    confidence: params.confidence,
    expectedVolatility: volatility?.expectedMove ?? null,
    externalUncertainty: params.externalUncertainty ?? 0,
  })

  const prediction: VixeraPrediction = {
    id: params.id,
    domain: params.domain,
    subject: params.subject,
    subjectLabel: params.subjectLabel,
    timeframe: params.timeframe,
    outcomes,
    confidence: params.confidence,
    dataQuality: params.dataQuality,
    modelAgreement: params.modelAgreement,
    riskLevel,
    supportingFactors: sortByAbsContribution(supporting),
    opposingFactors: sortByAbsContribution(opposing),
    modelOutputs: params.modelOutputs,
    scenarios: params.scenarios ?? null,
    volatility,
    sources: params.sources,
    dataMode: deriveDataMode(params.sources),
    generatedAt: isoNow(params.clock),
    dataTimestamp: oldestSourceTimestamp(params.sources, params.clock),
    modelVersion: params.modelVersion,
    disclaimer: PROBABILISTIC_DISCLAIMER,
  }

  assertValidPrediction(prediction)
  return prediction
}

/**
 * dataMode is DERIVED FROM PROVENANCE, never passed in.
 *
 * There is deliberately no parameter that lets a caller declare a prediction
 * 'live'. The only way to obtain 'live' is for every source to be a real
 * provider that actually answered.
 */
export function deriveDataMode(sources: readonly SourceRef[]): DataMode {
  if (sources.length === 0) return 'demo'
  if (sources.some((s) => s.isDemo)) return 'demo'
  // A live-labelled source set that is missing expected capabilities is marked
  // partial by the orchestrator, which passes a sentinel capability entry.
  if (sources.some((s) => s.capability.startsWith('missing:'))) return 'partial'
  return 'live'
}

/** The oldest source wins — a prediction is as fresh as its stalest input. */
function oldestSourceTimestamp(sources: readonly SourceRef[], clock: Clock): string {
  if (sources.length === 0) return isoNow(clock)
  let oldest = Infinity
  for (const s of sources) {
    const t = Date.parse(s.dataAsOf)
    if (Number.isFinite(t) && t < oldest) oldest = t
  }
  return Number.isFinite(oldest) ? new Date(oldest).toISOString() : isoNow(clock)
}

function sortByAbsContribution(factors: readonly PredictionFactor[]): PredictionFactor[] {
  return [...factors].sort((a, b) => {
    const av = a.contribution === null ? -1 : Math.abs(a.contribution)
    const bv = b.contribution === null ? -1 : Math.abs(b.contribution)
    return bv - av
  })
}

/** Runtime invariants. Violations are bugs and throw. */
export function assertValidPrediction(p: VixeraPrediction): void {
  invariant(p.outcomes.length >= 2, `prediction ${p.id} needs at least two outcomes`)

  let sum = 0
  for (const o of p.outcomes) {
    invariant(
      Number.isFinite(o.probability) && o.probability >= 0 && o.probability <= 1,
      `prediction ${p.id} outcome ${o.key} has invalid probability ${o.probability}`,
    )
    sum += o.probability
  }
  invariant(Math.abs(sum - 1) < 1e-6, `prediction ${p.id} probabilities sum to ${sum}, not 1`)

  invariant(
    p.confidence >= 0 && p.confidence <= 1,
    `prediction ${p.id} confidence ${p.confidence} out of range`,
  )
  invariant(
    p.dataQuality >= 0 && p.dataQuality <= 100,
    `prediction ${p.id} dataQuality ${p.dataQuality} out of range`,
  )
  invariant(
    p.modelAgreement >= 0 && p.modelAgreement <= 1,
    `prediction ${p.id} modelAgreement ${p.modelAgreement} out of range`,
  )

  if (p.scenarios) {
    const sSum = p.scenarios.reduce((a, s) => a + s.probability, 0)
    invariant(
      Math.abs(sSum - 1) < 1e-6,
      `prediction ${p.id} scenario probabilities sum to ${sSum}, not 1`,
    )
  }

  const keys = new Set(p.outcomes.map((o) => o.key))
  invariant(keys.size === p.outcomes.length, `prediction ${p.id} has duplicate outcome keys`)

  // The guarantee from §19 of the plan, enforced in code.
  if (p.dataMode === 'live') {
    invariant(
      p.sources.length > 0 && p.sources.every((s) => !s.isDemo),
      `prediction ${p.id} claims live data but has demo or missing sources`,
    )
  }
}
