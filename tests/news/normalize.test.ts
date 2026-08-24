import { describe, expect, it } from 'vitest'

import {
  canonicalizeUrl,
  contentFingerprint,
  dedupeArticles,
  normalizeArticle,
  stableHash,
  stripHtml,
  tokenize,
} from '@/engines/news/normalize'
import { makeNormalized, makeRaw, T0 } from './fixtures'

describe('canonicalizeUrl', () => {
  it('strips tracking parameters', () => {
    expect(
      canonicalizeUrl('https://example.com/story?utm_source=rss&utm_medium=feed&fbclid=abc123'),
    ).toBe('example.com/story')
    expect(canonicalizeUrl('https://example.com/story?gclid=x&mc_cid=y&ref=homepage')).toBe(
      'example.com/story',
    )
  })

  it('keeps meaningful params and sorts them so order cannot split identity', () => {
    expect(canonicalizeUrl('https://example.com/story?b=2&a=1')).toBe(
      canonicalizeUrl('https://example.com/story?a=1&b=2'),
    )
    expect(canonicalizeUrl('https://example.com/story?id=42&utm_source=x')).toBe(
      'example.com/story?id=42',
    )
  })

  it('drops scheme, fragment and trailing slash; lowercases the host', () => {
    expect(canonicalizeUrl('HTTPS://Example.COM/Story/#section-2')).toBe('example.com/Story')
    expect(canonicalizeUrl('http://example.com/story/')).toBe('example.com/story')
  })

  it('falls back to a lowercased trim for unparseable input', () => {
    expect(canonicalizeUrl('  Not A Url  ')).toBe('not a url')
  })
})

describe('stableHash', () => {
  it('is stable for equal input and distinct for different input', () => {
    expect(stableHash('example.com/story')).toBe(stableHash('example.com/story'))
    expect(stableHash('example.com/story')).not.toBe(stableHash('example.com/other'))
  })

  it('does not change across releases (pinned value)', () => {
    // If this fails, every stored urlHash-derived identity breaks: bump only
    // with a migration story.
    expect(stableHash('example.com/story')).toBe('ggue4w')
  })
})

describe('stripHtml', () => {
  it('removes tags and decodes common entities', () => {
    expect(stripHtml('<p>Fed <b>holds</b> rates &amp; signals cuts&hellip;</p>')).toBe(
      'Fed holds rates & signals cuts…',
    )
  })

  it('is idempotent on already-clean text', () => {
    const clean = 'Fed holds rates & signals cuts'
    expect(stripHtml(clean)).toBe(clean)
  })
})

describe('tokenize', () => {
  it('lowercases, removes stopwords, keeps numbers and hyphenated terms', () => {
    expect(tokenize('The Fed is holding rates at 5.25 for now')).toEqual([
      'fed',
      'holding',
      'rates',
      '5.25',
    ])
  })

  it('drops possessive apostrophes onto the base token', () => {
    expect(tokenize("Tesla's earnings")).toEqual(['teslas', 'earnings'])
  })
})

describe('normalizeArticle', () => {
  it('strips HTML from the summary and hashes the canonical URL', () => {
    const a = makeNormalized({
      title: 'Bitcoin climbs past $70,000',
      summary: '<p>The largest crypto asset &amp; its peers rallied.</p>',
      url: 'https://example.com/btc-70k?utm_source=rss',
    })
    expect(a.summary).toBe('The largest crypto asset & its peers rallied.')
    expect(a.canonicalUrl).toBe('example.com/btc-70k')
    expect(a.urlHash).toBe(stableHash('example.com/btc-70k'))
    expect(a.id).toBe(a.urlHash)
  })

  it('returns null when the title strips to nothing', () => {
    expect(
      normalizeArticle(makeRaw({ title: '<img src="https://example.com/x.png">' }), {
        reliability: 'ESTABLISHED_MEDIA',
      }),
    ).toBeNull()
  })

  it('nulls a summary that merely repeats the headline (syndication feeds)', () => {
    const a = makeNormalized({
      title: 'Fed should raise rates to restrain growth, Hammack says',
      summary: 'Fed should raise rates to restrain growth, Hammack says&nbsp;&nbsp;Reuters',
    })
    expect(a.summary).toBeNull()

    const b = makeNormalized({
      title: 'Fed should raise rates to restrain growth, Hammack says',
      summary: 'The Cleveland Fed president argued current policy is not restrictive enough.',
    })
    expect(b.summary).not.toBeNull()
  })

  it('fingerprint is order- and repetition-insensitive', () => {
    expect(contentFingerprint(['fed', 'rates', 'fed'])).toBe(contentFingerprint(['rates', 'fed']))
    expect(contentFingerprint(['fed', 'rates'])).not.toBe(contentFingerprint(['fed', 'cuts']))
  })
})

describe('dedupeArticles', () => {
  it('collapses the same story under different tracking params (urlHash)', () => {
    const a = makeNormalized({
      title: 'Nvidia beats earnings estimates',
      url: 'https://example.com/nvda?utm_source=feedA',
      publishedAt: T0,
    })
    const b = makeNormalized({
      title: 'Nvidia beats earnings estimates',
      url: 'https://example.com/nvda?utm_source=feedB',
      publishedAt: T0 - 1000,
    })
    const out = dedupeArticles([a, b])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(a) // first occurrence wins
  })

  it('collapses identical wire copy under different URLs (fingerprint)', () => {
    const a = makeNormalized({
      title: 'Nvidia beats earnings estimates for the quarter',
      url: 'https://outlet-one.com/markets/nvda-earnings',
    })
    const b = makeNormalized({
      title: 'Nvidia beats earnings estimates for the quarter',
      url: 'https://outlet-two.com/tech/nvidia-q2',
    })
    expect(dedupeArticles([a, b])).toHaveLength(1)
  })

  it('keeps genuinely different stories', () => {
    const a = makeNormalized({ title: 'Nvidia beats earnings estimates strongly today' })
    const b = makeNormalized({ title: 'Boeing faces new regulatory probe overseas' })
    expect(dedupeArticles([a, b])).toHaveLength(2)
  })
})
