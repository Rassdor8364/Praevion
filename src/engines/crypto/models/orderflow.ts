/**
 * Order-flow model — executed aggressor flow first, resting book a distant
 * second.
 *
 * The weighting here implements the rule from the header of
 * engines/crypto/orderflow.ts, and it is the whole point of this model:
 * RESTING ORDERS ARE NOT COMMITMENTS. A limit order is a free option to
 * trade, cancellable in microseconds; spoofing and layering are routine on
 * crypto venues, and a displayed "wall" is at least as likely to be an
 * attempt to move you as it is to be real demand. Executed flow is different
 * in kind — a trade that printed is a commitment someone paid the spread to
 * make and cannot cancel.
 *
 * Hence the weights: resting-book evidence (depth imbalance, walls) carries
 * roughly ONE THIRD of the weight of executed-flow evidence (aggressor
 * imbalance), and the aggressor term is additionally scaled by its coverage —
 * a window where only 40% of candles reported taker volume is 40% of the
 * evidence.
 *
 * ABSTENTION: this model MUST abstain when aggressor imbalance is null AND
 * the book is absent — with neither executed nor resting flow there is no
 * order-flow evidence at all, and per the house rule that is an abstention,
 * not a 50% vote. With only the book present it still runs, at the reduced
 * book weight and reduced confidence, because weak evidence honestly labelled
 * is still evidence.
 */

import type { PredictionModel } from '@/engines/model'
import type { CryptoFeatures } from '../features'
import { runLogisticModel, type LogisticTerm } from './shared'
import { UP_DOWN_KEYS } from './shared'
import { abstain } from '@/engines/model'

// -- documented weights -------------------------------------------------------
/** Executed aggressor imbalance — the dominant term. */
export const W_AGGRESSOR = 1.2
/** Resting-book depth imbalance: ~1/3 of executed flow, per the spoofing
 *  rationale above. */
export const W_BOOK = W_AGGRESSOR / 3
/** Walls: the most fakeable book feature of all gets the smallest weight. */
export const W_WALL = 0.2

/** Walls further than this fraction from mid exert no pressure. */
const WALL_RANGE_PCT = 0.02
/** A wall 10× the local median level size saturates the wall term. */
const WALL_SATURATION_MULTIPLE = 10

function wallScore(f: CryptoFeatures): number | null {
  // Wall features are only meaningful when we know the book was present at
  // all; bookImbalance non-null is the marker for that. A present book with
  // no walls is a real, computed answer: zero wall pressure.
  if (f.bookImbalance === null) return null
  let score = 0
  if (f.nearestBidWall !== null && f.nearestBidWall.distancePct < WALL_RANGE_PCT) {
    const size = Math.min(1, f.nearestBidWall.multiple / WALL_SATURATION_MULTIPLE)
    score += W_WALL * size * (1 - f.nearestBidWall.distancePct / WALL_RANGE_PCT)
  }
  if (f.nearestAskWall !== null && f.nearestAskWall.distancePct < WALL_RANGE_PCT) {
    const size = Math.min(1, f.nearestAskWall.multiple / WALL_SATURATION_MULTIPLE)
    score -= W_WALL * size * (1 - f.nearestAskWall.distancePct / WALL_RANGE_PCT)
  }
  return score
}

export const orderflowModel: PredictionModel<CryptoFeatures> = {
  id: 'crypto-orderflow',
  version: '1.0.0',
  outcomeKeys: ['up', 'down'],
  run(f) {
    // The hard abstention condition: no executed flow AND no book.
    if (f.aggressorImbalance === null && f.bookImbalance === null) {
      return abstain(
        this.id,
        this.version,
        UP_DOWN_KEYS,
        'neither aggressor flow nor order book available',
      )
    }

    const coverage = f.aggressorCoverage ?? 1

    const terms: LogisticTerm[] = [
      {
        id: 'aggressor-imbalance',
        label: 'Executed aggressor imbalance',
        score:
          f.aggressorImbalance === null ? null : W_AGGRESSOR * f.aggressorImbalance * coverage,
        detail:
          f.aggressorImbalance === null
            ? null
            : `imbalance = ${f.aggressorImbalance.toFixed(3)}, coverage = ${coverage.toFixed(2)}`,
        // Executed flow is the highest-grade evidence in this model.
        evidenceStrength: 0.9 * coverage,
      },
      {
        id: 'book-imbalance',
        label: 'Resting depth imbalance',
        score: f.bookImbalance === null ? null : W_BOOK * f.bookImbalance,
        detail: f.bookImbalance === null ? null : `imbalance = ${f.bookImbalance.toFixed(3)}`,
        // Deliberately low: stated preference, trivially fakeable.
        evidenceStrength: 0.35,
      },
      {
        id: 'book-walls',
        label: 'Order book walls',
        score: wallScore(f),
        detail: describeWalls(f),
        evidenceStrength: 0.25,
      },
    ]

    // Confidence base is lower when we only have the book: a book-only view
    // is corroborating evidence with nothing to corroborate.
    const base = f.aggressorImbalance === null ? 0.3 : 0.7

    return runLogisticModel({
      modelId: this.id,
      version: this.version,
      terms,
      baseConfidence: base,
      minDefinedTerms: 1,
      abstainReason: 'neither aggressor flow nor order book available',
    })
  },
}

function describeWalls(f: CryptoFeatures): string | null {
  const parts: string[] = []
  if (f.nearestBidWall !== null) {
    parts.push(
      `bid wall ${(f.nearestBidWall.distancePct * 100).toFixed(2)}% below (${f.nearestBidWall.multiple.toFixed(1)}× median)`,
    )
  }
  if (f.nearestAskWall !== null) {
    parts.push(
      `ask wall ${(f.nearestAskWall.distancePct * 100).toFixed(2)}% above (${f.nearestAskWall.multiple.toFixed(1)}× median)`,
    )
  }
  return parts.length === 0 ? null : parts.join('; ')
}
