/**
 * Structure model — trend structure, support/resistance proximity, and
 * breakout state.
 *
 * Where the technical model reads derived oscillators, this one reads the
 * GEOMETRY the structure layer extracted: the swing pattern (HH-HL / LH-LL),
 * where the strong levels are, and whether the latest bar actually broke one.
 *
 * The directional logic, term by term:
 *  - TREND PATTERN: HH-HL (buyers stepping in ever higher) leans up in
 *    proportion to the pattern's strength; LH-LL mirrors down. Ranging and
 *    transition patterns score 0 — they are real information ("no directional
 *    structure"), not missing information, so the term stays defined.
 *  - S/R PROXIMITY: price just below strong resistance leans DOWN — the level
 *    is where sellers have repeatedly shown up, and until it breaks, the
 *    base case is that they show up again. Price just above strong support
 *    mirrors up. The lean scales with the level's strength and fades linearly
 *    to zero by 2 ATR away — beyond that the level is context, not pressure.
 *  - BREAKOUT STATE: a volume-confirmed close through a level flips the S/R
 *    logic — the sellers who defined the resistance have been absorbed, and
 *    the level's former defenders are now trapped on the wrong side. So a
 *    confirmed breakout leans up, a breakdown leans down, and a REJECTION
 *    (pierce-and-fail, see structure.detectBreakout) leans back INTO the
 *    range: rejection at resistance is a down signal, at support an up signal.
 */

import type { PredictionModel } from '@/engines/model'
import type { CryptoFeatures } from '../features'
import { runLogisticModel, type LogisticTerm } from './shared'

// -- documented weights -------------------------------------------------------
/** Swing pattern (HH-HL / LH-LL) at full strength. */
export const W_TREND = 0.8
/** Proximity to a strong level at zero distance and full level strength. */
export const W_SR = 0.6
/** Confirmed breakout/breakdown at full strength. */
export const W_BREAKOUT = 0.9
/** Rejections are weaker evidence than confirmed breaks. */
const REJECTION_FACTOR = 0.6

/** Levels further than this many ATRs away exert no proximity pressure. */
const SR_RANGE_ATR = 2

function trendScore(f: CryptoFeatures): number | null {
  const ts = f.trendStructure
  if (ts === null) return null
  if (ts.pattern === 'HH-HL') return W_TREND * ts.strength
  if (ts.pattern === 'LH-LL') return -W_TREND * ts.strength
  return 0 // ranging / transition: genuinely no directional structure
}

function srProximityScore(f: CryptoFeatures): number | null {
  const sup = f.nearestSupport
  const res = f.nearestResistance
  if (sup === null && res === null) return null
  let score = 0
  if (res !== null && res.distanceAtr < SR_RANGE_ATR) {
    score -= W_SR * res.strength * (1 - res.distanceAtr / SR_RANGE_ATR)
  }
  if (sup !== null && sup.distanceAtr < SR_RANGE_ATR) {
    score += W_SR * sup.strength * (1 - sup.distanceAtr / SR_RANGE_ATR)
  }
  return score
}

function breakoutScore(f: CryptoFeatures): number | null {
  const b = f.breakout
  if (b === null) return null
  switch (b.type) {
    case 'breakout':
      return W_BREAKOUT * b.strength
    case 'breakdown':
      return -W_BREAKOUT * b.strength
    case 'rejection': {
      // Rejection leans back toward the range interior. Which side that is
      // depends on which kind of level was probed.
      if (b.level === null) return 0
      const direction = b.level.type === 'resistance' ? -1 : 1
      return direction * REJECTION_FACTOR * W_BREAKOUT * b.strength
    }
    case 'none':
      return 0
  }
}

export const structureModel: PredictionModel<CryptoFeatures> = {
  id: 'crypto-structure',
  version: '1.0.0',
  outcomeKeys: ['up', 'down'],
  run(f) {
    const terms: LogisticTerm[] = [
      {
        id: 'trend-pattern',
        label: 'Swing structure pattern',
        score: trendScore(f),
        detail:
          f.trendStructure === null
            ? null
            : `${f.trendStructure.pattern} @ strength ${f.trendStructure.strength.toFixed(2)}`,
        evidenceStrength: f.trendStructure?.strength ?? 0,
      },
      {
        id: 'sr-proximity',
        label: 'Support/resistance proximity',
        score: srProximityScore(f),
        detail: describeProximity(f),
        evidenceStrength: 0.7,
      },
      {
        id: 'breakout-state',
        label: 'Breakout state',
        score: breakoutScore(f),
        detail:
          f.breakout === null
            ? null
            : `${f.breakout.type}${f.breakout.confirmedByVolume ? ' (volume-confirmed)' : ''}`,
        evidenceStrength: f.breakout?.strength ?? 0,
      },
    ]

    return runLogisticModel({
      modelId: this.id,
      version: this.version,
      terms,
      baseConfidence: 0.65,
      minDefinedTerms: 1,
      abstainReason: 'no structure features available',
    })
  },
}

function describeProximity(f: CryptoFeatures): string | null {
  const parts: string[] = []
  if (f.nearestResistance !== null) {
    parts.push(
      `resistance ${f.nearestResistance.distanceAtr.toFixed(2)} ATR above (strength ${f.nearestResistance.strength.toFixed(2)})`,
    )
  }
  if (f.nearestSupport !== null) {
    parts.push(
      `support ${f.nearestSupport.distanceAtr.toFixed(2)} ATR below (strength ${f.nearestSupport.strength.toFixed(2)})`,
    )
  }
  return parts.length === 0 ? null : parts.join('; ')
}
