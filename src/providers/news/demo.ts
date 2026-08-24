/**
 * ============================================================================
 * DEMO NEWS PROVIDER — FABRICATED HEADLINES. NOT REAL REPORTING.
 * ============================================================================
 *
 * Twelve fixed, plausible-sounding headlines so the news rail, the sentiment
 * pipeline and the AI Analyst's context builder can be developed and screenshot
 * without network access.
 *
 * None of these stories happened. None of these outlets published them. The
 * outlet names are invented for exactly that reason: attributing a fabricated
 * headline to a real newsroom is a fabricated quote, and this project will not
 * ship one even in a demo.
 *
 * Every payload is stamped `isDemo: true`, which forces `dataMode: 'demo'` on
 * any prediction that touches it and excludes that prediction from ALL accuracy
 * statistics. The registry only registers demo providers when VIXERA_ALLOW_DEMO
 * is set — see `demoAllowed()` in registry.ts.
 *
 * Timestamps are offsets from an INJECTED clock rather than Date.now(), so the
 * rail looks alive in dev (minutes-old items at the top) while a fixed clock in
 * a test produces byte-identical output on every run.
 * ============================================================================
 */

import { systemClock, type Clock, HOUR_MS, MINUTE_MS } from '@/core/clock'
import { ProviderError } from '@/core/errors'
import { err, ok } from '@/core/result'
import type {
  Capability,
  NewsProvider,
  ProviderHealth,
  ProviderResult,
  RawArticle,
  Sourced,
} from '../types'

const PROVIDER_ID = 'demo-news'

interface DemoStory {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly outlet: string
  readonly author: string | null
  readonly category: 'markets' | 'crypto' | 'business' | 'sports' | 'tech'
  /** Age at read time, in ms before the injected clock's `now`. */
  readonly ageMs: number
}

/**
 * Spread across categories and across the last 30 hours so that grouping,
 * relative-time formatting ("4m ago" vs "yesterday") and the freshness decay
 * curve all have something to bite on. Ordered oldest-last for readability; the
 * provider sorts on the way out regardless.
 */
const STORIES: readonly DemoStory[] = [
  {
    slug: 'liquidity-rotation',
    title: 'Demo Wire: Liquidity rotates into large-cap digital assets as volatility cools',
    summary:
      'Desk commentary points to a third consecutive session of narrowing realised volatility, with flow concentrated in the two largest assets by capitalisation.',
    outlet: 'Demo Wire',
    author: 'A. Sample',
    category: 'crypto',
    ageMs: 6 * MINUTE_MS,
  },
  {
    slug: 'rate-decision-preview',
    title: 'Demo Business Daily: Central bank expected to hold, statement language in focus',
    summary:
      'Economists surveyed for this fictional preview broadly expect no change, leaving the guidance paragraph as the session-defining variable.',
    outlet: 'Demo Business Daily',
    author: 'R. Placeholder',
    category: 'business',
    ageMs: 34 * MINUTE_MS,
  },
  {
    slug: 'etf-flows',
    title: 'Sample Markets: Spot fund flows turn positive for the first time in four sessions',
    summary:
      'Net creations resumed on moderate volume, reversing a short streak of redemptions across the fictional product complex.',
    outlet: 'Sample Markets',
    author: null,
    category: 'markets',
    ageMs: 52 * MINUTE_MS,
  },
  {
    slug: 'derivatives-funding',
    title: 'Demo Wire: Perpetual funding normalises after a week of elevated long financing',
    summary:
      'Eight-hour funding has returned to its long-run band, easing the carry cost that had been squeezing leveraged positioning.',
    outlet: 'Demo Wire',
    author: 'A. Sample',
    category: 'crypto',
    ageMs: 2 * HOUR_MS + 11 * MINUTE_MS,
  },
  {
    slug: 'chipmaker-guidance',
    title: 'Placeholder Tech Review: Fabricated chipmaker lifts guidance on datacentre demand',
    summary:
      'The invented company cited order backlog extending through the next two quarters, with margins guided modestly higher.',
    outlet: 'Placeholder Tech Review',
    author: 'M. Example',
    category: 'tech',
    ageMs: 3 * HOUR_MS + 25 * MINUTE_MS,
  },
  {
    slug: 'northgate-injury',
    title: 'Demo Sports Desk: Northgate United without first-choice keeper for weekend fixture',
    summary:
      'The fictional club confirmed a short-term absence, with the understudy expected to start against Riverton City.',
    outlet: 'Demo Sports Desk',
    author: 'J. Fixture',
    category: 'sports',
    ageMs: 4 * HOUR_MS + 40 * MINUTE_MS,
  },
  {
    slug: 'energy-inventories',
    title: 'Sample Markets: Crude draws more than expected in weekly inventory print',
    summary:
      'A larger-than-forecast draw in this invented series lifted front-month contracts before the move faded into the close.',
    outlet: 'Sample Markets',
    author: null,
    category: 'markets',
    ageMs: 6 * HOUR_MS + 15 * MINUTE_MS,
  },
  {
    slug: 'stablecoin-supply',
    title: 'Demo Crypto Report: Stablecoin supply expands for a fifth straight week',
    summary:
      'Aggregate supply growth in this fictional dataset is often read as dry powder entering the ecosystem rather than leaving it.',
    outlet: 'Demo Crypto Report',
    author: 'K. Ledger',
    category: 'crypto',
    ageMs: 9 * HOUR_MS,
  },
  {
    slug: 'retail-sales',
    title: 'Demo Business Daily: Retail sales flat as goods spending offsets services softness',
    summary:
      'The composition of the invented print mattered more than the headline, with a downward revision to the prior month.',
    outlet: 'Demo Business Daily',
    author: 'R. Placeholder',
    category: 'business',
    ageMs: 13 * HOUR_MS + 30 * MINUTE_MS,
  },
  {
    slug: 'riverton-form',
    title: 'Demo Sports Desk: Riverton City extend unbeaten run to six in fictional league',
    summary:
      'A late equaliser preserved the run and moved the invented side to within two points of the summit.',
    outlet: 'Demo Sports Desk',
    author: 'J. Fixture',
    category: 'sports',
    ageMs: 19 * HOUR_MS,
  },
  {
    slug: 'exchange-outage',
    title: 'Demo Wire: Fictional venue restores matching engine after 40-minute halt',
    summary:
      'Trading resumed with no reported loss of orders; the invented operator attributed the halt to a failed failover.',
    outlet: 'Demo Wire',
    author: null,
    category: 'crypto',
    ageMs: 25 * HOUR_MS + 5 * MINUTE_MS,
  },
  {
    slug: 'cloud-capex',
    title: 'Placeholder Tech Review: Hyperscaler capex plans point to another year of build-out',
    summary:
      'Aggregated guidance from these fictional operators implies continued double-digit growth in infrastructure spending.',
    outlet: 'Placeholder Tech Review',
    author: 'M. Example',
    category: 'tech',
    ageMs: 30 * HOUR_MS + 45 * MINUTE_MS,
  },
]

