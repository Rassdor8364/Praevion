/**
 * RawArticle → NormalizedArticle.
 *
 * Pure text plumbing, no I/O and no clock: everything downstream (entity
 * extraction, sentiment, clustering, dedup) consumes the output of this file,
 * so every transformation is deterministic and idempotent — running an already
 * normalized summary through stripHtml or canonicalizeUrl again is a no-op.
 *
 * The provider layer already strips most HTML from feed summaries, but this
 * module does NOT rely on that: normalization is provider-agnostic, and a
 * future provider (GDELT, a paid news API) may hand over raw fragments.
 */

import type { ReliabilityClass } from '@/core/prediction/types'
import type { RawArticle } from '@/providers/types'

export interface NormalizedArticle {
  /** Stable id — the urlHash. Two fetches of the same story agree on it. */
  readonly id: string
  /** FNV-1a of the canonical URL (tracking params stripped, host lowercased). */
  readonly urlHash: string
  readonly canonicalUrl: string
  /** The original, clickable URL — canonicalization is for identity, not links. */
  readonly url: string
  readonly title: string
  /** HTML-stripped teaser. Null when the feed carried none — never "". */
  readonly summary: string | null
  readonly sourceId: string
  readonly sourceName: string
  /** The feed's coarse category ('markets' | 'crypto' | ...), if declared. */
  readonly feedCategory: string | null
  /** Per-outlet trust, resolved by the caller from the feed definition. */
  readonly reliability: ReliabilityClass
  readonly publishedAt: number
  /**
   * Lowercased title+summary tokens with English stopwords removed — the
   * clustering vocabulary. Sentiment does NOT use these (negation words like
   * "not" are stopwords here but load-bearing there).
   */
  readonly tokens: readonly string[]
  /**
   * Hash of the sorted unique token set. Catches the same wire copy arriving
   * under two different URLs (syndication), which urlHash cannot.
   */
  readonly contentFingerprint: string
}

// ---------------------------------------------------------------------------
// Stopwords
// ---------------------------------------------------------------------------

/**
 * Compact English stopword list. Deliberately small: clustering similarity is
 * TF-IDF weighted, so a merely-common word already carries little weight — the
 * list only needs to kill the words so frequent they would still leak signal
 * into short headline vectors.
 */
const STOPWORDS = new Set<string>([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing',
  'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my',
  'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'our', 'ours', 'out', 'over', 'own', 'per', 'said', 'same', 'says', 'she',
  'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your', 'yours',
])

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token)
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Strip HTML tags and collapse whitespace. Decodes the entities that survive
 *  a feed round-trip; unknown named entities are left visible rather than
 *  silently deleted (deleting text is worse than showing "&foo;"). */
export function stripHtml(input: string): string {
  return decodeBasicEntities(input.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

const BASIC_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
}

function decodeBasicEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCode(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => BASIC_ENTITIES[name.toLowerCase()] ?? whole)
}

function safeFromCode(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Lowercase word tokens with stopwords removed — the clustering vocabulary.
 * Apostrophes are dropped inside words ("fed's" → "feds") so possessives and
 * plain plurals land on nearby, often identical, tokens.
 */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase().replace(/['’]/g, '')
  const raw = lowered.match(/[a-z0-9]+(?:[-.][a-z0-9]+)*/g) ?? []
  const out: string[] = []
  for (const t of raw) {
    if (t.length < 2) continue
    if (STOPWORDS.has(t)) continue
    out.push(t)
  }
  return out
}

// ---------------------------------------------------------------------------
// URL canonicalization + hashing
// ---------------------------------------------------------------------------

/** Query params that identify a click, not a document. */
const TRACKING_PARAM = /^(utm_|ref$|ref_|fbclid$|gclid$|msclkid$|mc_|cmp$|cmpid$|smid$|ito$|ns_|sref$|mod$|taid$|guccounter$|guce_)/i

/**
 * Canonical form of an article URL: scheme dropped, host lowercased, tracking
 * parameters removed, fragment removed, trailing slash removed. Remaining
 * query params are kept SORTED so parameter order cannot split an identity.
 */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    const kept: [string, string][] = []
    for (const [key, value] of u.searchParams.entries()) {
      if (!TRACKING_PARAM.test(key)) kept.push([key, value])
    }
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const query = kept.length === 0 ? '' : `?${kept.map(([k, v]) => `${k}=${v}`).join('&')}`
    const path = u.pathname.replace(/\/$/, '')
    return `${u.host.toLowerCase()}${path}${query}`
  } catch {
    // Unparseable URLs still make a usable identity key as-is.
    return url.trim().toLowerCase()
  }
}

