/**
 * RSS / Atom news aggregation.
 *
 * News enters Vixera through public feeds rather than a paid news API because
 * every serious outlet still publishes one, they need no key, and they carry the
 * publisher's own timestamp — which is what the freshness scorer actually needs.
 *
 * Two deliberate constraints shape this file:
 *
 *   1. NO XML DEPENDENCY. A full parser would pull a transitive tree into a
 *      Next.js edge-capable bundle for what amounts to reading six fields out of
 *      a flat document. The parser below is string/regex based, handles RSS 2.0
 *      and Atom, and treats anything it cannot understand as a skipped item
 *      rather than an exception.
 *   2. PARTIAL FAILURE IS NORMAL. Feeds rot, rate-limit and 503 constantly. One
 *      dead feed must never fail the whole call, so failures are counted and an
 *      error is returned only when EVERY feed failed.
 */

import { ProviderError } from '@/core/errors'
import { err, ok } from '@/core/result'
import type { ReliabilityClass } from '@/core/prediction/types'
import { fetchText } from '../http'
import type {
  Capability,
  NewsProvider,
  ProviderHealth,
  ProviderResult,
  RawArticle,
  Sourced,
} from '../types'

const PROVIDER_ID = 'rss'

export interface FeedDefinition {
  readonly id: string
  readonly name: string
  readonly url: string
  /** Coarse topic bucket used to narrow a fetch; matched case-insensitively. */
  readonly category: 'markets' | 'crypto' | 'business' | 'sports' | 'tech' | 'world'
  /** Per-outlet trust, which can be finer-grained than the provider's own class. */
  readonly reliability: ReliabilityClass
}

/**
 * The feed list is exported so the UI can show which sources are in play and so
 * tests can target a single feed.
 *
 * A note on the first two entries: Reuters and the AP both retired their public
 * RSS endpoints, so their headlines are read through Google News' syndication
 * search restricted to the publisher's own domain. The content and the byline
 * are still the wire service's, but the transport is a third party, which is why
 * they are rated one notch below the outlets that serve their own XML.
 */
export const FEEDS: readonly FeedDefinition[] = [
  {
    id: 'reuters',
    name: 'Reuters (via syndication)',
    url: 'https://news.google.com/rss/search?q=site:reuters.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    category: 'markets',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'ap',
    name: 'Associated Press (via syndication)',
    url: 'https://news.google.com/rss/search?q=site:apnews.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    category: 'business',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'cnbc',
    name: 'CNBC',
    // The canonical www.cnbc.com/id/.../rss.html endpoint answers 403 to
    // non-browser fetches (probed 2026-08-13); this search-mirror of the same
    // Top News feed id serves identical items and returns 200 to a plain UA.
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',
    category: 'markets',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'wsj-markets',
    name: 'WSJ Markets',
    url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
    category: 'markets',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'wsj-world',
    name: 'WSJ World',
    url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
    category: 'world',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'coindesk',
    name: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    category: 'crypto',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'the-block',
    name: 'The Block',
    url: 'https://www.theblock.co/rss.xml',
    category: 'crypto',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'cointelegraph',
    name: 'Cointelegraph',
    url: 'https://cointelegraph.com/rss',
    // Rated below CoinDesk/The Block: it runs a higher volume of speculative
    // price-prediction copy, which the sentiment model should weight accordingly.
    category: 'crypto',
    reliability: 'SECONDARY',
  },
  {
    id: 'bbc-business',
    name: 'BBC Business',
    url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    category: 'business',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'bbc-world',
    name: 'BBC World',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    category: 'world',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'bbc-sport',
    name: 'BBC Sport',
    url: 'https://feeds.bbci.co.uk/sport/rss.xml',
    category: 'sports',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'guardian-world',
    name: 'The Guardian World',
    url: 'https://www.theguardian.com/world/rss',
    category: 'world',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'techcrunch',
    name: 'TechCrunch',
    url: 'https://techcrunch.com/feed/',
    category: 'tech',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'the-verge',
    name: 'The Verge',
    url: 'https://www.theverge.com/rss/index.xml',
    category: 'tech',
    reliability: 'ESTABLISHED_MEDIA',
  },
  {
    id: 'ars-technica',
    name: 'Ars Technica',
    url: 'https://feeds.arstechnica.com/arstechnica/index',
    category: 'tech',
    reliability: 'ESTABLISHED_MEDIA',
  },
]

