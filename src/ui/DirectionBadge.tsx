import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react'
import type { Direction } from '@/core/prediction/types'
import { cn } from './lib'

export interface DirectionBadgeProps {
  readonly direction: Direction
  readonly className?: string
}

/** Muted green/red/slate — the ONLY place green/red appear is direction. */
export function DirectionBadge({ direction, className }: DirectionBadgeProps) {
  const style =
    direction === 'bullish'
      ? 'text-vx-pos border-emerald-400/25 bg-emerald-400/[0.06]'
      : direction === 'bearish'
        ? 'text-vx-neg border-red-400/25 bg-red-400/[0.06]'
        : 'text-slate-400 border-slate-400/20 bg-slate-400/[0.06]'
  const Icon = direction === 'bullish' ? ArrowUpRight : direction === 'bearish' ? ArrowDownRight : ArrowRight
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.12em]',
        style,
        className,
      )}
    >
      <Icon size={11} strokeWidth={2.2} aria-hidden />
      {direction}
    </span>
  )
}
