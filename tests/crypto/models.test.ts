import { describe, expect, it } from 'vitest'

import { logit } from '@/core/prediction/probability'
import type { ModelOutput } from '@/core/prediction/types'
import { buildCryptoFeatures } from '@/engines/crypto/features'
import {
  CRYPTO_MODELS,
  derivativesModel,
  meanReversionModel,
  momentumModel,
  orderflowModel,
  structureModel,
  technicalModel,
  volatilityRegimeModel,
} from '@/engines/crypto/models'
import type { ModelContext } from '@/engines/model'

import { makeBook, nullFeatures, randomWalkCandles } from './fixtures'

const ctx: ModelContext = { nowMs: 1_700_000_000_000, runId: 'test-run' }

function pUp(out: ModelOutput): number {
  const up = out.outcomes.find((o) => o.key === 'up')
  expect(up).toBeDefined()
  return up?.probability ?? Number.NaN
}

/** Shared invariants for any non-abstained binary output. */
function expectValidOutput(out: ModelOutput): void {
  expect(out.abstained).toBe(false)
  const up = pUp(out)
  const down = out.outcomes.find((o) => o.key === 'down')?.probability ?? Number.NaN
  expect(up).toBeGreaterThan(0)
  expect(up).toBeLessThan(1)
  expect(up + down).toBeCloseTo(1, 9)
  expect(out.confidence).toBeGreaterThanOrEqual(0)
  expect(out.confidence).toBeLessThanOrEqual(1)
}

/** Contributions must sum to the emitted tilt — computed, not invented. */
function expectContributionsMatchTilt(out: ModelOutput): void {
  const tilt = pUp(out) - 0.5
  let sum = 0
  for (const f of out.featureContributions) {
    expect(f.contribution).not.toBeNull()
    sum += f.contribution ?? 0
  }
  expect(sum).toBeCloseTo(tilt, 9)
}

// ---------------------------------------------------------------------------
// Technical
// ---------------------------------------------------------------------------

describe('technicalModel', () => {
  it('abstains on an empty feature set', () => {
    const out = technicalModel.run(nullFeatures(), ctx)
    expect(out.abstained).toBe(true)
    expect(out.weight).toBe(0)
  })

  it('leans up on an oversold, upward-momentum feature set', () => {
    const out = technicalModel.run(
      nullFeatures({
        rsi: 22, // deeply oversold → mean-reversion up
        macdHistogramAtr: 0.6,
        percentB: 0.02, // pinned to the lower band → reversion up
        priceVsSma50: 0.04,
      }),
      ctx,
    )
    expectValidOutput(out)
    expect(pUp(out)).toBeGreaterThan(0.6)
    expectContributionsMatchTilt(out)
  })

  it('leans down on the mirrored bearish set', () => {
    const out = technicalModel.run(
      nullFeatures({
        rsi: 78,
        macdHistogramAtr: -0.6,
        percentB: 0.98,
        priceVsSma50: -0.04,
      }),
      ctx,
    )
    expectValidOutput(out)
    expect(pUp(out)).toBeLessThan(0.4)
    expectContributionsMatchTilt(out)
  })

  it('scores mid-band RSI as zero (feature, not a rule that half-fires)', () => {
    const out = technicalModel.run(nullFeatures({ rsi: 55, macdHistogramAtr: 0 }), ctx)
    expectValidOutput(out)
    expect(pUp(out)).toBeCloseTo(0.5, 9)
  })
})

// ---------------------------------------------------------------------------
// Momentum
// ---------------------------------------------------------------------------

