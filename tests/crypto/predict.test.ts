import { describe, expect, it } from 'vitest'

import { fixedClock } from '@/core/clock'
import { applyIsotonic, type IsotonicCalibrator } from '@/core/metrics/calibration'
import { assertValidPrediction } from '@/core/prediction/builder'
import type { SourceRef, Timeframe } from '@/core/prediction/types'
import type { DatasetQuality } from '@/core/quality/data-quality'
import { buildCryptoFeatures, TIMEFRAME_SPECS } from '@/engines/crypto/features'
import {
  buildScenarios,
  erf,
  normalCdf,
  normalQuantile,
  predictAllTimeframes,
  predictCrypto,
} from '@/engines/crypto/predict'

import { makeBook, nullFeatures, randomWalkCandles } from './fixtures'

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

const HOUR = 3_600_000
const CANDLE_COUNT = 260
// Fixture candles open at index·HOUR from epoch (see fixtures.makeCandle), so
// "now" is pinned just after the last close for coherent freshness.
const NOW = CANDLE_COUNT * HOUR + 1_000
const clock = fixedClock(NOW)
const asOf = new Date(NOW - 60_000).toISOString()

function idFactory(): () => string {
  let i = 0
  return () => `pred-${++i}`
}

function liveDatasets(): DatasetQuality[] {
  return ['crypto.candles', 'crypto.orderbook', 'crypto.market', 'crypto.derivatives'].map(
    (capability) => ({
      capability,
      dataAsOf: asOf,
      maxAgeMs: HOUR,
      completeness: 1,
      sourceCount: 1,
      reliability: 'HIGH_RELIABILITY',
      disagreement: null,
      isDemo: false,
    }),
  )
}

function sources(isDemo: boolean): SourceRef[] {
  return ['crypto.candles', 'crypto.orderbook', 'crypto.market', 'crypto.derivatives'].map(
    (capability) => ({
      providerId: isDemo ? 'demo-crypto' : 'binance',
      capability,
      reliability: 'HIGH_RELIABILITY',
      fetchedAt: asOf,
      dataAsOf: asOf,
      isDemo,
    }),
  )
}

const candles = randomWalkCandles(CANDLE_COUNT, { seed: 99, start: 100, withTaker: true })
const book = makeBook(
  [
    [99.9, 8],
    [99.8, 6],
    [99.7, 5],
    [99.6, 5],
    [99.5, 4],
  ],
  [
    [100.1, 5],
    [100.2, 6],
    [100.3, 5],
    [100.4, 4],
    [100.5, 4],
  ],
)
const derivatives = {
  symbol: 'BTCUSDT',
  fundingRate: 1.5e-4,
  nextFundingTime: null,
  openInterest: 10_000,
  openInterestValue: 1e9,
  timestamp: NOW - 60_000,
}
const market = {
  symbol: 'BTCUSDT',
  price: 100,
  change24hPct: 0.8,
  high24h: 102,
  low24h: 98,
  volume24h: 5e6,
  quoteVolume24h: 5e8,
  marketCap: null,
  timestamp: NOW - 60_000,
}

const features = buildCryptoFeatures({
  candles,
  book,
  derivatives,
  market,
  timeframe: '1h',
  nowMs: NOW,
})

function basePredictParams() {
  return {
    symbol: 'BTCUSDT',
    features,
    skills: [],
    datasets: liveDatasets(),
    sources: sources(false),
    timeframe: '1h' as Timeframe,
    clock,
    predictionIdFactory: idFactory(),
    calibrator: null,
  }
}

// ---------------------------------------------------------------------------
// Normal helpers
// ---------------------------------------------------------------------------

