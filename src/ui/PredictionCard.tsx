import { ChevronDown } from 'lucide-react'
import type { PredictionFactor, VixeraPrediction } from '@/core/prediction/types'
import { directionOf, leadingOutcome } from '@/core/prediction/types'
import { ConfidenceMeter } from './ConfidenceMeter'
import { DataFreshness } from './DataFreshness'
import { DataModeBanner } from './DataModeBanner'
import { DirectionBadge } from './DirectionBadge'
import { cn, formatPct, formatSignedPp } from './lib'
import { ModelBreakdown } from './ModelBreakdown'
import { ProbabilityBar } from './ProbabilityBar'
import { RiskBadge } from './RiskBadge'

export interface PredictionCardProps {
  readonly prediction: VixeraPrediction
  readonly compact?: boolean
  readonly className?: string
}

function FactorList({ title, factors, tone }: {
  readonly title: string
  readonly factors: readonly PredictionFactor[]
  readonly tone: 'supporting' | 'opposing'
}) {
  if (factors.length === 0) return null
  return (
    <div>
      <h4 className="mb-1 text-[10px] uppercase tracking-[0.14em] text-vx-caption">{title}</h4>
      <ul className="space-y-1">
        {factors.map((f) => (
          <li key={f.id} className="flex items-baseline gap-2 text-xs">
            <span
              className={cn(
                'vx-num w-14 shrink-0 text-right',
                // Contribution sign is semantic direction — the one green/red use.
                f.contribution === null
                  ? 'text-vx-caption'
                  : tone === 'supporting'
                    ? 'text-vx-pos'
                    : 'text-vx-neg',
              )}
            >
              {f.contribution === null ? '—' : formatSignedPp(f.contribution)}
            </span>
            <span className="text-vx-body">{f.label}</span>
            {f.detail !== null && <span className="truncate text-vx-caption" title={f.detail}>{f.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The atom of the product: one VixeraPrediction, rendered honestly.
 * Compact variant is a grid cell (multi-timeframe view); the full variant
 * exposes the entire model pool and factor attribution.
 */
export function PredictionCard({ prediction: p, compact = false, className }: PredictionCardProps) {
  const direction = directionOf(p.outcomes)
  const lead = leadingOutcome(p)

  if (compact) {
    return (
      <div className={cn('vx-glass flex flex-col gap-2 p-3', className)}>
        <div className="flex items-center justify-between gap-2">
          <span className="vx-num text-[11px] font-medium uppercase tracking-[0.14em] text-vx-heading">
            {p.timeframe}
          </span>
          <DirectionBadge direction={direction} />
        </div>
        <DataModeBanner mode={p.dataMode} className="-mx-1 px-2 py-1 text-[9px]" />
        <div className="space-y-1.5">
          {p.outcomes.map((o) => (
            <ProbabilityBar key={o.key} value={o.probability} label={o.label} compact />
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-vx-border pt-2">
          <ConfidenceMeter value={p.confidence} label="Conf" segments={8} />
          <RiskBadge level={p.riskLevel} />
        </div>
      </div>
    )
  }

  return (
    <article className={cn('vx-glass p-4', className)}>
      <DataModeBanner mode={p.dataMode} className="-mx-4 -mt-4 mb-4 rounded-t-lg" />
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold tracking-wide text-vx-heading">{p.subjectLabel}</h3>
          <span className="vx-num rounded border border-vx-border-strong px-1.5 py-px text-[10px] uppercase tracking-[0.14em] text-vx-body">
            {p.timeframe}
          </span>
          <DirectionBadge direction={direction} />
        </div>
        <div className="flex items-center gap-3">
          <RiskBadge level={p.riskLevel} />
          <DataFreshness dataAsOf={p.dataTimestamp} />
        </div>
      </header>

      <div className="space-y-2">
        {p.outcomes.map((o) => (
          <ProbabilityBar key={o.key} value={o.probability} label={o.label} />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-vx-border pt-3">
        <ConfidenceMeter value={p.confidence} />
        <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
          Data quality <span className="vx-num ml-1 text-[11px] text-vx-heading">{Math.round(p.dataQuality)}/100</span>
        </span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
          Model agreement <span className="vx-num ml-1 text-[11px] text-vx-heading">{formatPct(p.modelAgreement, 0)}</span>
        </span>
        {lead !== null && (
          <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
            Leading <span className="ml-1 text-[11px] normal-case tracking-normal text-vx-heading">{lead.label}</span>
          </span>
        )}
      </div>

      <details className="group mt-3 border-t border-vx-border pt-3">
        <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-vx-body hover:text-vx-heading [&::-webkit-details-marker]:hidden">
          <ChevronDown size={12} className="transition-transform group-open:rotate-180" aria-hidden />
          Model breakdown &amp; factors
        </summary>
        <div className="mt-3 space-y-4">
          <ModelBreakdown models={p.modelOutputs} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FactorList title="Supporting factors" factors={p.supportingFactors} tone="supporting" />
            <FactorList title="Opposing factors" factors={p.opposingFactors} tone="opposing" />
          </div>
          <p className="text-[10px] text-vx-caption">
            Model {p.modelVersion} · generated {p.generatedAt} · oldest input {p.dataTimestamp}
          </p>
        </div>
      </details>
    </article>
  )
}