describe('momentumModel', () => {
  it('abstains without return or OBV features', () => {
    expect(momentumModel.run(nullFeatures(), ctx).abstained).toBe(true)
  })

  it('follows positive multi-window returns up', () => {
    const out = momentumModel.run(
      nullFeatures({ ret5: 0.03, ret20: 0.08, obvSlope: 0.5, adx: 35, realisedVol: 0.01 }),
      ctx,
    )
    expectValidOutput(out)
    expect(pUp(out)).toBeGreaterThan(0.6)
    expectContributionsMatchTilt(out)
  })

  it('follows negative returns down', () => {
    const out = momentumModel.run(
      nullFeatures({ ret5: -0.03, ret20: -0.08, obvSlope: -0.5, adx: 35, realisedVol: 0.01 }),
      ctx,
    )
    expectValidOutput(out)
    expect(pUp(out)).toBeLessThan(0.4)
  })

  it('trusts the same returns less when ADX says there is no trend', () => {
    const base = { ret5: 0.03, ret20: 0.08, obvSlope: null, realisedVol: 0.01 }
    const trending = momentumModel.run(nullFeatures({ ...base, adx: 40 }), ctx)
    const choppy = momentumModel.run(nullFeatures({ ...base, adx: 10 }), ctx)
    expect(pUp(trending)).toBeGreaterThan(pUp(choppy))
    expect(pUp(choppy)).toBeGreaterThan(0.5) // gated down, not inverted
  })
})

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('structureModel', () => {
  it('abstains without structure features', () => {
    expect(structureModel.run(nullFeatures(), ctx).abstained).toBe(true)
  })

  it('leans up on HH-HL structure with a confirmed breakout above support', () => {
    const out = structureModel.run(
      nullFeatures({
        trendStructure: { pattern: 'HH-HL', strength: 0.8, lastSwingHigh: null, lastSwingLow: null },
        nearestSupport: { distanceAtr: 0.5, strength: 0.8, price: 99 },
        breakout: { type: 'breakout', level: null, confirmedByVolume: true, strength: 0.7 },
      }),
      ctx,
    )
    expectValidOutput(out)
    expect(pUp(out)).toBeGreaterThan(0.65)
    expectContributionsMatchTilt(out)
  })

  it('leans down near strong resistance in a LH-LL structure', () => {
    const out = structureModel.run(
      nullFeatures({
        trendStructure: { pattern: 'LH-LL', strength: 0.8, lastSwingHigh: null, lastSwingLow: null },
        nearestResistance: { distanceAtr: 0.4, strength: 0.9, price: 101 },
      }),
      ctx,
    )
    expectValidOutput(out)
    expect(pUp(out)).toBeLessThan(0.4)
  })

  it('reads a rejection at resistance as a down-lean', () => {
    const out = structureModel.run(
      nullFeatures({
        breakout: {
          type: 'rejection',
          level: { price: 105, strength: 0.8, type: 'resistance', touches: 4, lastTouchIndex: 90 },
          confirmedByVolume: false,
          strength: 0.6,
        },
      }),
      ctx,
    )
    expectValidOutput(out)
    expect(pUp(out)).toBeLessThan(0.5)
  })
})

// ---------------------------------------------------------------------------
// Order flow
// ---------------------------------------------------------------------------

describe('orderflowModel', () => {
  it('MUST abstain when aggressor flow is null AND the book is absent', () => {
    const out = orderflowModel.run(
      // Other features present — the abstention is about order-flow inputs
      // specifically, not about the feature set being empty.
      nullFeatures({ rsi: 30, ret5: 0.01, fundingRate: 1e-4 }),
      ctx,
    )
    expect(out.abstained).toBe(true)
  })

  it('follows executed aggressor imbalance', () => {
    const bull = orderflowModel.run(
      nullFeatures({ aggressorImbalance: 0.5, aggressorCoverage: 1 }),
      ctx,
    )
    const bear = orderflowModel.run(
      nullFeatures({ aggressorImbalance: -0.5, aggressorCoverage: 1 }),
      ctx,
    )
    expectValidOutput(bull)
    expect(pUp(bull)).toBeGreaterThan(0.55)
    expect(pUp(bear)).toBeLessThan(0.45)
    expectContributionsMatchTilt(bull)
  })

  it('weights resting-book evidence at ~1/3 of executed-flow evidence', () => {
    const aggOnly = orderflowModel.run(
      nullFeatures({ aggressorImbalance: 0.9, aggressorCoverage: 1 }),
      ctx,
    )
    const bookOnly = orderflowModel.run(nullFeatures({ bookImbalance: 0.9 }), ctx)
    expectValidOutput(bookOnly)
    // Compare in log-odds, where the weights actually live.
    expect(logit(pUp(aggOnly)) / logit(pUp(bookOnly))).toBeCloseTo(3, 5)
    // And a book-only run is a low-confidence run.
    expect(bookOnly.confidence).toBeLessThan(aggOnly.confidence)
  })

  it('scales aggressor evidence by its coverage', () => {
    const full = orderflowModel.run(
      nullFeatures({ aggressorImbalance: 0.6, aggressorCoverage: 1 }),
      ctx,
    )
    const partial = orderflowModel.run(
      nullFeatures({ aggressorImbalance: 0.6, aggressorCoverage: 0.3 }),
      ctx,
    )
    expect(pUp(full)).toBeGreaterThan(pUp(partial))
    expect(pUp(partial)).toBeGreaterThan(0.5)
  })
})

