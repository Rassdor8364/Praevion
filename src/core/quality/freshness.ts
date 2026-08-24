/** Freshness labelling for the UI. Every data-bearing screen shows one of these. */

import type { Clock } from '../clock'
import { ageMs, HOUR_MS, MINUTE_MS } from '../clock'

export type FreshnessState = 'live' | 'fresh' | 'aging' | 'stale' | 'expired'

export interface Freshness {
  readonly state: FreshnessState
  readonly ageMs: number
  readonly label: string
}

export function assessFreshness(params: {
  dataAsOf: string | number
  /** Age beyond which the data is no longer considered usable. */
  maxAgeMs: number
  clock: Clock
}): Freshness {
  const ts = typeof params.dataAsOf === 'number' ? params.dataAsOf : Date.parse(params.dataAsOf)
  if (!Number.isFinite(ts)) {
    return { state: 'expired', ageMs: Number.POSITIVE_INFINITY, label: 'Unknown' }
  }

  const age = ageMs(ts, params.clock)
  const ratio = age / params.maxAgeMs

  const state: FreshnessState =
    age < 5_000 ? 'live' : ratio < 0.5 ? 'fresh' : ratio < 1 ? 'aging' : ratio < 3 ? 'stale' : 'expired'

  return { state, ageMs: age, label: state === 'live' ? 'Live' : `Updated ${formatAge(age)} ago` }
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown'
  if (ms < MINUTE_MS) return `${Math.max(1, Math.round(ms / 1000))} seconds`
  if (ms < HOUR_MS) {
    const m = Math.round(ms / MINUTE_MS)
    return `${m} minute${m === 1 ? '' : 's'}`
  }
  if (ms < 24 * HOUR_MS) {
    const h = Math.round(ms / HOUR_MS)
    return `${h} hour${h === 1 ? '' : 's'}`
  }
  const d = Math.round(ms / (24 * HOUR_MS))
  return `${d} day${d === 1 ? '' : 's'}`
}
