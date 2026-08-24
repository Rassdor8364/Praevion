/**
 * Sportsbook-comparison tests: conservative matching, honest de-vigging,
 * and the edge/staking read-off. The fair-book fixture makes the no-vig
 * result exactly hand-checkable (a book with no margin de-vigs to itself).
 */

import { describe, expect, it } from 'vitest'

import {
  compareWithMarket,
  matchGameToOdds,
  teamNamesMatch,
} from '@/engines/sports/odds-edge'
import type { GameOdds } from '@/providers/types'

const KICKOFF = Date.parse('2026-03-14T15:00:00Z')

function oddsEvent(partial?: Partial<GameOdds>): GameOdds {
  return {
    externalId: 'evt-1',
    homeTeamName: 'Arsenal',
    awayTeamName: 'Chelsea',
    kickoff: KICKOFF,
    markets: [
      {
        bookmaker: 'FairBook',
        marketKey: 'h2h',
        lastUpdate: KICKOFF - 3_600_000,
        outcomes: [
          { name: 'Arsenal', decimalOdds: 2, point: null },
          { name: 'Draw', decimalOdds: 10 / 3, point: null },
          { name: 'Chelsea', decimalOdds: 5, point: null },
        ],
      },
    ],
    ...partial,
  }
}

describe('teamNamesMatch', () => {
  it('matches abbreviations and diacritic variants', () => {
    expect(teamNamesMatch('Manchester United', 'Man United')).toBe(true)
    expect(teamNamesMatch('Atlético Madrid', 'Atletico Madrid')).toBe(true)
    expect(teamNamesMatch('Bayern Munich', 'FC Bayern Munich')).toBe(true)
  })

  it('refuses cross-town confusions', () => {
    expect(teamNamesMatch('Manchester United', 'Manchester City')).toBe(false)
    expect(teamNamesMatch('Arsenal', 'Chelsea')).toBe(false)
  })
})

describe('matchGameToOdds', () => {
  const game = { homeTeamName: 'Arsenal', awayTeamName: 'Chelsea', kickoff: KICKOFF }

  it('matches an aligned event within the kickoff window', () => {
    expect(matchGameToOdds(game, [oddsEvent()])?.externalId).toBe('evt-1')
  })

  it('never matches a swapped home/away pairing', () => {
    const swapped = oddsEvent({ homeTeamName: 'Chelsea', awayTeamName: 'Arsenal' })
    expect(matchGameToOdds(game, [swapped])).toBeNull()
  })

  it('rejects kickoffs outside the tolerance', () => {
    const wrongDay = oddsEvent({ kickoff: KICKOFF + 26 * 3_600_000 })
    expect(matchGameToOdds(game, [wrongDay])).toBeNull()
  })

  it('returns null on ambiguity rather than guessing', () => {
    expect(matchGameToOdds(game, [oddsEvent(), oddsEvent({ externalId: 'evt-2' })])).toBeNull()
  })
})

