import { cn, formatPct } from './lib'

export interface ProbabilityBarProps {
  /** 0..1 */
  readonly value: number
  readonly label?: string
  readonly className?: string
  /** Bar fill colour override (defaults to the neutral brand accent — never green/red). */
  readonly fill?: 'accent' | 'violet' | 'cyan'
  readonly compact?: boolean
}

const FILLS: Record<NonNullable<ProbabilityBarProps['fill']>, string> = {
  accent: 'bg-vx-accent-2',
  violet: 'bg-vx-accent',
  cyan: 'bg-vx-live',
}

/**
 * Probability is ALWAYS a horizontal bar plus a numeral — never a dial,
 * never a gauge. Fill is neutral blue: probability itself has no valence.
 */
export function ProbabilityBar({ value, label, className, fill = 'accent', compact = false }: ProbabilityBarProps) {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {label !== undefined && (
        <span
          className={cn(
            'shrink-0 truncate text-vx-body',
            compact ? 'w-14 text-[11px]' : 'w-24 text-xs',
          )}
          title={label}
        >
          {label}
        </span>
      )}
      <div
        className={cn('h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]')}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped * 100)}
        aria-label={label ?? 'Probability'}
      >
        <div className={cn('h-full rounded-full', FILLS[fill])} style={{ width: `${clamped * 100}%` }} />
      </div>
      <span className={cn('vx-num shrink-0 text-right text-vx-heading', compact ? 'w-11 text-[11px]' : 'w-13 text-xs')}>
        {formatPct(value)}
      </span>
    </div>
  )
}
