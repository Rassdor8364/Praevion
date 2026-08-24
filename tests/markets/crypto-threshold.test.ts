import { describe, expect, it } from 'vitest'

import {
  parseCryptoThreshold,
  rangeProbability,
  thresholdFromDerived,
  thresholdProbability,
} from '@/engines/markets/event-models/crypto-threshold'

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseCryptoThreshold', () => {
  it('parses "Will BTC exceed $150,000 by December 31?"', () => {
    const q = parseCryptoThreshold('Will BTC exceed $150,000 by December 31?', null)
    expect(q).toEqual({ symbol: 'BTC', op: 'above', strike: 150_000, deadline: 'December 31' })
  })

  it('parses "Bitcoin above $120k on Aug 15?"', () => {
    const q = parseCryptoThreshold('Bitcoin above $120k on Aug 15?', null)
    expect(q).toEqual({ symbol: 'BTC', op: 'above', strike: 120_000, deadline: 'Aug 15' })
  })

  it('parses "$ETH below $3,500 by Friday?"', () => {
    const q = parseCryptoThreshold('$ETH below $3,500 by Friday?', null)
    expect(q).toEqual({ symbol: 'ETH', op: 'below', strike: 3_500, deadline: 'Friday' })
  })

  it('handles the $150k / 150,000 / 150000 strike forms identically', () => {
    for (const form of ['$150k', '$150,000', '$150000', '150,000', '150000']) {
      const q = parseCryptoThreshold(`Will BTC exceed ${form}?`, null)
      expect(q?.strike).toBe(150_000)
    }
  })

  it('maps common names and tickers to the same symbol', () => {
    expect(parseCryptoThreshold('Will Bitcoin exceed $100k?', null)?.symbol).toBe('BTC')
    expect(parseCryptoThreshold('Will Ethereum drop below $2,000?', null)?.symbol).toBe('ETH')
    expect(parseCryptoThreshold('Solana above $500 by March?', null)?.symbol).toBe('SOL')
    expect(parseCryptoThreshold('Will Dogecoin reach $1.50 by 2027?', null)?.symbol).toBe('DOGE')
  })

  it('parses sub-dollar strikes for cheap assets', () => {
    const q = parseCryptoThreshold('Will DOGE close above $0.50 by Friday?', null)
    expect(q?.strike).toBe(0.5)
    expect(q?.op).toBe('above')
  })

  it('REJECTS a title naming two assets — ambiguous subject', () => {
    expect(parseCryptoThreshold('Will BTC or ETH exceed $100,000 by March?', null)).toBeNull()
  })

  it('REJECTS "Will BTC flip gold?" — no strike, no direction', () => {
    expect(parseCryptoThreshold('Will BTC flip gold?', null)).toBeNull()
  })

  it('rejects a title with two different strikes', () => {
    expect(
      parseCryptoThreshold('Will BTC trade above $100,000 or above $150,000?', null),
    ).toBeNull()
  })

  it('rejects a directionless price mention', () => {
    expect(parseCryptoThreshold('BTC at $150,000: what happens next?', null)).toBeNull()
  })

  it('rejects an unknown asset', () => {
    expect(parseCryptoThreshold('Will PEPE exceed $0.001 by June?', null)).toBeNull()
  })

  it('does not mistake dates for strikes', () => {
    // "31" and "2026" must not be parsed as prices.
    const q = parseCryptoThreshold('Will BTC exceed $150k by December 31, 2026?', null)
    expect(q?.strike).toBe(150_000)
  })

  it('falls back to the description only for the deadline, never the strike', () => {
    const q = parseCryptoThreshold(
      'Will SOL exceed $400?',
      'Resolves YES if SOL trades at or above $400 by March 31.',
    )
    expect(q?.strike).toBe(400)
    expect(q?.deadline).toBe('March 31')

    // A strike present only in the description is NOT a parse.
    expect(parseCryptoThreshold('Will SOL moon?', 'Above $400 counts.')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe('thresholdProbability', () => {
  it('prices spot = strike at exactly 0.5 (the zero-drift anchor)', () => {
    const p = thresholdProbability({
      spot: 100_000,
      strike: 100_000,
      op: 'above',
      annualVol: 0.55,
      yearsToDeadline: 0.5,
    })
    expect(p).toBeCloseTo(0.5, 9)
  })

  it('prices deep in-the-money near 1', () => {
    const p = thresholdProbability({
      spot: 118_000,
      strike: 10_000,
      op: 'above',
      annualVol: 0.55,
      yearsToDeadline: 0.25,
    })
    expect(p).not.toBeNull()
    expect(p ?? 0).toBeGreaterThan(0.99)
  })

  it('is monotone decreasing in the strike for "above"', () => {
    const strikes = [90_000, 110_000, 130_000, 150_000, 200_000]
    const probs = strikes.map(
      (strike) =>
        thresholdProbability({
          spot: 118_000,
          strike,
          op: 'above',
          annualVol: 0.55,
          yearsToDeadline: 0.38,
        }) ?? Number.NaN,
    )
    for (let i = 1; i < probs.length; i++) {
      expect(probs[i] ?? Number.NaN).toBeLessThan(probs[i - 1] ?? Number.NaN)
    }
  })

  it('"below" is the exact complement of "above"', () => {
    const shared = { spot: 118_000, strike: 130_000, annualVol: 0.6, yearsToDeadline: 0.3 }
    const above = thresholdProbability({ ...shared, op: 'above' }) ?? Number.NaN
    const below = thresholdProbability({ ...shared, op: 'below' }) ?? Number.NaN
    expect(above + below).toBeCloseTo(1, 12)
  })

  it('matches the hand-computed value for spot 118000, strike 150000, vol 0.55, T = 0.38y', () => {
    // Hand check:
    //   d = ln(118000/150000) / (0.55·√0.38)
    //     = ln(0.786667) / (0.55 · 0.616441)
    //     = −0.239951 / 0.339043 = −0.707733
    //   P = Φ(−0.707733) ≈ 0.23957
    const p = thresholdProbability({
      spot: 118_000,
      strike: 150_000,
      op: 'above',
      annualVol: 0.55,
      yearsToDeadline: 0.38,
    })
    expect(p).not.toBeNull()
    expect(p ?? 0).toBeCloseTo(0.2396, 3)
  })

  it('returns null for a deadline in the past', () => {
    expect(
      thresholdProbability({
        spot: 118_000,
        strike: 150_000,
        op: 'above',
        annualVol: 0.55,
        yearsToDeadline: -0.01,
      }),
    ).toBeNull()
  })

  it('steps toward 0/1 by spot vs strike inside the final hour', () => {
    const T = 1 / (24 * 365.25) / 2 // half an hour
    const base = { annualVol: 0.55, yearsToDeadline: T }
    expect(thresholdProbability({ ...base, spot: 118_000, strike: 100_000, op: 'above' })).toBe(1)
    expect(thresholdProbability({ ...base, spot: 118_000, strike: 150_000, op: 'above' })).toBe(0)
    expect(thresholdProbability({ ...base, spot: 118_000, strike: 150_000, op: 'below' })).toBe(1)
    expect(thresholdProbability({ ...base, spot: 100_000, strike: 100_000, op: 'above' })).toBe(0.5)
  })

  it('returns null for non-positive volatility or prices', () => {
    const base = { spot: 118_000, strike: 150_000, op: 'above' as const, yearsToDeadline: 0.38 }
    expect(thresholdProbability({ ...base, annualVol: 0 })).toBeNull()
    expect(thresholdProbability({ ...base, annualVol: -0.2 })).toBeNull()
    expect(
      thresholdProbability({ spot: 0, strike: 1, op: 'above', annualVol: 0.5, yearsToDeadline: 1 }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Structured thresholds
// ---------------------------------------------------------------------------

describe('thresholdFromDerived', () => {
  const times = { closeTime: '2026-08-13T21:00:00Z', resolutionTime: '2026-08-13T21:05:00Z' }

  it('builds a query from a floor-only derived block (Kalshi "or above")', () => {
    const q = thresholdFromDerived({
      derived: { underlyingSymbol: 'BTC', floorStrike: 73_249.99, capStrike: null },
      ...times,
    })
    expect(q).toEqual({
      symbol: 'BTC',
      floor: 73_249.99,
      cap: null,
      deadlineIso: '2026-08-13T21:05:00Z', // resolutionTime wins over closeTime
    })
  })

  it('carries both strikes for a range market and falls back to closeTime', () => {
    const q = thresholdFromDerived({
      derived: { underlyingSymbol: 'ETH', floorStrike: 2_500, capStrike: 2_599.99 },
      closeTime: '2026-08-13T21:00:00Z',
      resolutionTime: null,
    })
    expect(q?.floor).toBe(2_500)
    expect(q?.cap).toBe(2_599.99)
    expect(q?.deadlineIso).toBe('2026-08-13T21:00:00Z')
  })

  it('returns null without a recognised underlying — strikes alone are not coverage', () => {
    expect(
      thresholdFromDerived({
        derived: { underlyingSymbol: null, floorStrike: 88, capStrike: null }, // e.g. a temperature
        ...times,
      }),
    ).toBeNull()
  })

  it('returns null when derived is absent or has no usable strike', () => {
    expect(thresholdFromDerived({ ...times })).toBeNull()
    expect(thresholdFromDerived({ derived: null, ...times })).toBeNull()
    expect(
      thresholdFromDerived({
        derived: { underlyingSymbol: 'BTC', floorStrike: null, capStrike: null },
        ...times,
      }),
    ).toBeNull()
    expect(
      thresholdFromDerived({
        derived: { underlyingSymbol: 'BTC', floorStrike: -5, capStrike: null },
        ...times,
      }),
    ).toBeNull()
  })
})

describe('rangeProbability', () => {
  const base = { spot: 62_000, annualVol: 0.55, yearsToDeadline: 0.1 }

  it('floor only matches thresholdProbability "above" exactly', () => {
    const viaRange = rangeProbability({ ...base, floor: 70_000, cap: null })
    const direct = thresholdProbability({ ...base, strike: 70_000, op: 'above' })
    expect(viaRange).toBe(direct)
  })

  it('cap only matches thresholdProbability "below" exactly', () => {
    const viaRange = rangeProbability({ ...base, floor: null, cap: 55_000 })
    const direct = thresholdProbability({ ...base, strike: 55_000, op: 'below' })
    expect(viaRange).toBe(direct)
  })

  it('band identity: P(above floor) = P(band) + P(above cap), exactly', () => {
    // The subtraction claim in the docstring, asserted as the sum it implies.
    const floor = 60_000
    const cap = 64_000
    const pAboveFloor = thresholdProbability({ ...base, strike: floor, op: 'above' }) ?? Number.NaN
    const pAboveCap = thresholdProbability({ ...base, strike: cap, op: 'above' }) ?? Number.NaN
    const pBand = rangeProbability({ ...base, floor, cap }) ?? Number.NaN
    expect(pBand).toBeGreaterThan(0)
    expect(pBand + pAboveCap).toBeCloseTo(pAboveFloor, 12)
  })

  it('adjacent ladder bands tile the line: P(band A) + P(band B) = P(wide band)', () => {
    // Two adjacent Kalshi-style bands must sum to the band spanning both —
    // the property that makes a strike LADDER internally consistent.
    const a = rangeProbability({ ...base, floor: 60_000, cap: 62_000 }) ?? Number.NaN
    const b = rangeProbability({ ...base, floor: 62_000, cap: 64_000 }) ?? Number.NaN
    const wide = rangeProbability({ ...base, floor: 60_000, cap: 64_000 }) ?? Number.NaN
    expect(a + b).toBeCloseTo(wide, 12)
  })

  it('returns null for a degenerate band (cap <= floor)', () => {
    expect(rangeProbability({ ...base, floor: 64_000, cap: 60_000 })).toBeNull()
    expect(rangeProbability({ ...base, floor: 62_000, cap: 62_000 })).toBeNull()
  })

  it('returns null when both strikes are absent or inputs are broken', () => {
    expect(rangeProbability({ ...base, floor: null, cap: null })).toBeNull()
    expect(rangeProbability({ ...base, floor: 60_000, cap: 64_000, annualVol: 0 })).toBeNull()
    expect(rangeProbability({ ...base, floor: -1, cap: null })).toBeNull()
  })

  it('stays in [0,1] even for a razor-thin far-out band', () => {
    const p = rangeProbability({ ...base, floor: 200_000, cap: 200_000.01 })
    expect(p).not.toBeNull()
    expect(p ?? -1).toBeGreaterThanOrEqual(0)
    expect(p ?? 2).toBeLessThanOrEqual(1)
  })
})
