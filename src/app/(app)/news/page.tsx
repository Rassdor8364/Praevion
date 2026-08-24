import type { Metadata } from 'next'
import { Suspense } from 'react'
import Link from 'next/link'
import {
  BOARD_CATEGORIES,
  getNewsOrchestrator,
  type BoardCategory,
} from '@/engines/news/orchestrator'
import { DataFreshness } from '@/ui/DataFreshness'
import { DataModeBanner } from '@/ui/DataModeBanner'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { EmptyState } from '@/ui/EmptyState'
import { ErrorState } from '@/ui/ErrorState'
import { Panel } from '@/ui/Panel'
import { SkeletonBlock } from '@/ui/SkeletonBlock'
import { cn } from '@/ui/lib'
import { AutoRefresh } from '../sports/AutoRefresh'
import { ClusterCard } from './ui'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'News' }

const CATEGORY_LABEL: Readonly<Record<BoardCategory, string>> = {
  markets: 'Markets',
  crypto: 'Crypto',
  tech: 'Tech',
  world: 'World',
  sports: 'Sports',
}

const BOARD_LIMIT = 30

function CategoryTabs({ active }: { readonly active: BoardCategory | null }) {
  const tab = (href: string, label: string, isActive: boolean) => (
    <Link
      key={label}
      href={href}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'border-b-2 px-3 py-1.5 text-xs transition-colors',
        isActive
          ? 'border-vx-accent text-vx-heading'
          : 'border-transparent text-vx-body hover:text-vx-heading',
      )}
    >
      {label}
    </Link>
  )
  return (
    <nav aria-label="News categories" className="flex flex-wrap gap-1 border-b border-vx-border pb-px">
      {tab('/news', 'All', active === null)}
      {BOARD_CATEGORIES.map((c) => tab(`/news?category=${c}`, CATEGORY_LABEL[c], active === c))}
    </nav>
  )
}

async function NewsBoardView({ category }: { readonly category: BoardCategory | null }) {
  const result = await getNewsOrchestrator().getNewsBoard()

  if (!result.ok) {
    return (
      <Panel title="News Clusters">
        <ErrorState message={result.error.message} />
      </Panel>
    )
  }

  const board = result.value
  const nowMs = Date.now()
  const filtered =
    category === null ? board.clusters : board.clusters.filter((c) => c.category === category)
  const clusters = filtered.slice(0, BOARD_LIMIT)

  return (
    <div className="space-y-5">
      {/* Breaking strip: rendered ONLY when velocity-earned breaking clusters
          exist right now. No manufactured urgency. */}
      {board.breaking.length > 0 && (
        <Panel
          title="Breaking — velocity-detected"
          className="border border-red-400/25"
          right={<span className="vx-num">{board.breaking.length} live</span>}
        >
          <ul className="divide-y divide-vx-border">
            {board.breaking.map((c) => (
              <ClusterCard key={c.cluster.id} scored={c} nowMs={nowMs} />
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title={category === null ? 'Story Clusters' : `Story Clusters — ${CATEGORY_LABEL[category]}`}
        right={
          <span className="flex items-center gap-3">
            <span className="vx-num">
              {filtered.length} clusters · {board.articleCount} articles
            </span>
            <DataFreshness dataAsOf={new Date(board.provenance.dataAsOf).toISOString()} />
          </span>
        }
      >
        <DataModeBanner mode={board.provenance.isDemo ? 'demo' : 'live'} className="mb-3" />
        {clusters.length === 0 ? (
          <EmptyState
            title="No story clusters in the current window"
            detail="RSS feeds expose a rolling window of recent items. An empty board means the feeds returned nothing for this category right now — not that nothing happened."
          />
        ) : (
          <ul className="divide-y divide-vx-border">
            {clusters.map((c) => (
              <ClusterCard key={c.cluster.id} scored={c} nowMs={nowMs} />
            ))}
          </ul>
        )}
      </Panel>

      <p className="max-w-3xl text-[10px] leading-relaxed text-vx-caption">
        Summaries are extractive (each cluster shows a member article&apos;s own lead — nothing is
        generated). Entities come from a curated dictionary; sentiment is lexicon-based and shown
        only when enough evidence supports it. Impact blends source reliability, independent-source
        count, entity importance, novelty and reporting velocity.
      </p>
    </div>
  )
}

function BoardSkeleton() {
  return (
    <Panel title="Story Clusters">
      <div className="space-y-3">
        {Array.from({ length: 8 }, (_, i) => (
          <SkeletonBlock key={i} className="h-16 w-full" />
        ))}
      </div>
    </Panel>
  )
}

interface PageProps {
  readonly searchParams: Promise<{ category?: string }>
}

export default async function NewsPage({ searchParams }: PageProps) {
  const requested = (await searchParams).category
  const category = (BOARD_CATEGORIES as readonly string[]).includes(requested ?? '')
    ? (requested as BoardCategory)
    : null

  return (
    <div className="space-y-5">
      <AutoRefresh />
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-sm font-semibold uppercase tracking-[0.18em] text-vx-heading">
          News Intelligence
        </h1>
        <p className="text-[10px] font-medium uppercase tracking-[0.32em] text-vx-body">
          Clustering · Entity Sentiment · Impact
        </p>
      </header>
      <CategoryTabs active={category} />
      <Suspense key={category ?? 'all'} fallback={<BoardSkeleton />}>
        <NewsBoardView category={category} />
      </Suspense>
      <DisclaimerFooter />
    </div>
  )
}
