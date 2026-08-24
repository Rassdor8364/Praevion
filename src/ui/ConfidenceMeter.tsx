import { cn, formatPct } from './lib'

export interface ConfidenceMeterProps {
  /** 0..1 */
  readonly value: number
  readonly label?: string
  readonly segments?: number
  readonly className?: string
}

/** Small horizontal segmented meter for model confidence. */
export function ConfidenceMeter({ value, label = 'Confidence', segments = 10, className }: ConfidenceMeterProps) {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  const filled = Math.round(clamped * segments)
  return (
    <div
      className={cn('flex items-center gap-2', className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-label={label}
    >
      <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">{label}</span>
      <div className="flex items-center gap-[2px]">
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            className={cn('h-2 w-1 rounded-[1px]', i < filled ? 'bg-vx-accent' : 'bg-white/[0.07]')}
          />
        ))}
      </div>
      <span className="vx-num text-[11px] text-vx-heading">{formatPct(value, 0)}</span>
    </div>
  )
}