/**
 * FNV-1a 32-bit, base36. Stable across processes and dependency-free; identity
 * hashing needs collision resistance over ~10^5 URLs, not cryptography.
 */
export function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Hash of the sorted unique token set — order- and repetition-insensitive. */
export function contentFingerprint(tokens: readonly string[]): string {
  const unique = [...new Set(tokens)].sort()
  return stableHash(unique.join(' '))
}

// ---------------------------------------------------------------------------
// Normalization + dedup
// ---------------------------------------------------------------------------

/**
 * Normalize one raw article. Returns null when the article cannot participate
 * in the pipeline at all (blank title after stripping — nothing to cluster,
 * nothing to display).
 */
export function normalizeArticle(
  raw: RawArticle,
  opts: { readonly reliability: ReliabilityClass },
): NormalizedArticle | null {
  const title = stripHtml(raw.title)
  if (title.length === 0) return null

  const cleanedSummary = raw.summary === null ? null : stripHtml(raw.summary) || null
  // Syndication feeds (Google News notably) ship the headline again as the
  // "summary", plus a publisher suffix. Keeping it would double-count every
  // title token in sentiment/mention counts and show the headline twice in the
  // UI — so a summary that adds nothing over the title is recorded as absent.
  const summary =
    cleanedSummary !== null && isRedundantSummary(title, cleanedSummary) ? null : cleanedSummary
  const canonicalUrl = canonicalizeUrl(raw.url)
  const urlHash = stableHash(canonicalUrl)
  const tokens = tokenize(summary === null ? title : `${title} ${summary}`)

  return {
    id: urlHash,
    urlHash,
    canonicalUrl,
    url: raw.url,
    title,
    summary,
    sourceId: raw.sourceId,
    sourceName: raw.sourceName,
    feedCategory: raw.category,
    reliability: opts.reliability,
    publishedAt: raw.publishedAt,
    tokens,
    contentFingerprint: contentFingerprint(tokens),
  }
}

/** True when the summary is the title again (± punctuation/casing) with at
 *  most a short suffix such as " - Publisher Name". */
export function isRedundantSummary(title: string, summary: string): boolean {
  const t = simplifyForComparison(title)
  const s = simplifyForComparison(summary)
  if (s.length === 0) return true
  return s.startsWith(t) && s.length - t.length <= 40
}

function simplifyForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Dedup by canonical URL first, then by content fingerprint (same wire copy
 * republished under a different URL). The FIRST occurrence wins, so callers
 * that care about which copy survives should sort before deduping — the
 * orchestrator sorts newest-first, keeping the freshest copy.
 */
export function dedupeArticles(articles: readonly NormalizedArticle[]): NormalizedArticle[] {
  const seenUrl = new Set<string>()
  const seenContent = new Set<string>()
  const out: NormalizedArticle[] = []
  for (const a of articles) {
    // Fingerprint dedup only engages with a meaningful token set: a headline
    // of pure stopwords would fingerprint identically to every other one and
    // collapse unrelated articles.
    const useFingerprint = a.tokens.length >= 3
    if (seenUrl.has(a.urlHash)) continue
    if (useFingerprint && seenContent.has(a.contentFingerprint)) continue
    seenUrl.add(a.urlHash)
    if (useFingerprint) seenContent.add(a.contentFingerprint)
    out.push(a)
  }
  return out
}
