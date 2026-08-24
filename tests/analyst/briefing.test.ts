import { describe, expect, it } from 'vitest'

import { evaluateOpportunity } from '@/engines/markets/opportunity'
import {
  composeBriefing,
  hedgeLabel,
  hedgeTier,
  whatChanged,
  WATCH_LEAN_THRESHOLD,
  type AnalystBriefing,
  type BriefingInputs,
  type CryptoStateInput,
  type NewsClusterInput,
  type SportsFixtureInput,
} from '@/engines/analyst/briefing'
import { makeMarket, makeParams, NOW_MS } from '../markets/fixtures'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GENERATED_AT = new Date(NOW_MS).toISOString()
const HOUR_MS = 3_600_000

function makeCrypto(overrides: Partial<CryptoStateInput> = {}): CryptoStateInput {
  return {
    symbol: 'BTC',
    predictionId: 'BTCUSDT',
    timeframe: '24h',
    pUp: 0.58,
    confidence: 0.5,
    modelAgreement: 0.8,
    dataQuality: 82,
    dataMode: 'live',
    dataTimestamp: new Date(NOW_MS - 5 * 60_000).toISOString(),
    spot: 100_000,
    ...overrides,
  }
}

function makeFixture(overrides: Partial<SportsFixtureInput> = {}): SportsFixtureInput {
  return {
    gameId: 'eng.1:1001',
    league: 'Premier League',
    home: 'Arsenal',
    away: 'Fulham',
    kickoffMs: NOW_MS + 24 * HOUR_MS,
    outcomes: [
      { key: 'home', label: 'Arsenal', probability: 0.55 },
      { key: 'draw', label: 'Draw', probability: 0.25 },
      { key: 'away', label: 'Fulham', probability: 0.2 },
    ],
    confidence: 0.55,
    earlySeason: false,
    ...overrides,
  }
}

function makeCluster(overrides: Partial<NewsClusterInput> = {}): NewsClusterInput {
  return {
    id: 'cluster-1',
    headline: 'Fed holds rates as markets await guidance',
    importance: 72,
    isBreaking: false,
    unverified: false,
    sourceCount: 5,
    entities: [{ entityId: 'btc', mentions: 3, sentimentScore: -30, sentimentConfidence: 0.6 }],
    ...overrides,
  }
}

/** An opportunity produced by the REAL scanner — gating included. */
function makeActionableOpportunity(id = 'kalshi:OPP1') {
  return evaluateOpportunity(
    makeParams({ market: makeMarket({ id, title: `Market ${id}` }) }),
  )
}

/** A no-action opportunity: confidence below the scanner's 0.45 gate. */
function makeRejectedOpportunity(id = 'kalshi:REJ1') {
  return evaluateOpportunity(
    makeParams({ market: makeMarket({ id, title: `Market ${id}` }), confidence: 0.2 }),
  )
}

function makeInputs(overrides: Partial<BriefingInputs> = {}): BriefingInputs {
  return {
    marketState: [
      makeCrypto(),
      makeCrypto({ symbol: 'ETH', predictionId: 'ETHUSDT', pUp: 0.44, confidence: 0.4 }),
      makeCrypto({ symbol: 'SOL', predictionId: 'SOLUSDT', pUp: 0.5, confidence: 0.3 }),
    ],
    edgeOpportunities: [makeActionableOpportunity(), makeRejectedOpportunity()],
    sportsFixtures: [makeFixture()],
    newsClusters: [makeCluster()],
    failures: [],
    generatedAt: GENERATED_AT,
    ...overrides,
  }
}

function allText(briefing: AnalystBriefing): string {
  return briefing.sections
    .flatMap((s) => [s.headline.text, ...s.bullets.map((b) => b.text)])
    .join('\n')
}

function section(briefing: AnalystBriefing, id: string) {
  const s = briefing.sections.find((x) => x.id === id)
  if (s === undefined) throw new Error(`section ${id} missing`)
  return s
}

// ---------------------------------------------------------------------------
// Hedging tiers
// ---------------------------------------------------------------------------

