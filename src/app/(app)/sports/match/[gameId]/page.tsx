import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import type { PredictionFactor } from '@/core/prediction/types'
import { getSportsOrchestrator, type TeamComparisonSide } from '@/engines/sports/orchestrator'
import type { StrengthComponentKey } from '@/engines/sports/strength'
import { ESPN_LEAGUES } from '@/providers/sports/espn'
import { ConfidenceMeter } from '@/ui/ConfidenceMeter'
import { DataFreshness } from '@/ui/DataFreshness'
import { DataModeBanner } from '@/ui/DataModeBanner'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { ErrorState } from '@/ui/ErrorState'
import { Panel } from '@/ui/Panel'
import { ProbabilityBar } from '@/ui/ProbabilityBar'
import { RiskBadge } from '@/ui/RiskBadge'
import { cn, formatPct, formatSignedPp } from '@/ui/lib'
import { AutoRefresh } from '../../AutoRefresh'
import { Crest, SeasonNote, ThreeWaySplit, crestHref, formatKickoff, formatRelative, leadingKey } from '../../ui'

export const dynamic = 'force-dynamic'

const GAME_ID_RE = /^[a-z0-9.]{2,24}:[A-Za-z0-9]{1,20}$/

interface PageProps {
  readonly params: Promise<{ gameId: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const gameId = decodeURIComponent((await params).gameId)
  return { title: `Match ${gameId} — Sports` }
}

// ---------------------------------------------------------------------------
// WHY panel (factor attribution)
// ---------------------------------------------------------------------------

function FactorList({ title, factors, tone }: {
  readonly title: string
  readonly factors: readonly PredictionFactor[]
  readonly tone: 'supporting' | 'opposing'
}) {
  return (
    <div>
      <h4 className="mb-1 text-[10px] uppercase tracking-[0.14em] text-vx-caption">{title}</h4>
      {factors.length === 0 ? (
        <p className="text-[11px] text-vx-caption">None measured for this fixture.</p>
      ) : (
        <ul className="space-y-1.5">
          {factors.map((f) => (
            <li key={f.id} className="text-xs">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    'vx-num w-14 shrink-0 text-right',
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
              </div>
              {f.detail !== null && (
                <p className="ml-16 text-[10px] leading-snug text-vx-caption">{f.detail}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// §57 comparison table
// ---------------------------------------------------------------------------

const COMPONENT_LABELS: Record<StrengthComponentKey, string> = {
  attack: 'Attack',
  defense: 'Defense',
  form: 'Form',
  homeAway: 'Home/Away',
  momentum: 'Momentum',
  depth: 'Depth',
  health: 'Health',
}

/** Render order: measured components first, the two honest gaps last. */
const COMPONENT_ORDER: readonly StrengthComponentKey[] = [
  'attack',
  'defense',
  'form',
  'homeAway',
  'momentum',
  'depth',
  'health',
]

function MirroredBar({ value, side }: { readonly value: number | null; readonly side: 'home' | 'away' }) {
  if (value === null) {
    return (
      <span className={cn('block text-[10px] uppercase tracking-[0.1em] text-vx-caption', side === 'home' ? 'text-right' : 'text-left')}>
        No data
      </span>
    )
  }
  const width = `${Math.max(0, Math.min(100, value))}%`
  return (
    <div className={cn('flex items-center gap-2', side === 'home' && 'flex-row-reverse')}>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
      >
        <div
          className={cn('h-full rounded-full', side === 'home' ? 'ml-auto bg-vx-accent/80' : 'bg-vx-live/70')}
          style={{ width }}
        />
      </div>
      <span className="vx-num w-7 shrink-0 text-[11px] text-vx-heading">{Math.round(value)}</span>
    </div>
  )
}

function ComparisonTable({ home, away }: {
  readonly home: TeamComparisonSide
  readonly away: TeamComparisonSide
}) {
  return (
    <div>
      {/* Header: overall + Elo + form, per side. */}
      <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-vx-border pb-3">
        {[home, away].map((side, i) => (
          <div key={side.teamId} className={cn('min-w-0', i === 0 ? 'text-right' : 'text-left', i === 0 ? 'order-1' : 'order-3')}>
            <div className={cn('flex items-center gap-1.5 truncate text-xs font-semibold text-vx-heading', i === 0 && 'flex-row-reverse')}>
              <Crest url={crestHref(side.teamId, side.crestUrl !== null)} alt="" />
              <span className="truncate">{side.name}</span>
            </div>
            <div className={cn('mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-vx-caption', i === 0 && 'justify-end')}>
              <span>
                Overall{' '}
                <span className="vx-num text-[11px] text-vx-heading">
                  {side.strength === null ? '—' : Math.round(side.strength.overall)}
                </span>
              </span>
              <span>
                Elo{' '}
                <span className="vx-num text-[11px] text-vx-heading">
                  {side.elo.rated ? Math.round(side.elo.rating) : '—'}
                </span>
              </span>
              <span>
                Form{' '}
                <span className="vx-num text-[11px] text-vx-heading">
                  {side.form.insufficient ? '—' : Math.round(side.form.score)}
                </span>
              </span>
            </div>
          </div>
        ))}
        <span className="order-2 text-[10px] uppercase tracking-[0.14em] text-vx-caption">vs</span>
      </div>

      <ul className="space-y-2.5">
        {COMPONENT_ORDER.map((key) => (
          <li key={key} className="grid grid-cols-[1fr_6.5rem_1fr] items-center gap-2">
            <MirroredBar value={home.strength?.components[key] ?? null} side="home" />
            <span className="text-center text-[10px] uppercase tracking-[0.14em] text-vx-caption">
              {COMPONENT_LABELS[key]}
            </span>
            <MirroredBar value={away.strength?.components[key] ?? null} side="away" />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[10px] leading-relaxed text-vx-caption">
        Components are league percentiles (50 = median team), venue-aware for Home/Away. Depth and
        Health read &ldquo;No data&rdquo; because no squad or injury feed exists yet — their weights are
        redistributed, never guessed.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MatchPage({ params }: PageProps) {
  const gameId = decodeURIComponent((await params).gameId)
  if (!GAME_ID_RE.test(gameId)) notFound()

  const leagueId = gameId.slice(0, gameId.lastIndexOf(':'))
  const leagueName = (ESPN_LEAGUES as Record<string, { name: string }>)[leagueId]?.name ?? leagueId

  const backLink = (
    <Link
      href={leagueId === 'eng.1' ? '/sports' : `/sports?league=${leagueId}`}
      className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-vx-body hover:text-vx-heading"
    >
      <ArrowLeft size={12} aria-hidden /> {leagueName}
    </Link>
  )

  const result = await getSportsOrchestrator().predictGame(gameId)
  if (!result.ok) {
    return (
      <div className="space-y-5">
        {backLink}
        <Panel>
          <ErrorState message={result.error.message} />
        </Panel>
        <DisclaimerFooter />
      </div>
    )
  }

  const {
    game,
    prediction,
    markets,
    lambdas,
    fairOdds,
    comparison,
    confidenceBreakdown,
    earlySeason,
    currentSeasonFinishedGames,
  } = result.value
  const nowMs = Date.now()
  const lead = leadingKey(prediction.outcomes)

  return (
    <div className="space-y-5">
      <AutoRefresh />
      {backLink}

      {/* Match header */}
      <Panel padded>
        <DataModeBanner mode={prediction.dataMode} className="-mx-4 -mt-4 mb-4 rounded-t-lg" />
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold text-vx-heading">
              <Crest url={crestHref(comparison.home.teamId, comparison.home.crestUrl !== null)} alt="" size={20} />
              <span className={cn('truncate', lead === 'home' && 'text-vx-accent-2')}>{game.homeTeamName}</span>
              <span className="text-vx-caption">vs</span>
              <Crest url={crestHref(comparison.away.teamId, comparison.away.crestUrl !== null)} alt="" size={20} />
              <span className={cn('truncate', lead === 'away' && 'text-vx-accent-2')}>{game.awayTeamName}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-vx-caption">
              <span className="vx-num">{formatKickoff(game.kickoff)}</span>
              <span className="vx-num text-vx-body">{formatRelative(game.kickoff, nowMs)}</span>
              {game.venue !== null && <span>{game.venue}</span>}
              <span className="uppercase tracking-[0.12em]">{game.status}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <RiskBadge level={prediction.riskLevel} />
            <DataFreshness dataAsOf={prediction.dataTimestamp} />
          </div>
        </div>
      </Panel>

      {earlySeason && <SeasonNote finishedGames={currentSeasonFinishedGames} />}

      {/* 1X2 + quality row */}
      <Panel title="Match Outcome (1X2)">
        <div className="mb-4">
          <ThreeWaySplit outcomes={prediction.outcomes} />
        </div>
        <div className="space-y-2">
          {prediction.outcomes.map((o) => (
            <div key={o.key} className="flex items-center gap-3">
              <span
                className="w-44 shrink-0 truncate text-xs text-vx-body"
                title={o.label}
              >
                {o.label}
              </span>
              <div className="min-w-0 flex-1">
                <ProbabilityBar
                  value={o.probability}
                  fill={o.key === 'home' ? 'violet' : o.key === 'away' ? 'cyan' : 'accent'}
                />
              </div>
              <span className="vx-num w-20 shrink-0 text-right text-[11px] text-vx-caption">
                fair {fairOdds[o.key] !== undefined ? fairOdds[o.key]?.toFixed(2) : '—'}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-vx-border pt-3">
          <ConfidenceMeter value={prediction.confidence} />
          <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
            Data quality{' '}
            <span className="vx-num ml-1 text-[11px] text-vx-heading">{Math.round(prediction.dataQuality)}/100</span>
          </span>
          <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
            Model agreement{' '}
            <span className="vx-num ml-1 text-[11px] text-vx-heading">{formatPct(prediction.modelAgreement, 0)}</span>
          </span>
          <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
            Limiting factor{' '}
            <span className="ml-1 text-[11px] normal-case tracking-normal text-vx-heading">
              {confidenceBreakdown.limitingFactor}
            </span>
          </span>
        </div>
        <p className="mt-2 text-[10px] text-vx-caption">
          Fair odds are margin-free decimal prices implied by the pooled probabilities. Model{' '}
          {prediction.modelVersion} · generated {prediction.generatedAt}
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* WHY */}
        <Panel title="Why — Factor Attribution">
          <div className="grid gap-4 sm:grid-cols-2">
            <FactorList title="Supporting" factors={prediction.supportingFactors} tone="supporting" />
            <FactorList title="Opposing" factors={prediction.opposingFactors} tone="opposing" />
          </div>
          <p className="mt-3 border-t border-vx-border pt-2 text-[10px] leading-relaxed text-vx-caption">
            Contributions are measured counterfactuals in probability points toward the leading
            outcome — not narrated guesses. Head-to-head is shrunk and capped at ±3pp by design.
          </p>
        </Panel>

        {/* Model breakdown: full 1X2 per model, abstentions shown honestly. */}
        <Panel title="Model Breakdown">
          <ul className="space-y-3">
            {prediction.modelOutputs.map((m) => (
              <li key={m.modelId} className="border-b border-vx-border pb-3 last:border-b-0 last:pb-0">
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs text-vx-heading">{m.modelId}</span>
                  {m.abstained ? (
                    <span className="text-[10px] uppercase tracking-[0.1em] text-vx-warn">Abstained</span>
                  ) : (
                    <span className="vx-num shrink-0 text-[10px] text-vx-caption">
                      conf {formatPct(m.confidence, 0)} · w {m.weight.toFixed(2)}
                    </span>
                  )}
                </div>
                {m.abstained ? (
                  <p className="text-[11px] text-vx-caption">
                    {m.abstainReason ?? 'Insufficient data'} — removed from the pool, not a neutral vote.
                  </p>
                ) : (
                  <ThreeWaySplit outcomes={m.outcomes} />
                )}
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* §57 comparison */}
      <Panel title="Team Strength Comparison">
        <ComparisonTable home={comparison.home} away={comparison.away} />
      </Panel>

      {/* Secondary markets from the DC joint distribution */}
      <Panel title="Goals Markets — Dixon–Coles">
        {markets === null ? (
          <ErrorState
            compact
            title="Unavailable"
            message="The Dixon–Coles model abstained for this fixture, so no coherent goals distribution exists."
          />
        ) : (
          <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            <div className="space-y-2">
              <ProbabilityBar value={markets.over25} label="Over 2.5" />
              <ProbabilityBar value={markets.under25} label="Under 2.5" />
            </div>
            <div className="space-y-2">
              <ProbabilityBar value={markets.bttsYes} label="BTTS Yes" />
              <ProbabilityBar value={markets.bttsNo} label="BTTS No" />
            </div>
          </div>
        )}
        {lambdas !== null && (
          <p className="mt-3 border-t border-vx-border pt-2 text-[10px] text-vx-caption">
            Expected goals (fitted rates): {game.homeTeamName}{' '}
            <span className="vx-num text-[11px] text-vx-heading">{lambdas.home.toFixed(2)}</span> ·{' '}
            {game.awayTeamName}{' '}
            <span className="vx-num text-[11px] text-vx-heading">{lambdas.away.toFixed(2)}</span>. These
            come from the Dixon–Coles joint distribution alone, coherent with its 1X2 rather than the
            pooled one.
          </p>
        )}
      </Panel>

      <DisclaimerFooter />
    </div>
  )
}
