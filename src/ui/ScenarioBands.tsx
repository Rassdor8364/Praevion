import type { Scenario } from '@/core/prediction/types'
import { cn, formatUsd } from './lib'
import { ProbabilityBar } from './ProbabilityBar'

export interface ScenarioBandsProps {
  readonly scenarios: readonly Scenario[]
  readonly className?: string
}

/** Bull / base / bear bands: probability bar + target price range. */
export function ScenarioBands({ scenarios, className }: ScenarioBandsProps) {
  if (scenarios.length === 0) {
    return <p className={cn('text-xs text-vx-caption', className)}>No scenarios available.</p>
  }
  const order: Record<Scenario['key'], number> = { bull: 0, base: 1, bear: 2 }
  const sorted = [...scenarios].sort((a, b) => order[a.key] - order[b.key])
  return (
    <ul className={cn('divide-y divide-vx-border', className)}>
      {sorted.map((s) => (
        <li key={s.key} className="flex items-center gap-3 py-2">
          <span className="w-16 shrink-0 text-xs font-medium text-vx-heading">{s.label}</span>
          <div className="flex-1">
            <ProbabilityBar value={s.probability} compact />
          </div>
          <span className="vx-num w-44 shrink-0 text-right text-xs text-vx-body">
            {formatUsd(s.targetLow)} – {formatUsd(s.targetHigh)}
          </span>
        </li>
      ))}
    </ul>
  )
}
