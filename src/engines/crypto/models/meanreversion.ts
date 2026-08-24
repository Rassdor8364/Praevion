/**
 * Mean-reversion model — z-score stretch, %B, and the consolidation gate.
 *
 * The thesis: in a RANGE, price stretched far from its rolling mean tends to
 * come back, because the flow that produced the range (two-way, positioned
 * around a consensus value) is still in charge. All three inputs express
 * pieces of that thesis:
 *  - the z-score of price vs its rolling mean is the stretch itself;
 *  - Bollinger %B is the same stretch expressed against the band envelope
 *    (unlike the technical model, which only scores %B EXTREMES as one voice
 *    among four, here the full deviation from 0.5 scores — reversion to the
 *    middle is this model's entire worldview, not a tail case);
 *  - the consolidation score GATES the whole signal: reversion bets scale up
 *    when the market is demonstrably range-bound and scale down toward 40%
 *    weight when it is not.
 *
 * THE ABSTENTION RULE IS THE MOST IMPORTANT LINE IN THIS FILE. When the trend
 * structure is strongly directional (HH-HL or LH-LL at strength ≥ 0.6), this
 * model abstains entirely rather than voting small. A mean-reversion model
 * trading a trend is how quant books blow up: in a trend, "stretched" keeps
 * getting more stretched, every reversion entry is early, and the strategy's
 * losses are largest exactly when its signal looks strongest. Averaging a
 * small wrong vote into the pool would be a quieter version of the same
 * mistake — the honest output in a strong trend is "not my regime", which is
 * an abstention, and the ensemble drops the vote entirely (see ensemble.ts on
 * why "I don't know" must not be folded in as 50%).
 */

import type { PredictionModel } from '@/engines/model'
import type { CryptoFeatures } from '../features'
import { abstain } from '@/engines/model'
import { runLogisticModel, squash, type LogisticTerm } from './shared'
import { UP_DOWN_KEYS } from './shared'

// -- documented weights -------------------------------------------------------
/** Price z-score vs rolling mean, mean-reverting. */
export const W_ZSCORE = 0.9
/** Bollinger %B deviation from the midline, mean-reverting. */
export const W_PERCENT_B = 0.6

/** Trend strength at which this model refuses to trade against the tape. */
export const TREND_ABSTAIN_STRENGTH = 0.6

/** A 2-sigma stretch is a strong reading. */
const Z_SCALE = 2

export const meanReversionModel: PredictionModel<CryptoFeatures> = {
  id: 'crypto-meanreversion',
  version: '1.0.0',
  outcomeKeys: ['up', 'down'],
  run(f) {
    const ts = f.trendStructure
    if (
      ts !== null &&
      (ts.pattern === 'HH-HL' || ts.pattern === 'LH-LL') &&
      ts.strength >= TREND_ABSTAIN_STRENGTH
    ) {
      return abstain(
        this.id,
        this.version,
        UP_DOWN_KEYS,
        `strong ${ts.pattern} trend (strength ${ts.strength.toFixed(2)}) — mean reversion is not tradable against a trend`,
      )
    }

    // Consolidation gate: full weight in a clean range, 40% weight when the
    // market shows no consolidation, neutral 70% when the score is unknown.
    const gate = f.consolidationScore === null ? 0.7 : 0.4 + 0.6 * f.consolidationScore

    const terms: LogisticTerm[] = [
      {
        id: 'price-zscore',
        label: 'Price z-score vs rolling mean',
        // Negative: stretched ABOVE the mean leans DOWN.
        score: f.priceZScore === null ? null : -W_ZSCORE * gate * squash(f.priceZScore, Z_SCALE),
        detail:
          f.priceZScore === null
            ? null
            : `z = ${f.priceZScore.toFixed(2)}, range gate = ${gate.toFixed(2)}`,
        evidenceStrength: 0.75,
      },
      {
        id: 'percent-b-reversion',
        label: 'Bollinger %B reversion to midline',
        score:
          f.percentB === null
            ? null
            : -W_PERCENT_B * gate * squash((f.percentB - 0.5) * 2, 1),
        detail: f.percentB === null ? null : `%B = ${f.percentB.toFixed(2)}`,
        evidenceStrength: 0.7,
      },
    ]

    return runLogisticModel({
      modelId: this.id,
      version: this.version,
      terms,
      baseConfidence: 0.6,
      minDefinedTerms: 1,
      abstainReason: 'no mean-reversion features available (z-score and %B both missing)',
    })
  },
}