/**
 * How far back searchNews can see. RSS feeds only expose a rolling window
 * (typically 20–100 items), so this is the hard ceiling on local search.
 */
const SEARCH_POOL_SIZE = 400

export class RssNewsProvider implements NewsProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'RSS Feeds'
  readonly reliability = 'ESTABLISHED_MEDIA' as const
  readonly isDemo = false
  readonly capabilities: readonly Capability[] = ['news.latest', 'news.search']

  isConfigured(): boolean {
    return true // public feeds, no key required
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const probe = FEEDS[0]
    if (!probe) return { healthy: false, latencyMs: null, message: 'no feeds configured' }
    const r = await fetchText({
      providerId: this.id,
      url: probe.url,
      headers: headers(),
      timeoutMs: 8000,
      retries: 0,
    })
    return {
      healthy: r.ok,
      latencyMs: Date.now() - started,
      message: r.ok ? null : r.error.message,
    }
  }

  async getLatestNews(params: {
    category?: string
    limit: number
  }): Promise<ProviderResult<RawArticle[]>> {
    // Hoisted out of the closure: TypeScript cannot keep a narrowing on a
    // property access alive across a callback boundary.
    const category = params.category?.toLowerCase()
    const selected = category ? FEEDS.filter((f) => f.category === category) : FEEDS

    if (selected.length === 0) {
      return err(
        new ProviderError({
          kind: 'not_found',
          providerId: this.id,
          message: `No RSS feed configured for category "${params.category ?? ''}"`,
        }),
      )
    }

    // Concurrent: ten sequential fetches would put the p95 of a news panel into
    // the tens of seconds. No token bucket is applied — the bucket is keyed by
    // provider id and would serialise these ten independent hosts for no reason.
    const settled = await Promise.all(selected.map((feed) => this.loadFeed(feed)))

    const articles: RawArticle[] = []
    const failures: ProviderError[] = []
    for (const outcome of settled) {
      if (outcome.ok) articles.push(...outcome.value)
      else failures.push(outcome.error)
    }

    // Only a total blackout is an error. Anything else is a successful partial
    // read, and the caller sees fewer sources rather than nothing at all.
    if (articles.length === 0) {
      const first = failures[0]
      return err(
        new ProviderError({
          kind: first?.kind ?? 'upstream_unavailable',
          providerId: this.id,
          message: `All ${selected.length} RSS feeds failed`,
          detail: failures
            .slice(0, 4)
            .map((f) => f.message)
            .join('; '),
        }),
      )
    }

    const ranked = dedupeByUrl(articles).sort((a, b) => b.publishedAt - a.publishedAt)
    const limited = ranked.slice(0, Math.max(params.limit, 0))
    const newest = limited[0]
    return ok(sourced(limited, newest ? newest.publishedAt : Date.now()))
  }

  async searchNews(params: { query: string; limit: number }): Promise<ProviderResult<RawArticle[]>> {
    // ---------------------------------------------------------------------
    // RSS has NO server-side search. This is a LOCAL filter over the recent
    // window that the feeds happen to expose right now — typically the last few
    // hours to a couple of days. It cannot find an article that has already
    // rolled off a feed, and a query returning nothing means "not in the current
    // window", not "never published". Callers that need archive search need a
    // different provider.
    // ---------------------------------------------------------------------
    const needle = params.query.trim().toLowerCase()
    if (needle.length === 0) {
      return err(
        new ProviderError({
          kind: 'not_found',
          providerId: this.id,
          message: 'Empty search query',
        }),
      )
    }

    const pool = await this.getLatestNews({ limit: SEARCH_POOL_SIZE })
    if (!pool.ok) return err(pool.error)

    const matched = pool.value.data.filter((a) => {
      const haystack = `${a.title} ${a.summary ?? ''}`.toLowerCase()
      return haystack.includes(needle)
    })

    const limited = matched.slice(0, Math.max(params.limit, 0))
    const newest = limited[0]
    return ok(sourced(limited, newest ? newest.publishedAt : pool.value.provenance.dataAsOf))
  }

  private async loadFeed(feed: FeedDefinition) {
    // One retry only: a feed that is down stays down for minutes, and nine
    // healthy feeds should not wait on it.
    const r = await fetchText({
      providerId: this.id,
      url: feed.url,
      headers: headers(),
      timeoutMs: 9000,
      retries: 1,
    })
    if (!r.ok) return r
    return ok(parseFeed(r.value, feed))
  }
}

