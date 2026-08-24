/**
 * Momentum model — multi-window return momentum, OBV confirmation, and an
 * ADX gate.
 *
 * WHY THE ADX GATE: raw return momentum is two very different signals wearing
 * one number. In a trending market, a positive 20-bar return is evidence of a
 * persistent imbalance that tends to continue; in a ranging market the same
 * return is just the upswing of an oscillation that is about to revert.
 * ADX measures trend STRENGTH (direction-agnostically — see indicators.adx),
 * so it is exactly the variable that distinguishes those two worlds. The
 * return terms are therefore multiplied by a gate that runs from 0.4 (no
 * trend: momentum is mostly noise, but not entirely worthless) to 1.0 (ADX ≥
 * 40: the trend is real, momentum means what it says). When ADX is
 * unavailable the gate sits at a neutral 0.7 rather than either extreme —
 * absence of the gate variable is not evidence about the regime.
 *
 * Return windows are normalised by realised per-bar volatility × √window, so
 * "large" means large FOR THIS ASSET AT THIS TIME, not in absolute percent.
 * OBV slope is the volume confirmation: price momentum on rising OBV is being
 * paid for; on falling OBV it is drifting on air. OBV is not gated — volume
 * divergence is informative in every regime.
 */

import type { PredictionModel } from '@/engines/model'
import type { CryptoFeatures } from '../features'
import { runLogisticModel, squash, type LogisticTerm } from './shared'

// -- documented weights -------------------------------------------------------
/** 5-bar return momentum. */
export const W_RET_5 = 0.9
/** 20-bar return momentum. */
export const W_RET_20 = 0.7
/** OBV slope (volume confirmation). */
export const W_OBV = 0.5

/** Fallback per-bar sigma when realised volatility is unavailable. */
const FALLBACK_SIGMA = 0.01
/** Gate when ADX is unavailable — deliberately neutral, not 0 and not 1. */
const NEUTRAL_GATE = 0.7

function adxGate(adx: number | null): number {
  if (adx === null) return NEUTRAL_GATE
  // 0.4 below ADX 15 (no trend), ramping to 1.0 at ADX 40 (established trend).
  const t = Math.min(1, Math.max(0, (adx - 15) / 25))
  return 0.4 + 0.6 * t
}

export const momentumModel: PredictionModel<CryptoFeatures> = {
  id: 'crypto-momentum',
  version: '1.0.0',
  outcomeKeys: ['up', 'down'],
  run(f) {
    const sigma = f.realisedVol !== null && f.realisedVol > 0 ? f.realisedVol : FALLBACK_SIGMA
    const gate = adxGate(f.adx)

    // A window return of 2 sigma-scaled units is a strong reading.
    const scale5 = 2 * sigma * Math.sqrt(5)
    const scale20 = 2 * sigma * Math.sqrt(20)

    const terms: LogisticTerm[] = [
      {
        id: 'return-5',
        label: '5-bar return momentum (ADX-gated)',
        score: f.ret5 === null ? null : W_RET_5 * gate * squash(f.ret5, scale5),
        detail:
          f.ret5 === null
            ? null
            : `r5 = ${(f.ret5 * 100).toFixed(2)}%, gate = ${gate.toFixed(2)}`,
        evidenceStrength: 0.8,
      },
      {
        id: 'return-20',
        label: '20-bar return momentum (ADX-gated)',
        score: f.ret20 === null ? null : W_RET_20 * gate * squash(f.ret20, scale20),
        detail:
          f.ret20 === null
            ? null
            : `r20 = ${(f.ret20 * 100).toFixed(2)}%, gate = ${gate.toFixed(2)}`,
        evidenceStrength: 0.8,
      },
      {
        id: 'obv-slope',
        label: 'OBV slope (volume confirmation)',
        score: f.obvSlope === null ? null : W_OBV * squash(f.obvSlope, 0.5),
        detail: f.obvSlope === null ? null : `obv slope = ${f.obvSlope.toFixed(3)}`,
        evidenceStrength: 0.7,
      },
    ]

    return runLogisticModel({
      modelId: this.id,
      version: this.version,
      terms,
      baseConfidence: 0.7,
      minDefinedTerms: 1,
      abstainReason: 'no return or OBV features available',
    })
  },
}
