/**
 * Lexicon-based, finance-tuned sentiment — PER ENTITY (plan §11/§30).
 *
 * "Regulator fines Exchange X" is bearish for X and roughly neutral for the
 * market at large; article-level averaging destroys exactly that distinction,
 * so the primary API here scores a ±N-token window around each entity mention
 * and the article-level score is only the degenerate whole-text window.
 *
 * HONEST LIMITATION, stated once and loudly: lexicon sentiment is crude. It
 * cannot read sarcasm, complex negation, headline questions ("Is the rally
 * over?") or attributed speech. Its output feeds the news signal at LOW weight
 * only, its confidence scales with lexicon-hit count (one hit is noise and is
 * scored as such), and the LLM seam in ./seam.ts is where a real model slots
 * in later without changing this contract.
 *
 * Everything here is a pure function of its arguments — no I/O, no clock.
 */

export interface SentimentResult {
  /** -100 (max bearish) .. +100 (max bullish). 0 with 0 hits means "no signal",
   *  which consumers must distinguish from "confidently neutral" via confidence. */
  readonly score: number
  /** Number of lexicon tokens that contributed. */
  readonly hits: number
  /**
   * 0..1, scaling with hit count: hits/(hits+3), capped at 0.95. One hit
   * scores 0.25 — deliberately below any display threshold, because a single
   * word like "falls" in a 40-word teaser is noise, not a signal.
   */
  readonly confidence: number
}

export const NO_SENTIMENT: SentimentResult = { score: 0, hits: 0, confidence: 0 }

/** Tokens on each side of an entity mention considered "about" that entity. */
export const ENTITY_WINDOW_TOKENS = 12

/** Negation lookback: a negator within this many tokens BEFORE a lexicon hit
 *  flips its sign ("not approved" is a negative, "no losses" a positive). */
const NEGATION_LOOKBACK = 3

/** Intensifier lookback (immediately-preceding modifiers only). */
const INTENSIFIER_LOOKBACK = 2

// ---------------------------------------------------------------------------
// Lexicon (~150 terms, weights in [-4, +4])
// ---------------------------------------------------------------------------

/**
 * Inflections are enumerated rather than stemmed: a stemmer would map "rating"
 * to "rate" and invent hits; fifteen extra lines of lexicon are cheaper than a
 * class of false positives. Ambiguous-in-finance words ("cut" — a rate cut is
 * often bullish; bare "fine") are deliberately absent.
 */
