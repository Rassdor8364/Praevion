/**
 * Cross-venue dislocation detection.
 *
 * The same real-world event often trades on multiple venues (Kalshi and
 * Polymarket both list "Fed cuts by December"). When the venues disagree,
 * that disagreement is ITSELF a signal, independent of any Vixera model:
 * at least one venue must be wrong, and the size of the gap bounds the
 * mispricing from below. Layering Vixera's own probability on top then tells
 * you WHERE the mispricing most likely lives — the venue farthest from our
 * estimate is the one to look at first.
 *
 * Two functions:
 *  - linkByTitle: group markets that appear to be the same event.
 *  - detectDislocations: measure disagreement within each group.
 *
 * Pure: markets in, groups and dislocations out.
 */

import type {
  LinkedMarketQuote,
  MarketDislocation,
  PredictionMarket,
} from '@/core/markets/types'

// ---------------------------------------------------------------------------
// Title linking
// ---------------------------------------------------------------------------

/**
 * Words carrying no event identity. Deliberately SHORT: "before", "after",
 * "above", "below", "not" all change what event a title describes and must
 * survive normalisation. "by" is included because in market titles it is
 * almost always the temporal "by December", and the date token itself carries
 * that meaning.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'will', 'would', 'be', 'is', 'are', 'was', 'were', 'been',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'or', 'and', 'do', 'does', 'did',
  'it', 'its', 'this', 'that', 'than',
])

/** Pure 4-digit years (1900–2099). Titles differ on year suffixes constantly
 *  ("...by December?" vs "...by December 2026?") while meaning the same event
 *  in context; venue metadata disambiguates the rare cross-year collision. */
const YEAR_RE = /^(19|20)\d{2}$/

/**
 * Normalise a title into a token set: lowercase, punctuation stripped,
 * stopwords and year/number tokens dropped, and a LIGHT plural stem (strip a
 * trailing 's' from tokens of 4+ letters, so "cuts"/"cut" and "rates"/"rate"
 * unify). Real stemming is deliberately avoided — over-stemming merges
 * distinct events, and false-positive links are worse than misses.
 */
export function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>()
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
  for (const raw of words) {
    if (raw.length === 0) continue
    if (STOPWORDS.has(raw)) continue
    if (YEAR_RE.test(raw)) continue
    if (/^\d+$/.test(raw)) continue // bare numbers: dates, thresholds — too ambiguous to match on
    const stemmed = raw.length >= 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw
    tokens.add(stemmed)
  }
  return tokens
}

/** Jaccard similarity of two token sets; 0 when either is empty. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

export interface TitleLinkGroup {
  readonly eventKey: string
  readonly eventTitle: string
  readonly markets: readonly PredictionMarket[]
}

/**
 * Group markets that appear to describe the same event, by token-set Jaccard
 * similarity over normalised titles.
 *
 * THIS IS A HEURISTIC FIRST PASS. Embedding-based linking replaces it in a
 * later phase (feeding the same TitleLinkGroup shape); token Jaccard cannot
 * see that "Powell lowers the funds rate" and "Fed cuts rates" are the same
 * event, and it will miss them. That is the correct failure direction:
 * a MISSED link merely hides a dislocation, while a FALSE link manufactures
 * one — "Fed cuts rates" vs "Fed raises rates" quoted at wildly different
 * probabilities would look like a huge cross-venue mispricing when it is in
 * fact two different events. Hence the threshold errs high (~0.6) and the
 * comparison is STRICT (> not ≥): a boundary-similarity pair, which is
 * exactly the one-token-different antonym case, stays unlinked.
 *
 * Only groups of two or more markets are returned — a singleton cannot
 * dislocate against anything.
 */
