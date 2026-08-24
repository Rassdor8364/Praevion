/**
 * Technical model — a logistic blend of the classic oscillators and MA
 * position.
 *
 * INDICATORS ARE FEATURES, NOT RULES (plan §10). There is no `if (rsi < 30)
 * buy` anywhere in this file. Each indicator is turned into a bounded, signed,
 * scale-free score; the scores are summed with documented weights; and the
 * logistic (sigmoid) turns that weighted feature sum into a probability. The
 * difference matters: a rule fires or it doesn't, so an RSI of 29.9 and 15
 * are the same signal; a weighted feature says 15 is a much stronger one, and
 * lets a strong MACD outvote a marginal RSI instead of both "triggering".
 *
 * Component reasoning:
 *  - RSI is used as a MEAN-REVERSION component: only its EXTREMITY beyond the
 *    conventional 30/70 band scores, and it scores AGAINST the move (deeply
 *    oversold leans up). RSI between 30 and 70 says nothing here — mid-range
 *    RSI direction is momentum's job, and double-counting it would correlate
 *    the two models.
 *  - MACD histogram (already ATR-normalised in the feature layer) is a
 *    trend/momentum component, scored WITH its sign.
 *  - Bollinger %B is a second mean-reversion voice: closes outside the bands
 *    are statistically stretched.
 *  - Price vs SMA50 (falling back to SMA20 on short histories) is the
 *    slow-trend anchor, scored with its sign.
 */

import type { PredictionModel } from '@/engines/model'
import type { CryptoFeatures } from '../features'
import { runLogisticModel, squash, type LogisticTerm } from './shared'

// -- documented weights (log-odds units at full feature deflection) ----------
/** RSI extremity beyond 30/70, mean-reversion. */
export const W_RSI = 0.9
/** ATR-normalised MACD histogram, trend-following. */
export const W_MACD = 0.8
/** Bollinger %B extremity outside [0.15, 0.85], mean-reversion. */
export const W_PERCENT_B = 0.5
/** Price vs slow SMA, trend-following. */
export const W_MA_POSITION = 0.7

/** MACD histogram of half an ATR is treated as a strong reading. */
const MACD_SCALE = 0.5
/** 5% above/below the slow SMA is treated as a strong trend displacement. */
const MA_SCALE = 0.05

function rsiExtremity(rsi: number): number {
  // Map RSI to [−1, 1], then keep only the part beyond ±0.4 (i.e. beyond
  // 30/70), rescaled so RSI 0/100 → ±1. Inside the band the term is exactly 0.
  const excess = (rsi - 50) / 50
  const beyond = Math.max(0, Math.abs(excess) - 0.4) / 0.6
  return Math.sign(excess) * beyond
}

function percentBExtremity(pB: number): number {
  // %B may exceed [0,1] (close outside the bands) — that overflow is exactly
  // the signal. Only the part outside [0.15, 0.85] scores; ±1 at %B = 0/1.
  const dev = pB - 0.5
  const beyond = Math.max(0, Math.abs(dev) - 0.35) / 0.15
  return Math.sign(dev) * Math.min(2, beyond)
}

export const technicalModel: PredictionModel<CryptoFeatures> = {
  id: 'crypto-technical',
  version: '1.0.0',
  outcomeKeys: ['up', 'down'],
  run(f) {
    const maPosition = f.priceVsSma50 ?? f.priceVsSma20

    const terms: LogisticTerm[] = [
      {
        id: 'rsi-extremity',
        label: 'RSI extremity (mean reversion)',
        // Negative sign: overbought extremity leans DOWN, oversold leans UP.
        score: f.rsi === null ? null : -W_RSI * rsiExtremity(f.rsi),
        detail: f.rsi === null ? null : `RSI(14) = ${f.rsi.toFixed(1)}`,
        evidenceStrength: 0.8,
      },
      {
        id: 'macd-histogram',
        label: 'MACD histogram vs ATR',
        score:
          f.macdHistogramAtr === null ? null : W_MACD * squash(f.macdHistogramAtr, MACD_SCALE),
        detail:
          f.macdHistogramAtr === null
            ? null
            : `histogram = ${f.macdHistogramAtr.toFixed(3)} ATR`,
        evidenceStrength: 0.8,
      },
      {
        id: 'percent-b',
        label: 'Bollinger %B extremity (mean reversion)',
        score: f.percentB === null ? null : -W_PERCENT_B * percentBExtremity(f.percentB),
        detail: f.percentB === null ? null : `%B = ${f.percentB.toFixed(2)}`,
        evidenceStrength: 0.7,
      },
      {
        id: 'ma-position',
        label: 'Price vs slow moving average',
        score: maPosition === null ? null : W_MA_POSITION * squash(maPosition, MA_SCALE),
        detail: maPosition === null ? null : `price ${(maPosition * 100).toFixed(2)}% from SMA`,
        evidenceStrength: 0.75,
      },
    ]

    return runLogisticModel({
      modelId: this.id,
      version: this.version,
      terms,
      baseConfidence: 0.7,
      minDefinedTerms: 2,
      abstainReason: 'insufficient indicator features (need at least 2 of RSI/MACD/%B/MA)',
    })
  },
}
