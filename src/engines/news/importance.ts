/**
 * Vixera News Impact Score, 0–100 (plan §11).
 *
 * A weighted blend of source reliability, INDEPENDENT source count, entity
 * importance, category prior, novelty vs older clusters, and reporting
 * velocity. Historically-observed market response is a plan-§11 factor this
 * deployment cannot compute yet (no outcome history exists); it is absent
 * from the blend rather than faked, and the weights renormalize over what is
 * actually measured.
 *
 * BREAKING is a VELOCITY claim, never a vocabulary claim: it fires when
 * independent sources per hour exceeds a threshold on a young cluster with
 * real corroboration. The word "BREAKING" in a headline is ignored on purpose
 * — outlets attach it to routine copy as a click device, so the token has no
 * evidential value; the observable that does is several independent
 * newsrooms deciding the same story is worth staffing within hours.
 *
 * RUMOURS: a cluster whose best source class is SOCIAL/UNVERIFIED is marked
 * `unverified`, its importance is hard-capped, and callers must exclude it
 * from any market-signal output (plan §11: excluded from the news feature
 * vector until an ESTABLISHED_MEDIA+ source appears).
 *
 * Pure: the evaluation instant arrives as an explicit `asOf`.
 */

import { HOUR_MS } from '@/core/clock'
import type { ReliabilityClass } from '@/core/prediction/types'
import { getEntity, type EntityType } from './entities'
import { cosineSimilarity, type StoryCluster } from './cluster'

// ---------------------------------------------------------------------------
// Weight tables
// ---------------------------------------------------------------------------

/** Source-class quality, 0..1 — mirrors the shape of the data-quality table. */
const RELIABILITY_SCORE: Readonly<Record<ReliabilityClass, number>> = {
  OFFICIAL: 1.0,
  PRIMARY_SOURCE: 0.97,
  HIGH_RELIABILITY: 0.92,
  ESTABLISHED_MEDIA: 0.85,
  SECONDARY: 0.65,
  SOCIAL: 0.35,
  UNVERIFIED: 0.15,
}

/**
 * Entity-type importance, 0..1. Macro entities outrank single names because
 * their news reprices everything at once: a Fed decision moves every dollar
 * asset, while one mid-cap's earnings move one ticker. Sports entities sit
 * low — league news matters to the sports vertical but rarely to markets.
 */
const ENTITY_TYPE_WEIGHT: Readonly<Record<EntityType, number>> = {
  macro: 1.0,
  asset: 0.8,
  org: 0.7,
  company: 0.7,
  country: 0.65,
  topic: 0.55,
  league: 0.45,
  team: 0.35,
}

/** Per-entity overrides where the type-level weight is too coarse. */
const ENTITY_ID_WEIGHT: ReadonlyMap<string, number> = new Map([
  ['fed', 1.0],
  ['cpi', 0.95],
  ['interest-rates', 0.95],
  ['sec', 0.9],
  ['btc', 0.9],
  ['eth', 0.85],
  ['tariffs', 0.9],
  ['recession', 0.9],
  ['nvidia', 0.85], // single name, but currently index-moving
])

/** Category prior, 0..1 — how likely a story in this bucket is to matter to
 *  Praevion's users at all. Feed categories, normalized by the orchestrator. */
const CATEGORY_PRIOR: ReadonlyMap<string, number> = new Map([
  ['markets', 0.9],
  ['business', 0.85],
  ['crypto', 0.85],
  ['world', 0.8],
  ['tech', 0.7],
  ['sports', 0.55],
])
const DEFAULT_CATEGORY_PRIOR = 0.6

// ---------------------------------------------------------------------------
// Config + output
// ---------------------------------------------------------------------------

export interface ImportanceConfig {
  /** Independent sources/hour above which a young cluster reads as breaking. */
  readonly breakingVelocityPerHour: number
  /** Max cluster age (since first detection) for breaking status. */
  readonly breakingMaxAgeMs: number
  /** Min independent sources for breaking status. */
  readonly breakingMinSources: number
  /** Hard cap on the importance of an unverified (SOCIAL/UNVERIFIED) cluster. */
  readonly unverifiedCap: number
}

export const DEFAULT_IMPORTANCE_CONFIG: ImportanceConfig = {
  breakingVelocityPerHour: 1.5,
  breakingMaxAgeMs: 6 * HOUR_MS,
  breakingMinSources: 3,
  unverifiedCap: 35,
}

export interface ImportanceComponents {
  /** All 0..1. */
  readonly reliability: number
  readonly sourceCount: number
  readonly entityImportance: number
  readonly categoryPrior: number
  readonly novelty: number
  readonly velocity: number
}