export function linkByTitle(
  markets: readonly PredictionMarket[],
  threshold = 0.6,
): TitleLinkGroup[] {
  const tokenSets = markets.map((m) => titleTokens(m.title))

  // Union-find over pairwise similarity. O(n²) pairs is fine at scanner batch
  // sizes; the embedding phase brings an index if it ever isn't.
  const parent = markets.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== undefined && parent[root] !== root) root = parent[root] as number
    return root
  }
  const union = (i: number, j: number): void => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[ri] = rj
  }

  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const a = tokenSets[i]
      const b = tokenSets[j]
      if (a !== undefined && b !== undefined && jaccard(a, b) > threshold) union(i, j)
    }
  }

  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < markets.length; i++) {
    const root = find(i)
    const members = byRoot.get(root)
    if (members !== undefined) members.push(i)
    else byRoot.set(root, [i])
  }

  const groups: TitleLinkGroup[] = []
  for (const members of byRoot.values()) {
    if (members.length < 2) continue
    const groupMarkets = members
      .map((i) => markets[i])
      .filter((m): m is PredictionMarket => m !== undefined)
    // The shortest title is usually the least decorated statement of the
    // event, so it serves as the display title; the sorted token union of
    // that title is the stable key.
    const canonical = [...groupMarkets].sort((a, b) => a.title.length - b.title.length)[0]
    if (canonical === undefined) continue
    const key = [...titleTokens(canonical.title)].sort().join('-')
    groups.push({ eventKey: key, eventTitle: canonical.title, markets: groupMarkets })
  }
  return groups
}

// ---------------------------------------------------------------------------
// Dislocation detection
// ---------------------------------------------------------------------------

export interface DislocationGroupInput {
  readonly eventKey: string
  readonly eventTitle: string
  readonly quotes: readonly LinkedMarketQuote[]
  readonly vixeraProbability: number | null
}

/**
 * Measure cross-venue disagreement within each linked group.
 *
 * The max pairwise spread of a set of probabilities is simply its range
 * (max − min): the two most-disagreeing venues define the dislocation.
 * Quotes with non-finite probabilities (a feed hiccup) are dropped before
 * measurement rather than clamped — a fabricated 0 or 1 would manufacture the
 * largest possible spread out of a parsing bug.
 *
 * Groups are kept when spread ≥ minSpreadPp and returned sorted by spread
 * descending — biggest disagreement, biggest story, first.
 */
export function detectDislocations(
  groups: readonly DislocationGroupInput[],
  minSpreadPp: number,
): MarketDislocation[] {
  const threshold = Number.isFinite(minSpreadPp) ? Math.max(0, minSpreadPp) : 0
  const out: MarketDislocation[] = []

  for (const group of groups) {
    const quotes = group.quotes.filter(
      (q) => Number.isFinite(q.marketProbability) && q.marketProbability >= 0 && q.marketProbability <= 1,
    )
    // Disagreement needs at least two parties.
    if (quotes.length < 2) continue

    let min = Infinity
    let max = -Infinity
    for (const q of quotes) {
      if (q.marketProbability < min) min = q.marketProbability
      if (q.marketProbability > max) max = q.marketProbability
    }
    const spread = max - min
    if (spread < threshold) continue

    // The largest Vixera edge across venues locates WHERE the mispricing
    // lives (largest by magnitude; the sign says which direction).
    const vixera =
      group.vixeraProbability !== null && Number.isFinite(group.vixeraProbability)
        ? Math.min(1, Math.max(0, group.vixeraProbability))
        : null
    let largestEdge: { provider: string; edgePp: number } | null = null
    if (vixera !== null) {
      for (const q of quotes) {
        const edge = vixera - q.marketProbability
        if (largestEdge === null || Math.abs(edge) > Math.abs(largestEdge.edgePp)) {
          largestEdge = { provider: q.provider, edgePp: edge }
        }
      }
    }

    out.push({
      eventKey: group.eventKey,
      eventTitle: group.eventTitle,
      quotes,
      crossMarketSpreadPp: spread,
      vixeraProbability: vixera,
      largestEdge,
    })
  }

  return out.sort(
    (a, b) => b.crossMarketSpreadPp - a.crossMarketSpreadPp || a.eventKey.localeCompare(b.eventKey),
  )
}
