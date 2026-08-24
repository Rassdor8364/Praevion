/**
 * Derivatives model — funding-rate extremity as a CONTRARIAN signal, with
 * open interest as a crowding amplifier.
 *
 * THE MECHANISM, because it is the opposite of the naive reading: on a
 * perpetual swap, funding is the periodic payment that keeps the perp's price
 * pinned to spot — when the perp trades rich, LONGS PAY SHORTS. A very
 * positive funding rate therefore means longs are so crowded and so leveraged
 * that they are paying a steep recurring fee just to keep the position on.
 * That crowd is a spent force twice over: (1) the marginal buyer has already
 * bought — the people who wanted to be long ARE long, so who is left to lift
 * the offer? — and (2) every one of those leveraged longs has a liquidation
 * price below the market, forming a reservoir of FORCED, price-insensitive
 * selling that a small dip can cascade through. Extremely positive funding is
 * thus statistically bearish, and extremely negative funding (crowded,
 * paying shorts) bullish. Reading positive funding as "bullish sentiment,
 * therefore up" is buying the top of a crowded trade.
 *
 * Funding near its normal level (a few basis points per interval) is noise
 * and the tanh keeps its score near zero; the signal lives in the tails.
 *
 * OPEN INTEREST does not vote on direction by itself — high OI is just "many
 * positions exist", which says nothing about which way. What it does is
 * AMPLIFY the funding read: extreme funding with OI large relative to daily
 * volume means the crowded trade is big relative to the market's capacity to
 * absorb its unwind. So the OI term carries the SAME SIGN as the funding
 * lean, scaled by OI-to-volume — a real computed second term, not decoration.
 *
 * Abstains without derivatives data (no funding rate): open interest alone
 * has no directional content to contribute.
 */

import type { PredictionModel } from '@/engines/model'
import type { CryptoFeatures } from '../features'
import { runLogisticModel, squash, type LogisticTerm } from './shared'

// -- documented weights -------------------------------------------------------
/** Contrarian funding term at full extremity. */
export const W_FUNDING = 0.9
/** OI amplifier as a fraction of the funding score at full crowding. */
export const OI_AMPLIFIER = 0.4

/**
 * Funding scale: ±0.05% per funding interval (~±55%/yr at 8h funding) is a
 * heavily crowded market; typical calm funding is ~0.01%. The tanh means the
 * score is near-linear below the scale and saturates beyond it.
 */
export const FUNDING_SCALE = 5e-4

/** OI notional at 1.5× daily quote volume saturates the crowding amplifier. */
const OI_SATURATION_RATIO = 1.5

export const derivativesModel: PredictionModel<CryptoFeatures> = {
  id: 'crypto-derivatives',
  version: '1.0.0',
  outcomeKeys: ['up', 'down'],
  run(f) {
    // Contrarian: positive funding (crowded longs) leans DOWN.
    const fundingScore =
      f.fundingRate === null ? null : -W_FUNDING * squash(f.fundingRate, FUNDING_SCALE)

    // Same sign as the funding lean; zero without a funding read at all.
    const oiScore =
      fundingScore === null || f.oiToVolume24h === null
        ? null
        : fundingScore * OI_AMPLIFIER * Math.min(1, Math.max(0, f.oiToVolume24h) / OI_SATURATION_RATIO)

    const terms: LogisticTerm[] = [
      {
        id: 'funding-extremity',
        label: 'Funding rate extremity (contrarian)',
        score: fundingScore,
        detail:
          f.fundingRate === null
            ? null
            : `funding = ${(f.fundingRate * 100).toFixed(4)}% per interval`,
        evidenceStrength: 0.8,
      },
      {
        id: 'oi-crowding',
        label: 'Open-interest crowding amplifier',
        score: oiScore,
        detail:
          f.oiToVolume24h === null
            ? null
            : `OI notional = ${f.oiToVolume24h.toFixed(2)}× 24h volume`,
        evidenceStrength: 0.6,
      },
    ]

    // The abstention rule: without funding there is no derivatives signal.
    // minDefinedTerms alone would let a lone OI term run, but oiScore is
    // already null when fundingScore is, so requiring the funding term is
    // equivalent to requiring >= 1 defined term here.
    return runLogisticModel({
      modelId: this.id,
      version: this.version,
      terms,
      baseConfidence: 0.6,
      minDefinedTerms: 1,
      abstainReason: 'derivatives data unavailable (no funding rate)',
    })
  },
}