describe('compareWithMarket', () => {
  const modelOutcomes = [
    { key: 'home', label: 'Arsenal', probability: 0.55 },
    { key: 'draw', label: 'Draw', probability: 0.25 },
    { key: 'away', label: 'Chelsea', probability: 0.2 },
  ]

  it('a margin-free book de-vigs to exactly its implied probabilities', () => {
    // Odds 2 / 3.333… / 5 imply 0.50 / 0.30 / 0.20 — already a distribution,
    // so no-vig must return them unchanged and the overround must be 0.
    const r = compareWithMarket({ modelOutcomes, odds: oddsEvent() })
    expect(r).not.toBeNull()
    if (r === null) return
    expect(r.bookmakerCount).toBe(1)
    expect(r.medianOverround).toBeCloseTo(0, 6)
    const byKey = Object.fromEntries(r.outcomes.map((o) => [o.key, o]))
    expect(byKey['home']?.noVigProbability).toBeCloseTo(0.5, 6)
    expect(byKey['draw']?.noVigProbability).toBeCloseTo(0.3, 6)
    expect(byKey['away']?.noVigProbability).toBeCloseTo(0.2, 6)
    // Edge = model − no-vig, hand-computed.
    expect(byKey['home']?.edge).toBeCloseTo(0.05, 6)
    expect(byKey['draw']?.edge).toBeCloseTo(-0.05, 6)
    expect(byKey['away']?.edge).toBeCloseTo(0, 6)
    // Implied probability quotes the raw median price.
    expect(byKey['home']?.impliedProbability).toBeCloseTo(0.5, 9)
  })

  it('no-vig probabilities always renormalise to 1 on an overround book', () => {
    const juiced = oddsEvent({
      markets: [
        {
          bookmaker: 'JuicedBook',
          marketKey: 'h2h',
          lastUpdate: KICKOFF,
          outcomes: [
            { name: 'Arsenal', decimalOdds: 2.2, point: null },
            { name: 'Draw', decimalOdds: 3.0, point: null },
            { name: 'Chelsea', decimalOdds: 4.0, point: null },
          ],
        },
      ],
    })
    const r = compareWithMarket({ modelOutcomes, odds: juiced })
    expect(r).not.toBeNull()
    if (r === null) return
    const sum = r.outcomes.reduce((a, o) => a + o.noVigProbability, 0)
    expect(sum).toBeCloseTo(1, 9)
    expect(r.medianOverround).toBeGreaterThan(0)
    // Every no-vig probability sits below the raw implied one on a juiced book.
    for (const o of r.outcomes) {
      expect(o.noVigProbability).toBeLessThan(1 / o.medianOdds + 1e-9)
    }
  })

  it('attaches staking mathematics only where expectation is positive', () => {
    const r = compareWithMarket({ modelOutcomes, odds: oddsEvent() })
    if (r === null) return
    const byKey = Object.fromEntries(r.outcomes.map((o) => [o.key, o]))
    // Home: p=0.55 at best odds 2.0 → EV +0.10 → staking present, hand-checked
    // Kelly (2·0.55 − 1)/1 = 0.10.
    expect(byKey['home']?.staking?.kellyFraction).toBeCloseTo(0.1, 9)
    // Draw: p=0.25 vs no-vig 0.30 → negative edge → no staking block.
    expect(byKey['draw']?.staking).toBeNull()
    // Away: edge exactly 0 → analytical sizing is withheld too.
    expect(byKey['away']?.staking).toBeNull()
  })

  it('takes the best price across books and the median as consensus', () => {
    const twoBooks = oddsEvent({
      markets: [
        ...oddsEvent().markets,
        {
          bookmaker: 'BetterHome',
          marketKey: 'h2h',
          lastUpdate: KICKOFF - 60_000,
          outcomes: [
            { name: 'Arsenal FC', decimalOdds: 2.6, point: null },
            { name: 'Draw', decimalOdds: 3.3, point: null },
            { name: 'Chelsea FC', decimalOdds: 4.8, point: null },
          ],
        },
      ],
    })
    const r = compareWithMarket({ modelOutcomes, odds: twoBooks })
    expect(r?.bookmakerCount).toBe(2)
    const home = r?.outcomes.find((o) => o.key === 'home')
    expect(home?.bestOdds).toBe(2.6)
    expect(home?.bestBookmaker).toBe('BetterHome')
    expect(home?.medianOdds).toBeCloseTo(2.3, 9)
  })

  it('returns null when no book quotes a complete 1X2', () => {
    const partial = oddsEvent({
      markets: [
        {
          bookmaker: 'HalfBook',
          marketKey: 'h2h',
          lastUpdate: KICKOFF,
          outcomes: [
            { name: 'Arsenal', decimalOdds: 2, point: null },
            { name: 'Chelsea', decimalOdds: 5, point: null },
          ],
        },
      ],
    })
    expect(compareWithMarket({ modelOutcomes, odds: partial })).toBeNull()
  })
})
