import { AlertTriangle, FlaskConical } from 'lucide-react'
import type { DataMode } from '@/core/prediction/types'
import { cn } from './lib'

export interface DataModeBannerProps {
  readonly mode: DataMode
  readonly className?: string
}

/**
 * Data-mode honesty strip (§19 no-fake-data guarantee).
 *
 *  - 'live'    → renders NOTHING. Live data needs no caveat.
 *  - 'partial' → persistent amber strip: some sources fell back or failed.
 *  - 'demo'    → prominent, non-dismissible violet strip. Demo numbers must be
 *                impossible to mistake for a live analysis.
 */
export function DataModeBanner({ mode, className }: DataModeBannerProps) {
  if (mode === 'live') return null

  if (mode === 'partial') {
    return (
      <div
        role="status"
        className={cn(
          'flex items-center gap-2 border border-amber-300/25 bg-amber-300/[0.07] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-amber-300',
          className,
        )}
      >
        <AlertTriangle size={12} aria-hidden />
        Partial data — some sources unavailable; quality degraded
      </div>
    )
  }

  return (
    <div
      role="alert"
      className={cn(
        'flex items-center gap-2 border border-violet-400/40 bg-violet-500/[0.14] px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-300',
        className,
      )}
    >
      <FlaskConical size={14} aria-hidden />
      Demo data — not a live analysis
    </div>
  )
}