export class DemoNewsProvider implements NewsProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'Demo News (synthetic)'
  readonly reliability = 'UNVERIFIED' as const
  readonly isDemo = true
  readonly capabilities: readonly Capability[] = ['news.latest', 'news.search']

  /** The clock is injected so a fixed clock yields byte-identical output. */
  constructor(private readonly clock: Clock = systemClock) {}

  isConfigured(): boolean {
    return true // nothing to configure; the corpus is compiled in
  }

  async health(): Promise<ProviderHealth> {
    return { healthy: true, latencyMs: 0, message: 'synthetic provider' }
  }

  async getLatestNews(params: {
    category?: string
    limit: number
  }): Promise<ProviderResult<RawArticle[]>> {
    const now = this.clock.now()
    const category = params.category?.toLowerCase()
    const articles = STORIES.filter((s) => !category || s.category === category)
      .map((s) => toArticle(s, now))
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, Math.max(params.limit, 0))

    if (articles.length === 0 && category) {
      return err(
        new ProviderError({
          kind: 'not_found',
          providerId: PROVIDER_ID,
          message: `Demo corpus has no stories in category "${category}"`,
        }),
      )
    }

    const newest = articles[0]
    return ok(sourced(articles, newest ? newest.publishedAt : now))
  }

  async searchNews(params: { query: string; limit: number }): Promise<ProviderResult<RawArticle[]>> {
    const now = this.clock.now()
    // Same semantics as the live RSS adapter: a case-insensitive local substring
    // filter over title and summary, so a consumer cannot depend on search
    // behaviour that only the demo has.
    const needle = params.query.trim().toLowerCase()
    if (needle.length === 0) {
      return err(
        new ProviderError({
          kind: 'not_found',
          providerId: PROVIDER_ID,
          message: 'Empty search query',
        }),
      )
    }

    const articles = STORIES.map((s) => toArticle(s, now))
      .filter((a) => `${a.title} ${a.summary ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, Math.max(params.limit, 0))

    const newest = articles[0]
    return ok(sourced(articles, newest ? newest.publishedAt : now))
  }
}

function toArticle(story: DemoStory, now: number): RawArticle {
  return {
    // Slug-derived and stable: the same story keeps one id across runs, so an
    // upsert into the articles table stays idempotent in demo mode too.
    externalId: `demo-news-${story.slug}`,
    title: story.title,
    // example.invalid is reserved by RFC 6761 and can never resolve, so a demo
    // link cannot accidentally send a user to somebody's real site.
    url: `https://demo.example.invalid/${story.category}/${story.slug}`,
    sourceName: story.outlet,
    sourceId: PROVIDER_ID,
    author: story.author,
    publishedAt: now - story.ageMs,
    summary: story.summary,
    // Feeds never carry full text; the demo mirrors that so nothing downstream
    // learns to expect a body it will not get in production.
    body: null,
    category: story.category,
    imageUrl: null,
  }
}

function sourced<T>(data: T, dataAsOf: number): Sourced<T> {
  return {
    data,
    // isDemo: true is the entire contract of this file.
    provenance: { sourceId: PROVIDER_ID, fetchedAt: Date.now(), dataAsOf, isDemo: true },
  }
}