const LEXICON: Readonly<Record<string, number>> = {
  // --- Positive ------------------------------------------------------------
  surge: 3, surges: 3, surged: 3, surging: 3,
  rally: 3, rallies: 3, rallied: 3,
  soar: 3, soars: 3, soared: 3, soaring: 3,
  jump: 2, jumps: 2, jumped: 2,
  gain: 2, gains: 2, gained: 2,
  climb: 2, climbs: 2, climbed: 2,
  rebound: 2, rebounds: 2, rebounded: 2,
  recovery: 2, recover: 2, recovers: 2, recovered: 2,
  approve: 3, approves: 3, approved: 3, approval: 3,
  beat: 2, beats: 2,
  upgrade: 2, upgrades: 2, upgraded: 2,
  bullish: 3,
  boom: 2, booming: 2,
  outperform: 2, outperforms: 2, outperformed: 2,
  breakout: 2,
  surpass: 2, surpasses: 2, surpassed: 2,
  exceed: 2, exceeds: 2, exceeded: 2,
  record: 1, // "record high/inflows"; weak alone
  milestone: 1,
  adoption: 1,
  partnership: 1,
  expansion: 1, expands: 1,
  inflow: 2, inflows: 2,
  buyback: 2, buybacks: 2,
  dividend: 1,
  upbeat: 2,
  optimism: 2, optimistic: 2,
  profit: 1, profits: 1, profitable: 1,
  growth: 1, grew: 1,
  strong: 1, stronger: 1, strongest: 1,
  win: 1, wins: 1, won: 1,
  advance: 1, advances: 1, advanced: 1,
  accelerate: 1, accelerates: 1, accelerating: 1,
  breakthrough: 2,
  settle: 1, settled: 1, // resolving a dispute reads mildly positive

  // --- Negative ------------------------------------------------------------
  crash: -4, crashes: -4, crashed: -4,
  collapse: -4, collapses: -4, collapsed: -4,
  plunge: -3, plunges: -3, plunged: -3,
  plummet: -3, plummets: -3, plummeted: -3,
  tumble: -3, tumbles: -3, tumbled: -3,
  slump: -2, slumps: -2, slumped: -2,
  sink: -2, sinks: -2, sank: -2,
  drop: -2, drops: -2, dropped: -2,
  fall: -2, falls: -2, fell: -2, falling: -2,
  decline: -2, declines: -2, declined: -2,
  slide: -2, slides: -2, slid: -2,
  selloff: -3,
  rout: -3,
  ban: -3, bans: -3, banned: -3,
  probe: -2, probes: -2,
  investigation: -2, investigates: -2, investigating: -2,
  lawsuit: -3, lawsuits: -3, sues: -3, sued: -3, sue: -3,
  fraud: -4, fraudulent: -4,
  scam: -4,
  hack: -4, hacked: -4, hackers: -3, hacker: -3,
  exploit: -3, exploited: -3,
  breach: -3, breached: -3,
  bankruptcy: -4, bankrupt: -4, insolvent: -4,
  default: -3, defaults: -3, defaulted: -3,
  miss: -2, misses: -2, missed: -2,
  downgrade: -3, downgrades: -3, downgraded: -3,
  bearish: -3,
  fear: -2, fears: -2,
  panic: -3,
  warn: -2, warns: -2, warned: -2, warning: -2,
  crisis: -3,
  layoff: -3, layoffs: -3,
  loss: -2, losses: -2,
  weak: -1, weaker: -1, weakest: -1,
  sanction: -2, sanctions: -2, sanctioned: -2,
  fined: -2, fines: -2,
  penalty: -2, penalties: -2,
  halt: -2, halts: -2, halted: -2,
  suspend: -2, suspends: -2, suspended: -2,
  delay: -1, delays: -1, delayed: -1,
  reject: -3, rejects: -3, rejected: -3, rejection: -3,
  outage: -2,
  liquidation: -3, liquidations: -3, liquidated: -3,
  outflow: -2, outflows: -2,
  shutdown: -2,
  downturn: -3,
  turmoil: -3,
  jitters: -2,
  volatile: -1, volatility: -1,
  war: -3,
  attack: -3, attacks: -3, attacked: -3,
  strike: -1, strikes: -1,
  tumbling: -3,
  slashing: -2, slashed: -2,
}

/** Negators: within NEGATION_LOOKBACK tokens before a hit, sign flips.
 *  Contractions survive the sentiment tokenizer ("isn't" stays one token). */
const NEGATORS = new Set<string>([
  'not', 'no', 'never', 'without', 'denies', 'denied', 'deny',
  "isn't", "aren't", "wasn't", "doesn't", "don't", "didn't", "won't", "can't",
])

/** Multiplier applied to a hit when the modifier sits within
 *  INTENSIFIER_LOOKBACK tokens before it. */
const INTENSIFIERS: Readonly<Record<string, number>> = {
  sharply: 1.5,
  dramatically: 1.5,
  massively: 1.5,
  hugely: 1.5,
  significantly: 1.3,
  deeply: 1.3,
  slightly: 0.5,
  modestly: 0.5,
  marginally: 0.5,
  barely: 0.5,
  somewhat: 0.7,
}

// Map lookups, not bare object indexing: a token like "constructor" would
// otherwise resolve through the object prototype to a function and poison the
// arithmetic below.
const LEXICON_MAP: ReadonlyMap<string, number> = new Map(Object.entries(LEXICON))
const INTENSIFIER_MAP: ReadonlyMap<string, number> = new Map(Object.entries(INTENSIFIERS))

// ---------------------------------------------------------------------------
// Tokenization (sentiment-specific)
// ---------------------------------------------------------------------------

export interface TokenSpan {
  readonly token: string
  /** Character offset of the token's start in the source text. */
  readonly start: number
}

/**
 * Lowercase tokens WITH stopwords and contractions kept — "not" is a stopword
 * to the clustering tokenizer but is the entire negation mechanism here.
 */
