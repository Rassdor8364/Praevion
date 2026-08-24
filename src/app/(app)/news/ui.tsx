/**
 * Shared server-rendered pieces of the News screens.
 *
 * News-shaped (cluster cards, impact bars, entity sentiment chips) rather than
 * universal primitives — those come from src/ui and are composed here, the
 * same split the Sports screens use.
 *
 * Honesty rules enforced at this layer:
 *  - the summary is labelled as the lead of a named member article, and the
 *    cluster line says "Cluster of N reports" — no "AI summary" anywhere,
 *    because none exists (engines/news/seam.ts);
 *  - sentiment chips render ONLY above the confidence threshold; below it
 *    there is no chip at all rather than a fake neutral;
 *  - the BREAKING badge appears only on velocity-earned breaking clusters and
 *    UNVERIFIED on rumour clusters.
 */

import { ExternalLink } from 'lucide-react'
import { SENTIMENT_DISPLAY_CONFIDENCE } from '@/app/api/news/dto'
import { getEntity } from '@/engines/news/entities'
import type { ScoredCluster } from '@/engines/news/orchestrator'
import { cn } from '@/ui/lib'
import { formatRelative } from '../sports/ui'

// ---------------------------------------------------------------------------
// Badges + chips
// ---------------------------------------------------------------------------

export function BreakingBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 border border-red-400/40 bg-red-500/[0.12] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-red-300">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" aria-hidden />
      Breaking
    </span>
  )
}

export function UnverifiedBadge() {
  return (
    <span
      className="border border-amber-300/30 bg-amber-300/[0.08] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-300"
      title="No source of ESTABLISHED_MEDIA class or better — excluded from all market-signal output"
    >
      Unverified
    </span>
  )
}

export function CategoryChip({ category }: { readonly category: string }) {
  return (
    <span className="border border-vx-border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-vx-body">
      {category}
    </span>
  )
}

/**
 * Impact score 0-100 with a small bar. Neutral violet fill — impact measures
 * "how much this matters", which has no bullish/bearish valence.
 */
export function ImpactScore({ value, compact = false }: { readonly value: number; readonly compact?: boolean }) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <span className={cn('inline-flex items-center gap-2', compact ? 'w-24' : 'w-32')}>
      <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">Impact</span>
      <span
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        aria-label="Vixera News Impact Score"
      >
        <span className="block h-full rounded-full bg-vx-accent" style={{ width: `${clamped}%` }} />
      </span>
      <span className="vx-num w-6 shrink-0 text-right text-xs text-vx-heading">{Math.round(clamped)}</span>
    </span>
  )
}

/**
 * Per-entity sentiment chip. Rendered ONLY when confidence clears the
 * threshold (≥2 lexicon hits); a sub-threshold sentiment renders NO chip.
 * A confident score near zero is a real "flat" claim and renders slate.
 */
export function EntitySentimentChip({
  name,
  score,
}: {
  readonly name: string
  readonly score: number
}) {
  const tone =
    score > 15
      ? 'border-emerald-400/30 bg-emerald-400/[0.08] text-vx-pos'
      : score < -15
        ? 'border-red-400/30 bg-red-400/[0.08] text-vx-neg'
        : 'border-vx-border bg-white/[0.03] text-vx-body'
  const sign = score > 0 ? '+' : ''
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 border px-2 py-0.5 text-[11px]', tone)}>
      <span>{name}</span>
      <span className="vx-num">{sign}{score}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Cluster card
// ---------------------------------------------------------------------------

const MAX_SOURCE_NAMES = 5

export function ClusterCard({
  scored,
  nowMs,
}: {
  readonly scored: ScoredCluster
  readonly nowMs: number
}) {
  const { cluster, importance } = scored
  const sourceNames = [...new Set(cluster.members.map((m) => m.article.sourceName))]
  const shownSources = sourceNames.slice(0, MAX_SOURCE_NAMES)
  const chips = cluster.entities
    .filter((e) => e.sentiment.confidence >= SENTIMENT_DISPLAY_CONFIDENCE)
    .slice(0, 4)

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {importance.isBreaking && <BreakingBadge />}
        {importance.unverified && <UnverifiedBadge />}
        <CategoryChip category={scored.category} />
        <span className="vx-num ml-auto text-[11px] text-vx-caption" title="Time of the earliest report in this cluster">
          first detected {formatRelative(cluster.earliestPublishedAt, nowMs)}
        </span>
      </div>

      <h3 className="text-sm font-medium leading-snug text-vx-heading">
        <a
          href={scored.headlineArticle.url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-vx-accent"
        >
          {scored.headline}
          <ExternalLink size={11} className="mb-0.5 ml-1.5 inline-block text-vx-caption" aria-hidden />
        </a>
      </h3>

      {/* Mechanism label, not marketing: this is the article's own lead. */}
      {scored.extractiveSummary !== null && (
        <p className="max-w-3xl text-xs leading-relaxed text-vx-body">
          {truncate(scored.extractiveSummary, 260)}
          <span className="ml-1.5 text-[10px] uppercase tracking-[0.12em] text-vx-caption">
            — lead via {scored.headlineArticle.sourceName}
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ImpactScore value={importance.importance} />
        <span className="text-[11px] text-vx-body">
          Cluster of <span className="vx-num text-vx-heading">{cluster.members.length}</span> report
          {cluster.members.length === 1 ? '' : 's'} ·{' '}
          <span className="vx-num text-vx-heading">{cluster.sourceCount}</span> source
          {cluster.sourceCount === 1 ? '' : 's'}
          <span className="ml-1.5 text-vx-caption">{shownSources.join(' · ')}{sourceNames.length > shownSources.length ? ` +${sourceNames.length - shownSources.length}` : ''}</span>
        </span>
        {chips.map((e) => {
          const definition = getEntity(e.entityId)
          if (definition === null) return null
          return <EntitySentimentChip key={e.entityId} name={definition.name} score={e.sentiment.score} />
        })}
      </div>

      {cluster.members.length > 1 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-[11px] text-vx-caption hover:text-vx-body">
            <span className="group-open:hidden">Show all {cluster.members.length} reports ▸</span>
            <span className="hidden group-open:inline">Hide reports ▾</span>
          </summary>
          <ul className="mt-2 space-y-1 border-l border-vx-border pl-3">
            {cluster.members.map((m) => (
              <li key={m.article.id} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                <span className="w-28 shrink-0 truncate text-vx-caption">{m.article.sourceName}</span>
                <a
                  href={m.article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-vx-body hover:text-vx-accent"
                >
                  {m.article.title}
                </a>
                <span className="vx-num shrink-0 text-vx-caption">
                  {formatRelative(m.article.publishedAt, nowMs)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  )
}

/** Compact row for the Command Center panel. */
export function ClusterRow({
  scored,
  nowMs,
}: {
  readonly scored: ScoredCluster
  readonly nowMs: number
}) {
  const { cluster, importance } = scored
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      {importance.isBreaking && <BreakingBadge />}
      {importance.unverified && <UnverifiedBadge />}
      <a
        href={scored.headlineArticle.url}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 basis-64 truncate text-xs text-vx-heading hover:text-vx-accent"
        title={scored.headline}
      >
        {scored.headline}
      </a>
      <span className="vx-num text-[11px] text-vx-caption">
        {cluster.sourceCount} src
      </span>
      <ImpactScore value={importance.importance} compact />
      <span className="vx-num text-[11px] text-vx-caption">
        {formatRelative(cluster.earliestPublishedAt, nowMs)}
      </span>
    </li>
  )
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}
