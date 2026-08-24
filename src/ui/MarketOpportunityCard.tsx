import { ExternalLink } from 'lucide-react'
import type { VixeraOpportunity } from '@/core/markets/types'
import { DataFreshness } from './DataFreshness'
import { DataModeBanner } from './DataModeBanner'
import { cn, formatHours, formatPct, formatSignedPp } from './lib'
import { ProbabilityBar } from './ProbabilityBar'

export interface MarketOpportunityCardProps {
  readonly opportunity: VixeraOpportunity
  readonly compact?: boolean
  readonly className?: string
}

function ScoreMeter({ score, compact }: { readonly score: number; readonly compact: boolean }) {
  const clamped = Math.min(100, Math.max(0, score))
  return (
    <div className={cn('flex flex-col items-end gap-1', compact ? 'w-16' : 'w-24')}>
      <span className={cn('vx-num font-semibold text-vx-heading', compact ? 'text-lg' : 'text-2xl')}>
        {Math.round(score)}
      </span>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-white/[0.05]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        aria-label="Opportunity score"
      >
        <div className="h-full rounded-full bg-vx-accent" style={{ width: `${clamped}%` }} />
      </div>
      <span className="text-[9px] uppercase tracking-[0.14em] text-vx-caption">Score</span>
    </div>
  )
}

/** One scored market divergence: what the market believes vs what Vixera estimates. */
export function MarketOpportunityCard({ opportunity: o, compact = false, className }: MarketOpportunityCardProps) {
  const edgeTone = o.edgePp > 0 ? 'text-vx-pos' : o.edgePp < 0 ? 'text-vx-neg' : 'text-vx-body'

  return (
    <article className={cn('vx-glass min-w-0', compact ? 'p-3' : 'p-4', className)}>
      <DataModeBanner mode={o.dataMode} className={cn('mb-3 rounded-t-lg', compact ? '-mx-3 -mt-3' : '-mx-4 -mt-4')} />
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className={cn('font-medium leading-snug text-vx-heading', compact ? 'truncate text-xs' : 'text-sm')} title={o.market.title}>
            {o.market.url !== null ? (
              <a
                href={o.market.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-vx-accent"
              >
                {o.market.title}
                <ExternalLink size={11} className="shrink-0 text-vx-caption" aria-hidden />
              </a>
            ) : (
              o.market.title
            )}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="rounded border border-vx-border-strong px-1.5 py-px text-[9px] uppercase tracking-[0.14em] text-vx-body">
              {o.market.provider}
            </span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-vx-caption">{o.market.category}</span>
            <span className="text-[10px] text-vx-caption">{o.outcomeName}</span>
          </div>
        </div>
        <ScoreMeter score={o.opportunityScore} compact={compact} />
      </header>

      <div className="space-y-1.5">
        <ProbabilityBar value={o.marketProbability} label="Market" compact={compact} />
        <ProbabilityBar value={o.vixeraProbability} label="Vixera" fill="cyan" compact={compact} />
      </div>

      <div className={cn('mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-vx-border pt-2.5', compact && 'gap-x-4')}>
        <span className="text-[9px] uppercase tracking-[0.14em] text-vx-caption">
          Edge <span className={cn('vx-num ml-1 text-[11px]', edgeTone)}>{formatSignedPp(o.edgePp)}</span>
        </span>
        <span className="text-[9px] uppercase tracking-[0.14em] text-vx-caption">
          EV{' '}
          <span className={cn('vx-num ml-1 text-[11px]', o.expectedValue === null ? 'text-vx-caption' : o.expectedValue > 0 ? 'text-vx-pos' : o.expectedValue < 0 ? 'text-vx-neg' : 'text-vx-body')}>
            {o.expectedValue === null ? 'no quote' : formatPct(o.expectedValue)}
          </span>
        </span>
        <span className="text-[9px] uppercase tracking-[0.14em] text-vx-caption">
          Liquidity <span className="vx-num ml-1 text-[11px] text-vx-heading">{o.liquidity.grade}</span>
        </span>
        <span className="text-[9px] uppercase tracking-[0.14em] text-vx-caption">
          Res. risk <span className="vx-num ml-1 text-[11px] text-vx-heading">{o.resolutionRisk.level}</span>
        </span>
        <span className="text-[9px] uppercase tracking-[0.14em] text-vx-caption">
          Resolves <span className="vx-num ml-1 text-[11px] text-vx-heading">{formatHours(o.hoursToResolution)}</span>
        </span>
        <span className="text-[9px] uppercase tracking-[0.14em] text-vx-caption">
          Conf <span className="vx-num ml-1 text-[11px] text-vx-heading">{formatPct(o.confidence, 0)}</span>
        </span>
      </div>

      {o.action === 'no_action' && o.noActionReasons.length > 0 && (
        <div className="mt-2.5 border-t border-vx-border pt-2.5">
          <span className="text-[9px] uppercase tracking-[0.14em] text-vx-caption">No action —</span>
          <ul className="mt-1 space-y-0.5">
            {o.noActionReasons.map((r) => (
              <li key={r} className="text-[11px] text-slate-500">
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!compact && (
        <div className="mt-2.5 flex items-center justify-between border-t border-vx-border pt-2">
          <DataFreshness dataAsOf={o.generatedAt} />
          <span className="vx-num text-[10px] text-vx-caption">
            agreement {formatPct(o.modelAgreement, 0)} · quality {Math.round(o.dataQuality)}/100
          </span>
        </div>
      )}
    </article>
  )
}