describe('hedging tiers', () => {
  it('maps confidence bands to the contracted tiers', () => {
    expect(hedgeTier(0.1)).toBe('weak')
    expect(hedgeTier(0.34)).toBe('weak')
    expect(hedgeTier(0.35)).toBe('moderate')
    expect(hedgeTier(0.6)).toBe('moderate')
    expect(hedgeTier(0.61)).toBe('strong')
    expect(hedgeLabel(0.2)).toBe('weak signal, low conviction')
    expect(hedgeLabel(0.5)).toBe('moderate signal')
    expect(hedgeLabel(0.9)).toBe('strong signal')
  })

  it('renders the hedge tier matching each asset confidence in market_pulse', () => {
    const briefing = composeBriefing(makeInputs())
    const pulse = section(briefing, 'market_pulse')
    const btc = pulse.bullets.find((b) => b.text.startsWith('BTC'))
    const sol = pulse.bullets.find((b) => b.text.startsWith('SOL'))
    expect(btc?.text).toContain('moderate signal') // confidence 0.5
    expect(sol?.text).toContain('weak signal, low conviction') // confidence 0.3
  })

  it('property: no output string ever contains certainty language', () => {
    // Sweep a grid of probabilities/confidences, degraded and healthy inputs.
    const banned = /\b(will rise|will fall|will|guaranteed|certain|certainly|definitely)\b/i
    const grid = [0.05, 0.3, 0.44, 0.5, 0.56, 0.7, 0.95]
    for (const pUp of grid) {
      for (const confidence of [0.1, 0.4, 0.8]) {
        const briefing = composeBriefing(
          makeInputs({
            marketState: [makeCrypto({ pUp, confidence })],
            failures: [{ domain: 'news', message: 'feed timeout' }],
          }),
        )
        expect(allText(briefing)).not.toMatch(banned)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Opportunity gating
// ---------------------------------------------------------------------------

describe('top_opportunities gating', () => {
  it('never promotes a no-action opportunity', () => {
    const rejected = makeRejectedOpportunity('kalshi:GATED')
    expect(rejected.action).toBe('no_action') // sanity: the scanner rejected it
    const briefing = composeBriefing(makeInputs({ edgeOpportunities: [rejected] }))
    const opportunities = section(briefing, 'top_opportunities')

    // The headline reports zero tradeable-grade divergences...
    expect(opportunities.headline.text).toContain('No tradeable-grade divergence')
    // ...and the market may appear ONLY as flagged-but-not-actionable, quoting
    // the scanner's own reason.
    const mention = opportunities.bullets.find((b) => b.text.includes('kalshi:GATED'))
    expect(mention?.text).toMatch(/^Flagged but not actionable:/)
    expect(mention?.text).toContain('Confidence')
    // It must not enter the diffable promoted set either.
    expect(briefing.facts.opportunities).toHaveLength(0)
  })

  it('promotes actionable opportunities with market vs Vixera probabilities and edge', () => {
    const opp = makeActionableOpportunity('kalshi:GOOD')
    expect(opp.action).toBe('opportunity')
    const briefing = composeBriefing(makeInputs({ edgeOpportunities: [opp] }))
    const bullets = section(briefing, 'top_opportunities').bullets
    const line = bullets.find((b) => b.text.includes('kalshi:GOOD'))
    expect(line?.text).toContain('model diverges from market by')
    expect(line?.text).toContain('market 50.0% vs Vixera 65.0%')
    expect(line?.evidence.some((e) => e.source === 'edge')).toBe(true)
  })

  it('caps the promoted set at five', () => {
    const many = Array.from({ length: 8 }, (_, i) => makeActionableOpportunity(`kalshi:O${i}`))
    const briefing = composeBriefing(makeInputs({ edgeOpportunities: many }))
    expect(briefing.facts.opportunities.length).toBeLessThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------
// News gating
// ---------------------------------------------------------------------------

describe('moving_news', () => {
  it('excludes unverified clusters entirely', () => {
    const briefing = composeBriefing(
      makeInputs({
        newsClusters: [
          makeCluster({ id: 'ok', headline: 'Verified story' }),
          makeCluster({ id: 'rumour', headline: 'Unverified rumour', unverified: true, importance: 99 }),
        ],
      }),
    )
    const news = section(briefing, 'moving_news')
    const text = [news.headline.text, ...news.bullets.map((b) => b.text)].join('\n')
    expect(text).not.toContain('Unverified rumour')
    expect(text).toContain('Verified story')
    expect(news.headline.text).toContain('1 unverified cluster excluded')
  })

  it('links entities to related assets via the dictionary', () => {
    const briefing = composeBriefing(makeInputs())
    const bullet = section(briefing, 'moving_news').bullets[0]
    expect(bullet?.text).toContain('Bitcoin')
    expect(bullet?.text).toContain('→ BTC')
    expect(bullet?.text).toContain('negative tone')
  })
})

// ---------------------------------------------------------------------------
// Watch next
// ---------------------------------------------------------------------------

describe('watch_next', () => {
  it('only lists fixtures inside 72h whose lean clears the threshold', () => {
    const strong = makeFixture({ gameId: 'eng.1:strong' }) // margin 0.30
    const weak = makeFixture({
      gameId: 'eng.1:weak',
      outcomes: [
        { key: 'home', label: 'A', probability: 0.4 },
        { key: 'draw', label: 'Draw', probability: 0.32 },
        { key: 'away', label: 'B', probability: 0.28 },
      ],
    }) // margin 0.08 < threshold
    const distant = makeFixture({ gameId: 'eng.1:distant', kickoffMs: NOW_MS + 100 * HOUR_MS })
    const briefing = composeBriefing(makeInputs({ sportsFixtures: [strong, weak, distant] }))
    const watch = section(briefing, 'watch_next')
    const text = watch.bullets.map((b) => b.text).join('\n')
    expect(watch.headline.evidence.map((e) => e.ref)).toEqual(['eng.1:strong'])
    expect(text).toContain('Arsenal')
    expect(watch.headline.text).toContain(`${(WATCH_LEAN_THRESHOLD * 100).toFixed(0)}pp`)
  })

  it('adds the early-season caveat when a listed fixture is flagged', () => {
    const briefing = composeBriefing(
      makeInputs({ sportsFixtures: [makeFixture({ earlySeason: true })] }),
    )
    const text = section(briefing, 'watch_next').bullets.map((b) => b.text).join('\n')
    expect(text).toContain('Early-season caveat')
  })
})

// ---------------------------------------------------------------------------
// Risk flags
// ---------------------------------------------------------------------------

describe('risk_flags', () => {
  it('is never empty on degraded inputs, naming each failed domain', () => {
    const briefing = composeBriefing(
      makeInputs({
        failures: [
          { domain: 'sports', message: 'provider 503' },
          { domain: 'news', message: 'feed timeout' },
        ],
        marketState: [makeCrypto({ dataMode: 'partial', confidence: 0.2 })],
      }),
    )
    const flags = section(briefing, 'risk_flags')
    const text = flags.bullets.map((b) => b.text).join('\n')
    expect(flags.bullets.length).toBeGreaterThan(0)
    expect(text).toContain('sports inputs degraded this cycle: provider 503')
    expect(text).toContain('news inputs degraded this cycle: feed timeout')
    expect(text).toContain('Partial data mode on BTC')
    expect(text).toContain('Low-conviction regime on BTC')
  })

  it('still renders with at least the standing probabilistic caveat when healthy', () => {
    const briefing = composeBriefing(makeInputs())
    const flags = section(briefing, 'risk_flags')
    expect(flags.bullets.length).toBeGreaterThanOrEqual(1)
    expect(flags.bullets[flags.bullets.length - 1]?.text).toContain('Standing caveat')
  })

  it('flags stale inputs and model disagreement from real state', () => {
    const briefing = composeBriefing(
      makeInputs({
        marketState: [
          makeCrypto({ dataTimestamp: new Date(NOW_MS - 45 * 60_000).toISOString() }),
          makeCrypto({ symbol: 'ETH', predictionId: 'ETHUSDT', modelAgreement: 0.3 }),
        ],
      }),
    )
    const text = section(briefing, 'risk_flags').bullets.map((b) => b.text).join('\n')
    expect(text).toContain('Stale inputs: BTC (45m old)')
    expect(text).toContain('Model disagreement on ETH (agreement 0.30)')
  })
})

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe('evidence refs', () => {
  it('every data-bearing bullet carries at least one evidence ref', () => {
    const briefing = composeBriefing(makeInputs())
    for (const id of ['market_pulse', 'top_opportunities', 'watch_next', 'moving_news'] as const) {
      for (const bullet of section(briefing, id).bullets) {
        expect(bullet.evidence.length, `${id}: "${bullet.text}"`).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// whatChanged
// ---------------------------------------------------------------------------

describe('whatChanged', () => {
  it('returns an empty delta with since=null when there is no previous briefing', () => {
    const current = composeBriefing(makeInputs())
    expect(whatChanged(null, current)).toEqual({ since: null, changes: [] })
  })

  it('detects a direction flip', () => {
    const prev = composeBriefing(makeInputs({ marketState: [makeCrypto({ pUp: 0.42 })] }))
    const current = composeBriefing(
      makeInputs({
        marketState: [makeCrypto({ pUp: 0.58 })],
        generatedAt: new Date(NOW_MS + 120_000).toISOString(),
      }),
    )
    const delta = whatChanged(prev, current)
    expect(delta.since).toBe(prev.generatedAt)
    const flip = delta.changes.find((c) => c.kind === 'direction_flip')
    expect(flip?.text).toContain('BTC lean flipped bearish → bullish')
  })

  it('detects a new opportunity', () => {
    const prev = composeBriefing(makeInputs({ edgeOpportunities: [] }))
    const current = composeBriefing(
      makeInputs({ edgeOpportunities: [makeActionableOpportunity('kalshi:NEW')] }),
    )
    const change = whatChanged(prev, current).changes.find((c) => c.kind === 'new_opportunity')
    expect(change?.text).toContain('kalshi:NEW')
  })

  it('detects a confidence swing above 10pp but not below it', () => {
    const prev = composeBriefing(makeInputs({ marketState: [makeCrypto({ confidence: 0.5 })] }))
    const swung = composeBriefing(makeInputs({ marketState: [makeCrypto({ confidence: 0.65 })] }))
    const steady = composeBriefing(makeInputs({ marketState: [makeCrypto({ confidence: 0.55 })] }))
    expect(whatChanged(prev, swung).changes.some((c) => c.kind === 'confidence_swing')).toBe(true)
    expect(whatChanged(prev, steady).changes.some((c) => c.kind === 'confidence_swing')).toBe(false)
  })

  it('detects a new breaking cluster', () => {
    const prev = composeBriefing(makeInputs())
    const current = composeBriefing(
      makeInputs({
        newsClusters: [
          makeCluster(),
          makeCluster({ id: 'flash', headline: 'Exchange halts withdrawals', isBreaking: true }),
        ],
      }),
    )
    const change = whatChanged(prev, current).changes.find((c) => c.kind === 'new_breaking')
    expect(change?.text).toContain('Exchange halts withdrawals')
  })

  it('ignores unverified breaking clusters in the diff too', () => {
    const prev = composeBriefing(makeInputs())
    const current = composeBriefing(
      makeInputs({
        newsClusters: [
          makeCluster(),
          makeCluster({ id: 'rumour', headline: 'Rumour', isBreaking: true, unverified: true }),
        ],
      }),
    )
    expect(whatChanged(prev, current).changes.some((c) => c.kind === 'new_breaking')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('same input → identical output (deep equality across repeated runs)', () => {
    const inputs = makeInputs()
    const a = composeBriefing(inputs)
    const b = composeBriefing(inputs)
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('section order is fixed', () => {
    const briefing = composeBriefing(makeInputs())
    expect(briefing.sections.map((s) => s.id)).toEqual([
      'market_pulse',
      'top_opportunities',
      'watch_next',
      'moving_news',
      'risk_flags',
    ])
  })
})
