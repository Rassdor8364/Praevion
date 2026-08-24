/**
 * Sportsbook comparison — model probability vs de-vigged market price.
 *
 * Three deliberately distinct numbers per outcome, per the §17/§18 contract:
 *
 *   impliedProbability — 1/odds, the RAW quote. Sums past 1 across a market
 *                        because it includes the bookmaker's margin.
 *   noVigProbability   — the margin removed (power method — see removeVig
 *                        for why proportional scaling misprices longshots).
 *                        This is the closest thing to "the market's actual
 *                        forecast" a price can give.
 *   edge               — Praevion's probability minus the no-vig consensus,
 *                        in probability points. An ANALYTICAL divergence
 *                        measure between two forecasts, presented with fair
 *                        odds and (when positive at the best available
 *                        price) risk-capped Kelly sizing mathematics.
 *
 * Event matching is conservative BY DESIGN. The odds venue and the sports
 * provider disagree on team naming ("Man United" vs "Manchester United"),
 * and a wrong match prices one fixture with another's market — worse than
 * no match. Both team names must match (aligned home/away, never swapped),
 * kickoffs must agree within a tight window, and any ambiguity returns null:
 * "Sportsbook odds unavailable" is recoverable, a silent mismatch is not.
 *
 * Pure module — the orchestrator does the fetching.
 */

import { fairDecimalOdds, impliedProbability, overround, removeVig } from '@/core/prediction/probability'
import { assessStaking, type StakingAssessment } from '@/core/staking/kelly'
import type { GameOdds } from '@/providers/types'

// ---------------------------------------------------------------------------
// Team-name matching
// ---------------------------------------------------------------------------

/** Corporate suffixes and glue words that carry no identity. Deliberately
 *  SHORT: over-stripping ("real", "united") destroys identity faster than
 *  under-stripping costs matches. */
const NOISE_TOKENS = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'club', 'de', 'the'])

function normalizeTokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics: Atlético → Atletico
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t))
}

/**
 * True when two team names plausibly denote the same club: token containment
 * in either direction ("Manchester United" ⊇ "Man United" fails tokenwise,
 * so abbreviation prefixes are also accepted token-by-token).
 */
export function teamNamesMatch(a: string, b: string): boolean {
  const ta = normalizeTokens(a)
  const tb = normalizeTokens(b)
  if (ta.length === 0 || tb.length === 0) return false

  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  let matched = 0
  for (const s of shorter) {
    if (longer.some((l) => l === s || l.startsWith(s) || s.startsWith(l))) matched += 1
  }
  return matched / shorter.length >= 0.6
}

/** Kickoff tolerance: venues quote the same fixture within minutes; a wider
 *  window starts matching Tuesday's game to Wednesday's. */
const KICKOFF_TOLERANCE_MS = 3 * 3_600_000

/**
 * Find THE odds event for a fixture — or null. Null on zero matches AND on
 * multiple matches: ambiguity means the conservative answer is "no odds".
 */
export function matchGameToOdds(
  game: { readonly homeTeamName: string; readonly awayTeamName: string; readonly kickoff: number },
  events: readonly GameOdds[],
): GameOdds | null {
  const candidates = events.filter(
    (e) =>
      Math.abs(e.kickoff - game.kickoff) <= KICKOFF_TOLERANCE_MS &&
      teamNamesMatch(e.homeTeamName, game.homeTeamName) &&
      teamNamesMatch(e.awayTeamName, game.awayTeamName),
  )
  return candidates.length === 1 ? (candidates[0] ?? null) : null
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface MarketComparisonOutcome {
  readonly key: 'home' | 'draw' | 'away'
  readonly label: string
  readonly vixeraProbability: number
  readonly fairOdds: number
  /** Best (highest) decimal price across books — the executable side. */
  readonly bestOdds: number
  readonly bestBookmaker: string
  /** Median decimal price — the consensus quote. */
  readonly medianOdds: number
  /** 1/medianOdds — includes the venue margin. */
  readonly impliedProbability: number
  /** Median per-book de-vigged probability, renormalised. */
  readonly noVigProbability: number
  /** vixeraProbability − noVigProbability, in probability points. */
  readonly edge: number
  /** Risk-capped Kelly mathematics at the best price; null without a
   *  positive expectation there. */
  readonly staking: StakingAssessment | null
}

export interface MatchMarketComparison {
  readonly matchedEventId: string
  readonly bookmakerCount: number
  /** Median per-book overround — what the margin costs at this venue set. */
  readonly medianOverround: number
  readonly outcomes: readonly MarketComparisonOutcome[]
  /** Epoch ms of the newest price used. */
  readonly collectedAt: number
}

const H2H_KEYS = ['home', 'draw', 'away'] as const

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? Number.NaN)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * Compare a model 1X2 distribution against every bookmaker's h2h prices for
 * the matched event. Returns null when no book quotes a complete 1X2 —
 * a partial market cannot be de-vigged honestly.
 */