// ---------------------------------------------------------------------------
// Derivatives
// ---------------------------------------------------------------------------

describe('derivativesModel', () => {
  it('abstains without derivatives data', () => {
    const out = derivativesModel.run(nullFeatures({ rsi: 40, bookImbalance: 0.2 }), ctx)
    expect(out.abstained).toBe(true)
  })

  it('reads very positive funding as CONTRARIAN bearish (crowded longs)', () => {
    const out = derivativesModel.run(nullFeatures({ fundingRate: 1e-3 }), ctx)
    expectValidOutput(out)
    expect(pUp(out)).toBeLessThan(0.4)
    expectContributionsMatchTilt(out)
  })

  it('reads very negative funding as contrarian bullish', () => {
    const out = derivativesModel.run(nullFeatures({ fundingRate: -1e-3 }), ctx)
    expectValidOutput(out)
    expect(pUp(out)).toBeGreaterThan(0.6)
  })

  it('amplifies the funding lean when open interest is crowded', () => {
    const thin = derivativesModel.run(
      nullFeatures({ fundingRate: 8e-4, oiToVolume24h: 0.1 }),
      ctx,
    )
    const crowded = derivativesModel.run(
      nullFeatures({ fundingRate: 8e-4, oiToVolume24h: 2.0 }),
      ctx,
    )
    expect(pUp(crowded)).toBeLessThan(pUp(thin)) // same direction, stronger
  })
})

// ---------------------------------------------------------------------------
// Volatility regime
// ---------------------------------------------------------------------------

