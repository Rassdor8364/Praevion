import type { ModelOutput } from '@/core/prediction/types'
import { leadingOutcome } from '@/core/prediction/types'
import { cn, formatPct } from './lib'
import { ProbabilityBar } from './ProbabilityBar'

export interface ModelBreakdownProps {
  readonly models: readonly ModelOutput[]
  readonly className?: string
}

/**
 * Per-model transparency: every model in the pool, its leading-outcome
 * probability, confidence and combiner weight — and, when it abstained, the
 * honest reason it removed itself instead of a fabricated 50%.
 */
export function ModelBreakdown({ models, className }: ModelBreakdownProps) {
  if (models.length === 0) {
    return <p className={cn('text-xs text-vx-caption', className)}>No model outputs recorded.</p>
  }
  return (
    <ul className={cn('divide-y divide-vx-border', className)}>
      {models.map((m) => {
        const lead = m.abstained ? null : leadingOutcome({ outcomes: m.outcomes })
        return (
          <li key={m.modelId} className="flex items-center gap-3 py-1.5">
            <span className="w-36 shrink-0 truncate text-xs text-vx-body" title={`${m.modelId} ${m.modelVersion}`}>
              {m.modelId}
              <span className="ml-1 text-[10px] text-vx-caption">{m.modelVersion}</span>
            </span>
            {m.abstained ? (
              <span className="flex-1 text-[11px] uppercase tracking-[0.1em] text-vx-caption">
                Abstained{m.abstainReason !== null ? ` — ${m.abstainReason}` : ''}
              </span>
            ) : (
              <>
                <div className="flex-1">
                  <ProbabilityBar value={lead?.probability ?? 0} label={lead?.label} compact />
                </div>
                <span className="vx-num w-16 shrink-0 text-right text-[11px] text-vx-caption">
                  conf {formatPct(m.confidence, 0)}
                </span>
                <span className="vx-num w-14 shrink-0 text-right text-[11px] text-vx-caption">
                  w {m.weight.toFixed(2)}
                </span>
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}