export function compareWithMarket(params: {
  readonly modelOutcomes: readonly { key: string; label: string; probability: number }[]
  readonly odds: GameOdds
}): MatchMarketComparison | null {
  const { modelOutcomes, odds } = params

  // Per-book complete 1X2 quotes, mapped venue-name → outcome key.
  interface BookQuote {
    bookmaker: string
    byKey: Record<'home' | 'draw' | 'away', number>
    lastUpdate: number
  }
  const quotes: BookQuote[] = []
  for (const market of odds.markets) {
    if (market.marketKey !== 'h2h') continue
    const byKey: Partial<Record<'home' | 'draw' | 'away', number>> = {}
    for (const outcome of market.outcomes) {
      if (/^draws?$/i.test(outcome.name.trim())) byKey.draw = outcome.decimalOdds
      else if (teamNamesMatch(outcome.name, odds.homeTeamName)) byKey.home = outcome.decimalOdds
      else if (teamNamesMatch(outcome.name, odds.awayTeamName)) byKey.away = outcome.decimalOdds
    }
    if (byKey.home !== undefined && byKey.draw !== undefined && byKey.away !== undefined) {
      quotes.push({
        bookmaker: market.bookmaker,
        byKey: byKey as Record<'home' | 'draw' | 'away', number>,
        lastUpdate: market.lastUpdate,
      })
    }
  }
  if (quotes.length === 0) return null

  // Per-book de-vig, then the median per outcome, renormalised. Median
  // across books rather than de-vigging median odds: one outlier book must
  // not drag the consensus, and the median of valid distributions is robust.
  const noVigByKey: Record<'home' | 'draw' | 'away', number[]> = { home: [], draw: [], away: [] }
  for (const q of quotes) {
    const devigged = removeVig([q.byKey.home, q.byKey.draw, q.byKey.away], 'power')
    noVigByKey.home.push(devigged[0] ?? 0)
    noVigByKey.draw.push(devigged[1] ?? 0)
    noVigByKey.away.push(devigged[2] ?? 0)
  }
  const rawMedians = H2H_KEYS.map((k) => median(noVigByKey[k]))
  const medianSum = rawMedians.reduce((a, b) => a + b, 0)
  const consensus = rawMedians.map((v) => (medianSum > 0 ? v / medianSum : Number.NaN))

  const outcomes: MarketComparisonOutcome[] = []
  for (let i = 0; i < H2H_KEYS.length; i++) {
    const key = H2H_KEYS[i] ?? 'home'
    const model = modelOutcomes.find((o) => o.key === key)
    if (model === undefined) return null

    const prices = quotes.map((q) => ({ bookmaker: q.bookmaker, odds: q.byKey[key] }))
    const best = prices.reduce((acc, p) => (p.odds > acc.odds ? p : acc), prices[0] ?? { bookmaker: '', odds: 0 })
    const med = median(prices.map((p) => p.odds))
    const noVig = consensus[i] ?? Number.NaN
    const edge = model.probability - noVig

    const staking =
      edge > 0 && best.odds > 1 && model.probability > 1 / best.odds
        ? assessStaking({ probability: model.probability, decimalOdds: best.odds })
        : null

    outcomes.push({
      key,
      label: model.label,
      vixeraProbability: model.probability,
      fairOdds: fairDecimalOdds(model.probability),
      bestOdds: best.odds,
      bestBookmaker: best.bookmaker,
      medianOdds: med,
      impliedProbability: impliedProbability(med),
      noVigProbability: noVig,
      edge,
      staking,
    })
  }

  return {
    matchedEventId: odds.externalId,
    bookmakerCount: quotes.length,
    medianOverround: median(quotes.map((q) => overround([q.byKey.home, q.byKey.draw, q.byKey.away]))),
    outcomes,
    collectedAt: Math.max(...quotes.map((q) => q.lastUpdate)),
  }
}