export function sentimentTokenize(text: string): TokenSpan[] {
  const out: TokenSpan[] = []
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+(?:['’][a-z]+)?/g)) {
    if (m.index === undefined) continue
    out.push({ token: m[0].replace('’', "'"), start: m.index })
  }
  return out
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score the token indices in [from, to] (inclusive, clamped). Exported for
 * tests; the entity/article wrappers below choose the windows.
 *
 * Score = mean adjusted lexicon weight × 25, clamped to ±100 — so a lone
 * "crash" (-4) reads -100 and a lone "gain" (+2) reads +50. Magnitude does NOT
 * grow with hit count (that is what confidence is for); it grows with the
 * strength of the words used.
 */
export function scoreWindow(
  tokens: readonly TokenSpan[],
  from: number,
  to: number,
): SentimentResult {
  const { sum, hits } = rawScoreWindow(tokens, from, to)
  if (hits === 0) return NO_SENTIMENT
  const mean = sum / hits
  const score = Math.max(-100, Math.min(100, Math.round(mean * 25)))
  return { score, hits, confidence: confidenceFor(hits) }
}

/** Unrounded accumulator shared by the window and entity paths, so merging
 *  disjoint entity windows is exact rather than re-derived from a rounded mean. */
function rawScoreWindow(
  tokens: readonly TokenSpan[],
  from: number,
  to: number,
): { sum: number; hits: number } {
  const lo = Math.max(0, from)
  const hi = Math.min(tokens.length - 1, to)

  let sum = 0
  let hits = 0
  for (let i = lo; i <= hi; i++) {
    const span = tokens[i]
    if (span === undefined) continue
    const weight = LEXICON_MAP.get(span.token)
    if (weight === undefined) continue

    let adjusted = weight
    // Negation: nearest-first lookback, flip once. "not sharply higher" — the
    // negator wins over the intensifier because it changes the claim itself.
    for (let j = i - 1; j >= Math.max(lo, i - NEGATION_LOOKBACK); j--) {
      const prev = tokens[j]
      if (prev !== undefined && NEGATORS.has(prev.token)) {
        adjusted = -adjusted
        break
      }
    }
    for (let j = i - 1; j >= Math.max(lo, i - INTENSIFIER_LOOKBACK); j--) {
      const prev = tokens[j]
      if (prev === undefined) continue
      const mult = INTENSIFIER_MAP.get(prev.token)
      if (mult !== undefined) {
        adjusted *= mult
        break
      }
    }

    sum += adjusted
    hits += 1
  }

  return { sum, hits }
}

/** hits/(hits+3), capped: 1→0.25, 3→0.5, 9→0.75, ∞→0.95. */
export function confidenceFor(hits: number): number {
  if (hits <= 0) return 0
  return Math.min(0.95, hits / (hits + 3))
}

/** Article-level sentiment: the whole text as one window. Kept because the
 *  cluster view wants a coarse tone line — consumers must prefer the
 *  per-entity scores wherever an entity is on screen. */
export function articleSentiment(text: string): SentimentResult {
  const tokens = sentimentTokenize(text)
  return scoreWindow(tokens, 0, tokens.length - 1)
}

/**
 * Entity-level sentiment: lexicon hits within ±ENTITY_WINDOW_TOKENS of any
 * mention of the entity. Overlapping windows are merged (union of index
 * ranges) so a token between two nearby mentions is counted once.
 *
 * `mentionOffsets` are CHARACTER offsets into `text` — exactly what
 * extractEntities() returns — mapped here onto token indices.
 */
export function entitySentiment(params: {
  readonly text: string
  readonly mentionOffsets: readonly number[]
  readonly windowTokens?: number
}): SentimentResult {
  const window = params.windowTokens ?? ENTITY_WINDOW_TOKENS
  const tokens = sentimentTokenize(params.text)
  if (tokens.length === 0 || params.mentionOffsets.length === 0) return NO_SENTIMENT

  // Merge windows into disjoint [from, to] ranges over token indices.
  const ranges: { from: number; to: number }[] = []
  const sortedOffsets = [...params.mentionOffsets].sort((a, b) => a - b)
  for (const offset of sortedOffsets) {
    const idx = tokenIndexAt(tokens, offset)
    const from = idx - window
    const to = idx + window
    const last = ranges[ranges.length - 1]
    if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to)
    else ranges.push({ from, to })
  }

  // Aggregate across disjoint ranges: exact mean over the union of hits.
  let sum = 0
  let hits = 0
  for (const r of ranges) {
    const part = rawScoreWindow(tokens, r.from, r.to)
    sum += part.sum
    hits += part.hits
  }
  if (hits === 0) return NO_SENTIMENT
  const score = Math.max(-100, Math.min(100, Math.round((sum / hits) * 25)))
  return { score, hits, confidence: confidenceFor(hits) }
}

/** Index of the token containing (or nearest before) a character offset. */
function tokenIndexAt(tokens: readonly TokenSpan[], offset: number): number {
  // Binary search over starts: last token with start <= offset.
  let lo = 0
  let hi = tokens.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const span = tokens[mid]
    if (span === undefined) break
    if (span.start <= offset) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}
