'use client'

/**
 * "Updated Xs ago" indicator. Client component: re-renders every 5 seconds so
 * the age is honest without a page reload. The dot colour tracks age, not
 * excitement: cyan = recent, slate = aging, amber = old.
 */

import { useEffect, useState } from 'react'
import { formatAge } from '@/core/quality/freshness'
import { MINUTE_MS } from '@/core/clock'
import { cn } from './lib'

export interface DataFreshnessProps {
  /** ISO timestamp of the data's as-of instant. */
  readonly dataAsOf: string
  readonly className?: string
}

export function DataFreshness({ dataAsOf, className }: DataFreshnessProps) {
  const [nowMs, setNowMs] = useState<number | null>(null)

  useEffect(() => {
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [])

  const ts = Date.parse(dataAsOf)
  if (!Number.isFinite(ts)) {
    return <span className={cn('text-[11px] text-vx-caption', className)}>Updated: unknown</span>
  }

  // Before hydration completes we render the label without an age to avoid a
  // server/client mismatch (the server's clock is not the client's clock).
  const age = nowMs === null ? null : Math.max(0, nowMs - ts)
  const dot =
    age === null
      ? 'bg-slate-500'
      : age < 2 * MINUTE_MS
        ? 'bg-vx-live'
        : age < 30 * MINUTE_MS
          ? 'bg-slate-500'
          : 'bg-vx-warn'

  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] text-vx-caption', className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} aria-hidden />
      <span className="vx-num" suppressHydrationWarning>
        {age === null ? 'Updated —' : age < 5_000 ? 'Live' : `Updated ${formatAge(age)} ago`}
      </span>
    </span>
  )
}