describe('volatilityRegimeModel', () => {
  it('abstains when the regime is unknown', () => {
    expect(volatilityRegimeModel.run(nullFeatures(), ctx).abstained).toBe(true)
  })

  it('is direction-neutral: exactly 50/50 in every regime', () => {
    for (const regime of ['low', 'normal', 'elevated', 'extreme'] as const) {
      const out = volatilityRegimeModel.run(nullFeatures({ volRegime: regime }), ctx)
      expectValidOutput(out)
      expect(pUp(out)).toBe(0.5)
    }
  })

  it('collapses its confidence in an extreme regime — its drag-anchor role', () => {
    const normal = volatilityRegimeModel.run(nullFeatures({ volRegime: 'normal' }), ctx)
    const extreme = volatilityRegimeModel.run(nullFeatures({ volRegime: 'extreme' }), ctx)
    expect(extreme.confidence).toBeLessThanOrEqual(0.1)
    expect(normal.confidence).toBeGreaterThan(0.5)
  })

  it('emits a real zero contribution, not an invented number', () => {
    const out = volatilityRegimeModel.run(nullFeatures({ volRegime: 'extreme' }), ctx)
    expect(out.featureContributions).toHaveLength(1)
    expect(out.featureContributions[0]?.contribution).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Mean reversion
// ---------------------------------------------------------------------------

describe('meanReversionModel', () => {
  it('abstains without its features', () => {
    expect(meanReversionModel.run(nullFeatures(), ctx).abstained).toBe(true)
  })

  it('abstains in a strongly trending market rather than fading the trend', () => {
    const out = meanReversionModel.run(
      nullFeatures({
        priceZScore: 2.5, // looks like a juicy short...
        percentB: 1.1,
        trendStructure: { pattern: 'HH-HL', strength: 0.8, lastSwingHigh: null, lastSwingLow: null },
      }),
      ctx,
    )
    expect(out.abstained).toBe(true)
    expect(out.abstainReason).toMatch(/trend/i)
  })

  it('fades an upward stretch in a ranging market', () => {
    const out = meanReversionModel.run(
      nullFeatures({
        priceZScore: 2.5,
        percentB: 1.05,
        consolidationScore: 0.8,
        trendStructure: { pattern: 'ranging', strength: 0.7, lastSwingHigh: null, lastSwingLow: null },
      }),
      ctx,
    )
    expectValidOutput(out)
    expect(pUp(out)).toBeLessThan(0.4)
    expectContributionsMatchTilt(out)
  })

  it('fades a downward stretch upward', () => {
    const out = meanReversionModel.run(
      nullFeatures({ priceZScore: -2.5, percentB: -0.05, consolidationScore: 0.8 }),
      ctx,
    )
    expectValidOutput(out)
    expect(pUp(out)).toBeGreaterThan(0.6)
  })

  it('bets smaller when the market shows no consolidation', () => {
    const ranging = meanReversionModel.run(
      nullFeatures({ priceZScore: 2, consolidationScore: 0.9 }),
      ctx,
    )
    const drifting = meanReversionModel.run(
      nullFeatures({ priceZScore: 2, consolidationScore: 0 }),
      ctx,
    )
    expect(Math.abs(pUp(drifting) - 0.5)).toBeLessThan(Math.abs(pUp(ranging) - 0.5))
  })
})

// ---------------------------------------------------------------------------
// Whole pool against real (seeded) features
// ---------------------------------------------------------------------------

describe('model pool on features built from seeded candles', () => {
  const candles = randomWalkCandles(260, { seed: 1234, start: 100, withTaker: true })
  const features = buildCryptoFeatures({
    candles,
    book: makeBook(
      [
        [99.9, 8],
        [99.8, 6],
        [99.7, 5],
        [99.6, 5],
        [99.5, 4],
        [99.4, 4],
      ],
      [
        [100.1, 5],
        [100.2, 6],
        [100.3, 5],
        [100.4, 4],
        [100.5, 4],
        [100.6, 3],
      ],
    ),
    derivatives: {
      symbol: 'BTCUSDT',
      fundingRate: 2e-4,
      nextFundingTime: null,
      openInterest: 10_000,
      openInterestValue: 1e9,
      timestamp: 1_700_000_000_000,
    },
    market: {
      symbol: 'BTCUSDT',
      price: 100,
      change24hPct: 1.2,
      high24h: 102,
      low24h: 98,
      volume24h: 5e6,
      quoteVolume24h: 5e8,
      marketCap: null,
      timestamp: 1_700_000_000_000,
    },
    timeframe: '1h',
    nowMs: 1_700_000_000_000,
  })

  it('every model either abstains or emits a valid distribution', () => {
    for (const model of CRYPTO_MODELS) {
      const out = model.run(features, ctx)
      expect(out.modelId).toBe(model.id)
      expect(out.outcomes.map((o) => o.key)).toEqual(['up', 'down'])
      if (out.abstained) {
        expect(out.weight).toBe(0)
      } else {
        expectValidOutput(out)
        // Contributions of every live model must be real, signed numbers that
        // sum to its tilt (the volatility-regime model's zero included).
        const tilt = pUp(out) - 0.5
        const sum = out.featureContributions.reduce((a, f) => a + (f.contribution ?? 0), 0)
        expect(sum).toBeCloseTo(tilt, 9)
      }
    }
  })

  it('models with full data available do not abstain on this fixture', () => {
    // The fixture has candles, book, taker volume and derivatives, so at
    // minimum technical, momentum, orderflow, derivatives and the regime
    // model must run. (Mean reversion may legitimately abstain on trend.)
    for (const model of [technicalModel, momentumModel, orderflowModel, derivativesModel, volatilityRegimeModel]) {
      expect(model.run(features, ctx).abstained).toBe(false)
    }
  })
})