function headers(): Record<string, string> {
  // Several publishers (notably WSJ and CNBC) serve 403 to a default fetch UA.
  return { 'User-Agent': 'VixeraIntelligence/1.0 (+news aggregation)' }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Extract articles from an RSS 2.0 or Atom document.
 *
 * Both formats are handled in one pass because a publisher can and does switch
 * between them without notice, and the caller should never have to care.
 */
export function parseFeed(xml: string, feed: FeedDefinition): RawArticle[] {
  const blocks = [...matchAll(xml, /<item[\s>][\s\S]*?<\/item>/gi), ...matchAll(xml, /<entry[\s>][\s\S]*?<\/entry>/gi)]

  const articles: RawArticle[] = []
  for (const block of blocks) {
    const title = tagText(block, 'title')
    const url = extractLink(block)
    // A title-less or link-less entry cannot be displayed or deduped, so it is
    // dropped instead of being rendered as an empty row.
    if (!title || !url) continue

    const published = extractPublished(block)
    // No parseable date means we cannot place it on a timeline or score its
    // freshness; that is disqualifying for a signal source.
    if (published === null) continue

    const summary =
      tagText(block, 'description') ?? tagText(block, 'summary') ?? tagText(block, 'content')

    articles.push({
      // Hash of the CANONICAL url — tracking parameters stripped — so the same
      // story syndicated to two feeds hashes identically and an upsert by
      // externalId is idempotent. GUIDs cannot serve this purpose: publishers
      // rewrite them, and Atom ids are frequently URNs unrelated to the link.
      externalId: `rss-${fnv1a(canonicalUrl(url))}`,
      title: plainText(title),
      url,
      sourceName: feed.name,
      sourceId: feed.id,
      author: extractAuthor(block),
      publishedAt: published,
      // Summaries are HTML fragments; tags are stripped so the text can be
      // embedded, tokenised or truncated without leaking markup into the UI.
      summary: summary ? plainText(summary).slice(0, 1200) || null : null,
      // Feeds carry a teaser, never the full article. Claiming otherwise would
      // let a summarisation model think it saw the whole piece.
      body: null,
      category: feed.category,
      imageUrl: extractImage(block),
    })
  }

  return articles
}

function matchAll(input: string, re: RegExp): string[] {
  const out: string[] = []
  for (const m of input.matchAll(re)) {
    const hit = m[0]
    if (hit !== undefined) out.push(hit)
  }
  return out
}

/**
 * First text content of a tag, namespace-prefix tolerant ('dc:creator' matches a
 * request for 'creator'). Self-closing tags return null.
 */
function tagText(block: string, tag: string): string | null {
  const re = new RegExp(`<(?:[a-z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z0-9]+:)?${tag}>`, 'i')
  const m = re.exec(block)
  const inner = m?.[1]
  if (inner === undefined) return null
  const text = stripCdata(inner).trim()
  return text.length > 0 ? text : null
}

function attr(fragment: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(fragment)
  return m?.[1] ?? null
}

/**
 * RSS puts the URL in `<link>`'s text; Atom puts it in a `href` attribute and
 * may list several `<link>` elements with different `rel` values, of which only
 * `alternate` (or an unqualified one) is the article itself.
 */
function extractLink(block: string): string | null {
  const rss = tagText(block, 'link')
  if (rss && /^https?:\/\//i.test(rss)) return decodeEntities(rss)

  for (const linkTag of matchAll(block, /<link\b[^>]*\/?>/gi)) {
    const rel = attr(linkTag, 'rel')
    if (rel !== null && rel !== 'alternate') continue
    const href = attr(linkTag, 'href')
    if (href && /^https?:\/\//i.test(href)) return decodeEntities(href)
  }

  // Some feeds only give a permalink guid.
  const guid = tagText(block, 'guid')
  if (guid && /^https?:\/\//i.test(guid)) return decodeEntities(guid)
  return null
}

/** RSS uses pubDate; Atom uses published, falling back to updated. */
function extractPublished(block: string): number | null {
  for (const tag of ['pubDate', 'published', 'updated', 'date']) {
    const raw = tagText(block, tag)
    if (!raw) continue
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function extractAuthor(block: string): string | null {
  // dc:creator is the RSS convention; Atom nests a <name> inside <author>.
  const creator = tagText(block, 'creator')
  if (creator) return plainText(creator) || null

  const authorBlock = /<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/i.exec(block)?.[1]
  if (authorBlock) {
    // Atom nests <name>; some feeds put a bare string (or an email) in <author>.
    const name = tagText(authorBlock, 'name') ?? authorBlock
    const clean = plainText(name)
    if (clean.length > 0) return clean
  }
  return null
}

function extractImage(block: string): string | null {
  for (const tag of matchAll(block, /<(?:media:content|media:thumbnail|enclosure)\b[^>]*\/?>/gi)) {
    const url = attr(tag, 'url')
    if (url && /^https?:\/\//i.test(url)) return decodeEntities(url)
  }
  // Last resort: the first <img> inside an HTML description.
  const img = /<img\b[^>]*\bsrc\s*=\s*"([^"]+)"/i.exec(block)?.[1]
  return img && /^https?:\/\//i.test(img) ? decodeEntities(img) : null
}

function stripCdata(input: string): string {
  return input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
}

/**
 * Feed text → display text, decoding twice on purpose.
 *
 * There are genuinely two layers of encoding here. The XML layer escapes the
 * field's text (`&lt;p&gt;`), and the text it yields is itself an HTML fragment
 * whose own entities (`&amp;`, `&#8217;`) still need resolving. Decoding once
 * and stripping would emit a literal "<p>Some <b>html</b>" into the UI; decoding
 * once *after* stripping would leave "&amp;" visible in a headline. So: decode
 * (XML) → strip tags (HTML structure) → decode (HTML entities).
 */
function plainText(raw: string): string {
  return decodeEntities(stripTags(decodeEntities(stripCdata(raw)))).trim()
}

/**
 * The handful of HTML named entities that actually appear in feed text.
 *
 * XML defines only five; everything here beyond those is HTML's, and strictly
 * speaking illegal in an XML document — but publishers emit them constantly
 * (`&nbsp;` in particular arrives in almost every syndicated summary). The full
 * HTML5 named-character table is ~2,000 entries and is not worth bundling for
 * the dozen that occur in practice.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  trade: '™',
  reg: '®',
  copy: '©',
  deg: '°',
}

/**
 * Decode the five XML predefined entities, numeric references, and the common
 * HTML named entities above.
 *
 * `&amp;` is decoded LAST, otherwise "&amp;lt;" — a literal, escaped "&lt;"
 * inside a headline — would round-trip into a "<" and corrupt the text.
 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => fromCode(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function fromCode(code: number): string {
  // Reject out-of-range or malformed references rather than throwing inside a
  // replace callback, which would take down the whole feed parse.
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * FNV-1a, 32-bit, rendered base36.
 *
 * Not a cryptographic hash and does not need to be — it only has to be stable
 * across processes and collision-resistant enough for a few hundred thousand
 * URLs, and it must be dependency-free to keep this adapter edge-deployable.
 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * Dedupe by URL, keeping the first occurrence.
 *
 * Wire copy is syndicated widely and the same story arrives from several feeds;
 * counting it twice would double its weight in any sentiment aggregate. The URL
 * is normalised first because publishers append per-feed tracking parameters to
 * what is otherwise the identical link.
 */
function dedupeByUrl(articles: readonly RawArticle[]): RawArticle[] {
  const seen = new Set<string>()
  const out: RawArticle[] = []
  for (const a of articles) {
    const key = canonicalUrl(a.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const param of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|fbclid|gclid|mc_|cmp$)/i.test(param)) u.searchParams.delete(param)
    }
    u.hash = ''
    return `${u.host}${u.pathname}${u.search}`.replace(/\/$/, '').toLowerCase()
  } catch {
    // A URL the platform cannot parse is still a usable dedupe key as-is.
    return url.toLowerCase()
  }
}

function sourced<T>(data: T, dataAsOf: number): Sourced<T> {
  return {
    data,
    provenance: { sourceId: PROVIDER_ID, fetchedAt: Date.now(), dataAsOf, isDemo: false },
  }
}
