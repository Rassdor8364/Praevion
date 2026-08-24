/**
 * Vixera Data Quality Score (0–100).
 *
 * This is the number that stops the system flattering itself. Every prediction
 * carries one, low scores mechanically reduce confidence, and the components are
 * shown to the user so a degraded score is explicable rather than mysterious.
 */

import type { Clock } from '../clock'
import { ageMs } from '../clock'
import type { ReliabilityClass, SourceRef } from '../prediction/types'

export interface DatasetQuality {
  readonly capability: string
  /** ISO timestamp of the newest datum. */
  readonly dataAsOf: string
  /** How old this dataset may be before it is considered stale, in ms. */
  readonly maxAgeMs: number
  /** Fraction of expected fields that were populated, 0..1. */
  readonly completeness: number
  /** Number of independent providers that supplied this capability. */
  readonly sourceCount: number
  readonly reliability: ReliabilityClass
  /**
   * 0..1 — how much independent sources disagreed. 0 = perfect agreement.
   * null when there was only one source, which is itself penalised via
   * sourceCount rather than pretended to be agreement.
   */
  readonly disagreement: number | null
  readonly isDemo: boolean
}

export interface DataQualityResult {
  /** 0..100 */
  readonly score: number
  readonly components: Readonly<Record<string, number>>
  /** Capabilities that were stale at evaluation time. */
  readonly staleCapabilities: readonly string[]
  /** Capabilities that were expected but entirely absent. */
  readonly missingCapabilities: readonly string[]
  readonly worstCapability: string | null
}

const RELIABILITY_WEIGHT: Record<ReliabilityClass, number> = {
  OFFICIAL: 1.0,
  PRIMARY_SOURCE: 0.97,
  HIGH_RELIABILITY: 0.92,
  ESTABLISHED_MEDIA: 0.85,
  SECONDARY: 0.70,
  SOCIAL: 0.45,
  UNVERIFIED: 0.25,
}

export function computeDataQuality(params: {
  datasets: readonly DatasetQuality[]
  expectedCapabilities: readonly string[]
  clock: Clock
}): DataQualityResult {
  const { datasets, expectedCapabilities, clock } = params

  const present = new Set(datasets.map((d) => d.capability))
  const missing = expectedCapabilities.filter((c) => !present.has(c))

  if (datasets.length === 0) {
    return {
      score: 0,
      components: { freshness: 0, completeness: 0, reliability: 0, corroboration: 0, coverage: 0 },
      staleCapabilities: [],
      missingCapabilities: missing,
      worstCapability: null,
    }
  }

  const stale: string[] = []
  let freshnessSum = 0
  let completenessSum = 0
  let reliabilitySum = 0
  let corroborationSum = 0

  let worstCapability: string | null = null
  let worstScore = Infinity

  for (const d of datasets) {
    const age = ageMs(Date.parse(d.dataAsOf), clock)
    // Freshness decays linearly to 0 at 3x the stale threshold rather than
    // cliff-edging at 1x — a dataset one second past its window is not worthless.
    const freshness = Math.max(0, 1 - age / (d.maxAgeMs * 3))
    if (age > d.maxAgeMs) stale.push(d.capability)

    const reliability = RELIABILITY_WEIGHT[d.reliability]
    // Corroboration rises with independent sources but is cut by how much they
    // disagree — two sources that contradict each other are worse than one.
    const agreement = d.disagreement === null ? 0.85 : 1 - Math.min(1, d.disagreement)
    const corroboration = Math.min(1, (0.55 + 0.225 * (d.sourceCount - 1))) * agreement

    freshnessSum += freshness
    completenessSum += clamp01(d.completeness)
    reliabilitySum += reliability
    corroborationSum += corroboration

    const capScore = freshness * 0.3 + clamp01(d.completeness) * 0.3 + reliability * 0.2 + corroboration * 0.2
    if (capScore < worstScore) {
      worstScore = capScore
      worstCapability = d.capability
    }
  }

  const n = datasets.length
  const coverage =
    expectedCapabilities.length === 0
      ? 1
      : (expectedCapabilities.length - missing.length) / expectedCapabilities.length

  const components = {
    freshness: freshnessSum / n,
    completeness: completenessSum / n,
    reliability: reliabilitySum / n,
    corroboration: corroborationSum / n,
    coverage,
  }

  const score =
    components.freshness * 0.28 +
    components.completeness * 0.24 +
    components.reliability * 0.18 +
    components.corroboration * 0.14 +
    components.coverage * 0.16

  return {
    score: Math.round(clamp01(score) * 100),
    components,
    staleCapabilities: stale,
    missingCapabilities: missing,
    worstCapability,
  }
}

/** Build SourceRefs from dataset quality records, for prediction provenance. */
export function toSourceRefs(
  datasets: readonly DatasetQuality[],
  providerByCapability: Readonly<Record<string, string>>,
  fetchedAt: string,
): SourceRef[] {
  return datasets.map((d) => ({
    providerId: providerByCapability[d.capability] ?? 'unknown',
    capability: d.capability,
    reliability: d.reliability,
    fetchedAt,
    dataAsOf: d.dataAsOf,
    isDemo: d.isDemo,
  }))
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.min(1, Math.max(0, x))
}
