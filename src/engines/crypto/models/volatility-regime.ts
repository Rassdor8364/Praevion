/**
 * Volatility-regime model — the deliberately DIRECTION-NEUTRAL member of the
 * pool.
 *
 * THIS MODEL'S ROLE IS UNUSUAL AND WORTH SPELLING OUT. Every other model in
 * the ensemble reads history and projects it forward, which silently assumes
 * the current regime resembles the one the history was generated in. The
 * volatility regime classifier is the system's measure of whether that
 * assumption currently holds. In an 'extreme' regime — a liquidation cascade,
 * a news shock — the statistical relationships every other model relies on
 * are at their least reliable, and no directional read of the same history
 * can fix that.
 *
 * So this model never votes on direction. It always emits (near-)50/50; what
 * varies is its CONFIDENCE, which collapses as the regime worsens. Its job in
 * the pool is to DRAG THE ENSEMBLE TOWARD HUMILITY when the regime says
 * history is unreliable: its 50/50 vote pulls the pooled log-odds toward
 * zero, and its disagreement with confident directional models widens the
 * pool's log-odds dispersion, which mechanically lowers `modelAgreement` and
 * therefore the prediction's confidence (see ensemble.computeAgreement and
 * confidence.computeConfidence). A stack of models that are all extrapolating
 * the same broken regime will agree with each other perfectly; this model is
 * the one voice in the room whose only line is "are we sure the past applies
 * right now?".
 *
 * Its featureContribution is genuinely 0 — a direction-neutral model has a
 * real, computed tilt contribution of zero, not an invented number.
 */

import type { ModelOutput } from '@/core/prediction/types'
import { abstain, emit, type PredictionModel } from '@/engines/model'
import type { CryptoFeatures } from '../features'
import { UP_DOWN_KEYS } from './shared'

/**
 * Confidence by regime. 'low' and 'normal' regimes get a moderate confidence
 * — the statement "history currently applies" is itself worth something to
 * the pool. 'extreme' gets close to none: the model is present, voting 50/50,
 * and loudly unsure, which is exactly the drag it exists to provide.
 */
export const REGIME_CONFIDENCE: Readonly<Record<string, number>> = {
  low: 0.65,
  normal: 0.6,
  elevated: 0.3,
  extreme: 0.08,
}

export const volatilityRegimeModel: PredictionModel<CryptoFeatures> = {
  id: 'crypto-volatility-regime',
  version: '1.0.0',
  outcomeKeys: ['up', 'down'],
  run(f): ModelOutput {
    if (f.volRegime === null) {
      return abstain(
        this.id,
        this.version,
        UP_DOWN_KEYS,
        'volatility regime unavailable (insufficient ATR history)',
      )
    }

    const confidence = REGIME_CONFIDENCE[f.volRegime] ?? 0.5

    return emit({
      modelId: this.id,
      version: this.version,
      outcomes: [
        { key: 'up', label: 'Up', probability: 0.5 },
        { key: 'down', label: 'Down', probability: 0.5 },
      ],
      confidence,
      factors: [
        {
          id: 'volatility-regime',
          label: 'Volatility regime',
          // Zero is the real, computed directional contribution of a
          // direction-neutral model.
          contribution: 0,
          detail:
            `regime = ${f.volRegime}` +
            (f.atrPercentile === null
              ? ''
              : `, ATR percentile = ${(f.atrPercentile * 100).toFixed(0)}`),
          evidenceStrength: f.volForecast?.confidence ?? 0.5,
        },
      ],
    })
  },
}
