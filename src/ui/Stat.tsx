import { cn, formatSignedPct } from './lib'

export interface StatProps {
  readonly label: string
  readonly value: string
  /** Optional delta in percent units; coloured ONLY by sign (semantic). */
  readonly deltaPct?: number | null
  readonly className?: string
}

export function Stat({ label, value, deltaPct, className }: StatProps) {
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">{label}</span>
      <span className="vx-num text-sm text-vx-heading">
        {value}
        {deltaPct !== undefined && deltaPct !== null && (
          <span
            className={cn(
              'ml-2 text-xs',
              deltaPct > 0 ? 'text-vx-pos' : deltaPct < 0 ? 'text-vx-neg' : 'text-vx-body',
            )}
          >
            {formatSignedPct(deltaPct)}
          </span>
        )}
      </span>
    </div>
  )
}