export interface ClusterImportance {
  /** 0..100. */
  readonly importance: number
  readonly isBreaking: boolean
  /** True when NO member reaches ESTABLISHED_MEDIA or better. Unverified
   *  clusters are capped and MUST be excluded from market-signal output. */
  readonly unverified: boolean
  /** Independent sources per hour since first detection. */
  readonly sourcesPerHour: number
  readonly components: ImportanceComponents
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const WEIGHTS = {
  reliability: 0.2,
  sourceCount: 0.24,
  entityImportance: 0.2,
  categoryPrior: 0.1,
  novelty: 0.12,
  velocity: 0.14,
} as const

/**
 * Score one cluster.
 *
 * `olderClusters` are the novelty reference: clusters whose story began before
 * this one (the orchestrator passes the rest of the window). High similarity
 * to an older cluster means this is a follow-up beat, not a new event.
 */
export function scoreCluster(params: {
  readonly cluster: StoryCluster
  readonly olderClusters: readonly StoryCluster[]
  readonly category: string
  /** Evaluation instant — explicit, never Date.now(). */
  readonly asOf: number
  readonly config?: ImportanceConfig
}): ClusterImportance {
  const { cluster, olderClusters, category, asOf } = params
  const config = params.config ?? DEFAULT_IMPORTANCE_CONFIG

  // --- Reliability: member-count-weighted mean of class scores. -----------
  let reliabilitySum = 0
  let memberCount = 0
  for (const [cls, count] of Object.entries(cluster.reliabilityMix) as [ReliabilityClass, number][]) {
    reliabilitySum += RELIABILITY_SCORE[cls] * count
    memberCount += count
  }
  const reliability = memberCount === 0 ? 0 : reliabilitySum / memberCount

  // --- Independent source count, log-scaled: 1→0, 3→0.5, 8→~1. ------------
  const sourceCount = Math.min(1, Math.log2(1 + Math.max(0, cluster.sourceCount - 1)) / Math.log2(8))

  // --- Entity importance: the strongest entity present. Max, not mean — a
  // story about the Fed AND a football club is a Fed story. Mention-starved
  // entities (1 mention) are slightly discounted to resist drive-by matches.
  let entityImportance = 0
  for (const e of cluster.entities) {
    const definition = getEntity(e.entityId)
    if (definition === null) continue
    const base = ENTITY_ID_WEIGHT.get(e.entityId) ?? ENTITY_TYPE_WEIGHT[definition.type]
    const mentionFactor = e.mentions >= 2 ? 1 : 0.8
    entityImportance = Math.max(entityImportance, base * mentionFactor)
  }

  // --- Category prior. -----------------------------------------------------
  const categoryPrior = CATEGORY_PRIOR.get(category) ?? DEFAULT_CATEGORY_PRIOR

  // --- Novelty: 1 − max cosine similarity vs any older cluster. ------------
  let maxSim = 0
  for (const other of olderClusters) {
    if (other.id === cluster.id) continue
    if (other.earliestPublishedAt >= cluster.earliestPublishedAt) continue
    maxSim = Math.max(maxSim, cosineSimilarity(cluster.centroid, other.centroid))
  }
  const novelty = 1 - Math.min(1, maxSim)

  // --- Velocity: independent sources per hour since first detection. -------
  // The first hour is floored so a story 10 minutes old with 2 sources does
  // not read as 12 sources/hour off almost no evidence.
  const ageMs = Math.max(0, asOf - cluster.earliestPublishedAt)
  const ageHours = Math.max(1, ageMs / HOUR_MS)
  const sourcesPerHour = cluster.sourceCount / ageHours
  const velocity = Math.min(1, sourcesPerHour / 3)

  const components: ImportanceComponents = {
    reliability,
    sourceCount,
    entityImportance,
    categoryPrior,
    novelty,
    velocity,
  }

  const blended =
    components.reliability * WEIGHTS.reliability +
    components.sourceCount * WEIGHTS.sourceCount +
    components.entityImportance * WEIGHTS.entityImportance +
    components.categoryPrior * WEIGHTS.categoryPrior +
    components.novelty * WEIGHTS.novelty +
    components.velocity * WEIGHTS.velocity

  // --- Rumour gate. ---------------------------------------------------------
  const unverified =
    cluster.bestReliability === 'SOCIAL' || cluster.bestReliability === 'UNVERIFIED'

  let importance = Math.round(Math.max(0, Math.min(1, blended)) * 100)
  if (unverified) importance = Math.min(importance, config.unverifiedCap)

  // --- Breaking: velocity + youth + corroboration, never vocabulary. -------
  const isBreaking =
    !unverified &&
    sourcesPerHour >= config.breakingVelocityPerHour &&
    ageMs < config.breakingMaxAgeMs &&
    cluster.sourceCount >= config.breakingMinSources

  return { importance, isBreaking, unverified, sourcesPerHour, components }
}
