import type { RiskLevel } from '@/core/prediction/types'
import { cn } from './lib'

export interface RiskBadgeProps {
  readonly level: RiskLevel
  readonly className?: string
}

/** Subtle text badge. Slate → amber tints; never a loud alarm colour. */
const STYLES: Record<RiskLevel, string> = {
  low: 'text-slate-400 border-slate-400/20 bg-slate-400/[0.06]',
  medium: 'text-amber-300/70 border-amber-300/20 bg-amber-300/[0.05]',
  high: 'text-amber-300 border-amber-300/30 bg-amber-300/[0.08]',
  extreme: 'text-vx-neg border-red-400/30 bg-red-400/[0.07]',
}

export function RiskBadge({ level, className }: RiskBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.12em]',
        STYLES[level],
        className,
      )}
    >
      {level} risk
    </span>
  )
}