describe('normal distribution helpers', () => {
  it('erf matches reference values', () => {
    expect(erf(0)).toBeCloseTo(0, 7)
    expect(erf(1)).toBeCloseTo(0.8427007929, 6)
    expect(erf(-1)).toBeCloseTo(-0.8427007929, 6)
    expect(erf(2)).toBeCloseTo(0.995322265, 6)
  })

  it('normalCdf matches the standard normal table', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 9)
    expect(normalCdf(1.645)).toBeCloseTo(0.95, 3)
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3)
  })

  it('normalQuantile inverts normalCdf', () => {
    for (const p of [0.01, 0.1, 0.25, 0.5, 0.6, 0.75, 0.9, 0.99]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 6)
    }
  })
})

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('buildScenarios', () => {
  it('produces probabilities that sum to exactly 1, in bull/base/bear order', () => {
    const s = buildScenarios({ pUp: 0.62, horizonSigma: 0.04, spot: 100 })
    expect(s).not.toBeNull()
    if (s === null) return
    expect(s.map((x) => x.key)).toEqual(['bull', 'base', 'bear'])
    expect(s.reduce((a, x) => a + x.probability, 0)).toBeCloseTo(1, 12)
  })

  it('bands tile the price axis in order without gaps', () => {
    const s = buildScenarios({ pUp: 0.55, horizonSigma: 0.05, spot: 200 })
    if (s === null) throw new Error('expected scenarios')
    const bull = s[0]
    const base = s[1]
    const bear = s[2]
    if (bull === undefined || base === undefined || bear === undefined) throw new Error('missing band')
    expect(bear.targetLow).toBeLessThan(bear.targetHigh)
    expect(bear.targetHigh).toBeCloseTo(base.targetLow, 9)
    expect(base.targetHigh).toBeCloseTo(bull.targetLow, 9)
    expect(bull.targetLow).toBeLessThan(bull.targetHigh)
    // Base band brackets spot.
    expect(base.targetLow).toBeLessThan(200)
    expect(base.targetHigh).toBeGreaterThan(200)
  })

  it('is internally consistent with the directional probability by design', () => {
    // With mu = sigma·Φ⁻¹(pUp), P(R > 0) must equal pUp. Verify numerically:
    // P(R > 0) = 1 − Φ(−mu/sigma) = Φ(q).
    for (const p of [0.3, 0.5, 0.65, 0.8]) {
      const q = normalQuantile(p)
      expect(1 - normalCdf(-q)).toBeCloseTo(p, 6)
      // And the band probabilities respect the tilt: bull > bear iff p > 0.5.
      const s = buildScenarios({ pUp: p, horizonSigma: 0.04, spot: 100 })
      if (s === null) throw new Error('expected scenarios')
      const bullP = s[0]?.probability ?? 0
      const bearP = s[2]?.probability ?? 0
      if (p > 0.5) expect(bullP).toBeGreaterThan(bearP)
      if (p < 0.5) expect(bullP).toBeLessThan(bearP)
      if (p === 0.5) expect(bullP).toBeCloseTo(bearP, 9)
    }
  })

  it('returns null rather than fabricating bands without a sigma or spot', () => {
    expect(buildScenarios({ pUp: 0.6, horizonSigma: 0, spot: 100 })).toBeNull()
    expect(buildScenarios({ pUp: 0.6, horizonSigma: 0.04, spot: 0 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// predictCrypto
// ---------------------------------------------------------------------------

describe('predictCrypto', () => {
  it('produces a valid VixeraPrediction end to end', () => {
    const p = predictCrypto(basePredictParams())
    expect(() => assertValidPrediction(p)).not.toThrow()
    expect(p.domain).toBe('crypto')
    expect(p.subject).toBe('BTCUSDT')
    expect(p.timeframe).toBe('1h')
    expect(p.outcomes.map((o) => o.key)).toEqual(['up', 'down'])
    expect(p.dataMode).toBe('live')
    expect(p.modelOutputs).toHaveLength(7)
    expect(p.confidence).toBeGreaterThan(0)
    expect(p.confidence).toBeLessThanOrEqual(1)
  })

  it('emits scenarios summing to 1 with ordered bands, and a volatility forecast', () => {
    const p = predictCrypto(basePredictParams())
    expect(p.scenarios).not.toBeNull()
    expect(p.volatility).not.toBeNull()
    if (p.scenarios === null) return
    expect(p.scenarios.reduce((a, s) => a + s.probability, 0)).toBeCloseTo(1, 9)
    const byKey = new Map(p.scenarios.map((s) => [s.key, s]))
    const bull = byKey.get('bull')
    const base = byKey.get('base')
    const bear = byKey.get('bear')
    if (bull === undefined || base === undefined || bear === undefined) throw new Error('missing band')
    expect(bear.targetHigh).toBeCloseTo(base.targetLow, 9)
    expect(base.targetHigh).toBeCloseTo(bull.targetLow, 9)
  })

  it('collapses to uniform outcomes with tiny confidence when every model abstains', () => {
    const p = predictCrypto({
      ...basePredictParams(),
      features: nullFeatures({ timeframe: '1h', nowMs: NOW }),
    })
    expect(() => assertValidPrediction(p)).not.toThrow()
    expect(p.outcomes[0]?.probability).toBeCloseTo(0.5, 9)
    expect(p.outcomes[1]?.probability).toBeCloseTo(0.5, 9)
    expect(p.confidence).toBeLessThanOrEqual(0.05)
    expect(p.modelAgreement).toBe(0)
    expect(p.modelOutputs.every((m) => m.abstained)).toBe(true)
    expect(p.scenarios).toBeNull()
    expect(p.volatility).toBeNull()
  })

  it('applies the calibrator when usable', () => {
    // A synthetic isotonic curve — linear between knots, p → p − 0.05 over
    // [0.2, 1.0] — which maps 0.6 → 0.55.
    const calibrator: IsotonicCalibrator = {
      kind: 'isotonic',
      x: [0.2, 1.0],
      y: [0.15, 0.95],
      sampleSize: 1_000,
    }
    // Sanity-check the synthetic curve itself: 0.6 → 0.55.
    expect(applyIsotonic(calibrator, 0.6)).toBeCloseTo(0.55, 9)

    const raw = predictCrypto(basePredictParams())
    const calibrated = predictCrypto({ ...basePredictParams(), calibrator })

    const rawUp = raw.outcomes.find((o) => o.key === 'up')?.probability ?? Number.NaN
    const calUp = calibrated.outcomes.find((o) => o.key === 'up')?.probability ?? Number.NaN
    expect(calUp).toBeCloseTo(applyIsotonic(calibrator, rawUp), 9)
    expect(calUp).not.toBeCloseTo(rawUp, 9)
  })

  it('flags an uncalibrated prediction with a note factor, removed when calibrated', () => {
    const uncal = predictCrypto(basePredictParams())
    const allFactors = [...uncal.supportingFactors, ...uncal.opposingFactors]
    const note = allFactors.find((f) => f.id === 'uncalibrated')
    expect(note).toBeDefined()
    expect(note?.contribution).toBeNull()

    const calibrator: IsotonicCalibrator = {
      kind: 'isotonic',
      x: [0, 1],
      y: [0.02, 0.98],
      sampleSize: 800,
    }
    const cal = predictCrypto({ ...basePredictParams(), calibrator })
    const calFactors = [...cal.supportingFactors, ...cal.opposingFactors]
    expect(calFactors.find((f) => f.id === 'uncalibrated')).toBeUndefined()
  })

  it('refuses to apply a calibrator below the sample threshold', () => {
    const thin: IsotonicCalibrator = { kind: 'isotonic', x: [0, 1], y: [0.2, 0.8], sampleSize: 50 }
    const p = predictCrypto({ ...basePredictParams(), calibrator: thin })
    const raw = predictCrypto(basePredictParams())
    expect(p.outcomes[0]?.probability).toBeCloseTo(raw.outcomes[0]?.probability ?? Number.NaN, 12)
    const note = [...p.supportingFactors, ...p.opposingFactors].find((f) => f.id === 'uncalibrated')
    expect(note).toBeDefined()
  })

  it('stamps dataMode demo when any source is a demo provider', () => {
    const p = predictCrypto({ ...basePredictParams(), sources: sources(true) })
    expect(p.dataMode).toBe('demo')
  })

  it('carries real model contributions into the prediction factors', () => {
    const p = predictCrypto(basePredictParams())
    const numeric = [...p.supportingFactors, ...p.opposingFactors].filter(
      (f) => f.contribution !== null,
    )
    expect(numeric.length).toBeGreaterThan(0)
    // Every numeric factor traces back to a model via its namespaced id.
    for (const f of numeric) {
      expect(f.id).toMatch(/^crypto-[a-z-]+:/)
    }
  })
})

// ---------------------------------------------------------------------------
// predictAllTimeframes
// ---------------------------------------------------------------------------

describe('predictAllTimeframes', () => {
  it('predicts exactly the timeframes whose candle interval was supplied', () => {
    const daily = randomWalkCandles(220, { seed: 7, start: 100, withTaker: true })
    const out = predictAllTimeframes({
      symbol: 'BTCUSDT',
      candlesByInterval: { '1h': candles, '1d': daily },
      book,
      derivatives,
      market,
      skills: [],
      datasets: liveDatasets(),
      sources: sources(false),
      clock,
      predictionIdFactory: idFactory(),
    })

    // 1h candles serve the 1h and 24h timeframes; 1d serves 30d. 15m/4h/7d
    // intervals were not supplied, so those timeframes are absent — never
    // predicted from mismatched candles (timeframes are not mixed).
    expect(Object.keys(out).sort()).toEqual(['1h', '24h', '30d'].sort())
    expect(out['1h']?.timeframe).toBe('1h')
    expect(out['24h']?.timeframe).toBe('24h')
    expect(out['30d']?.timeframe).toBe('30d')
    for (const p of Object.values(out)) {
      expect(() => assertValidPrediction(p)).not.toThrow()
    }
  })

  it('scales the volatility horizon with the timeframe (24h wider than 1h)', () => {
    const out = predictAllTimeframes({
      symbol: 'BTCUSDT',
      candlesByInterval: { '1h': candles },
      book,
      derivatives,
      market,
      skills: [],
      datasets: liveDatasets(),
      sources: sources(false),
      clock,
      predictionIdFactory: idFactory(),
    })
    const oneHour = out['1h']?.volatility?.expectedMove
    const day = out['24h']?.volatility?.expectedMove
    if (oneHour === undefined || day === undefined) throw new Error('expected volatility forecasts')
    expect(day).toBeGreaterThan(oneHour)
    // √24 ≈ 4.9× under sqrt-of-time scaling of the same per-candle sigma.
    expect(day / oneHour).toBeCloseTo(Math.sqrt(24), 5)
  })

  it('the timeframe spec table covers all six crypto timeframes', () => {
    for (const tf of ['15m', '1h', '4h', '24h', '7d', '30d'] as const) {
      expect(TIMEFRAME_SPECS[tf]).toBeDefined()
    }
  })
})
