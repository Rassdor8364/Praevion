'use client'

/**
 * Client-side sort over a server-fetched opportunity set. Sorting never
 * refetches — the set is one scan snapshot, and re-sorting a snapshot is a
 * pure view operation.
 */

import { useMemo, useState } from 'react'
import type { VixeraOpportunity } from '@/core/markets/types'
import { EmptyState } from '@/ui/EmptyState'
import { MarketOpportunityCard } from '@/ui/MarketOpportunityCard'
import { cn } from '@/ui/lib'

type SortKey = 'score' | 'edge' | 'confidence' | 'liquidity' | 'ending_soon'

const SORTS: readonly { key: SortKey; label: string }[] = [
  { key: 'score', label: 'Score' },
  { key: 'edge', label: 'Edge' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'ending_soon', label: 'Ending soon' },
]

function sortOpportunities(list: readonly VixeraOpportunity[], key: SortKey): VixeraOpportunity[] {
  const sorted = [...list]
  switch (key) {
    case 'score':
      sorted.sort((a, b) => b.opportunityScore - a.opportunityScore)
      break
    case 'edge':
      sorted.sort((a, b) => Math.abs(b.edgePp) - Math.abs(a.edgePp))
      break
    case 'confidence':
      sorted.sort((a, b) => b.confidence - a.confidence)
      break
    case 'liquidity':
      sorted.sort((a, b) => b.liquidity.score - a.liquidity.score)
      break
    case 'ending_soon':
      sorted.sort(
        (a, b) =>
          (a.hoursToResolution ?? Number.POSITIVE_INFINITY) -
          (b.hoursToResolution ?? Number.POSITIVE_INFINITY),
      )
      break
  }
  return sorted
}

export function EdgeExplorer({ opportunities }: { readonly opportunities: readonly VixeraOpportunity[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const sorted = useMemo(() => sortOpportunities(opportunities, sortKey), [opportunities, sortKey])

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1" role="group" aria-label="Sort opportunities">
        <span className="mr-1 text-[10px] uppercase tracking-[0.16em] text-vx-caption">Sort</span>
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSortKey(s.key)}
            aria-pressed={sortKey === s.key}
            className={cn(
              'rounded border px-2 py-1 text-[11px] transition-colors',
              sortKey === s.key
                ? 'border-vx-accent/50 bg-vx-accent/10 text-vx-heading'
                : 'border-vx-border text-vx-body hover:border-vx-border-strong hover:text-vx-heading',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      {sorted.length === 0 ? (
        <EmptyState
          title="No actionable opportunities in this scan"
          detail="Every covered market was either fairly priced, too thin, or too uncertain — see the No Action section below for the reasons."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {sorted.map((o) => (
            <MarketOpportunityCard key={o.id} opportunity={o} />
          ))}
        </div>
      )}
    </div>
  )
}
