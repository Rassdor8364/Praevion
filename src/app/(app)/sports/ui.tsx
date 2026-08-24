/**
 * Shared server-rendered pieces of the Sports screens.
 *
 * Kept beside the pages rather than in src/ui because they are
 * football-shaped (three-way splits, fixture rows, crest handling) rather
 * than universal primitives — the universal pieces (Panel, ProbabilityBar,
 * ConfidenceMeter…) come from the kit and are composed here.
 */

import Link from 'next/link'
import type { Outcome } from '@/core/prediction/types'
import type { FixturePrediction } from '@/engines/sports/orchestrator'
import type { Game } from '@/providers/types'
import { ConfidenceMeter } from '@/ui/ConfidenceMeter'
import { DataFreshness } from '@/ui/DataFreshness'
import { cn, formatPct } from '@/ui/lib'

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "Fri Aug 21, 19:00 UTC" — absolute kickoff, always UTC. */
export function formatKickoff(epochMs: number): string {
  const d = new Date(epochMs)
  const date = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })
  return `${date}, ${time} UTC`
}

/** "Aug 23, 15:30 UTC" — compact absolute kickoff for list rows (no weekday,
 *  so it never wraps inside a fixed-width column). */
export function formatKickoffShort(epochMs: number): string {
  const d = new Date(epochMs)
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })
  return `${date}, ${time} UTC`
}

/** "in 8d 4h" / "in 35m" / "2d ago" — relative to the render instant. */
export function formatRelative(epochMs: number, nowMs: number): string {
  const diff = epochMs - nowMs
  const abs = Math.abs(diff)
  const minutes = Math.round(abs / 60_000)
  const label =
    minutes < 60
      ? `${Math.max(1, minutes)}m`
      : minutes < 48 * 60
        ? `${Math.floor(minutes / 60)}h${minutes % 60 >= 30 ? '' : ''}`
        : `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`
  return diff >= 0 ? `in ${label}` : `${label} ago`
}

export function matchHref(gameExternalId: string): string {
  return `/sports/match/${encodeURIComponent(gameExternalId)}`
}

// ---------------------------------------------------------------------------
// Crest
// ---------------------------------------------------------------------------

/** Same-origin crest relay URL (see /api/sports/crest — avoids hotlinking the
 *  upstream CDN from the browser). Null when the provider reported no crest. */
export function crestHref(teamId: string, hasCrest: boolean): string | null {
  return hasCrest ? `/api/sports/crest?team=${encodeURIComponent(teamId)}` : null
}

/** Team crest, 16px. Decoration only — a missing crest renders a spacer so
 *  fixture rows stay aligned. */
export function Crest({ url, alt, size = 16 }: {
  readonly url: string | null | undefined
  readonly alt: string
  readonly size?: number
}) {
  if (url === undefined || url === null) {
    return <span style={{ width: size, height: size }} className="inline-block shrink-0" aria-hidden />
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external CDN decoration, not worth the next/image config
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      className="inline-block shrink-0 object-contain"
    />
  )
}

// ---------------------------------------------------------------------------
// Three-way (1X2) split bar
// ---------------------------------------------------------------------------

/** Brand-neutral segment tints: probability has no valence, so none of these
 *  are green/red. Home = violet, draw = slate, away = cyan. */
const SEGMENT_FILL = { home: 'bg-vx-accent/80', draw: 'bg-slate-500/60', away: 'bg-vx-live/70' } as const
const SEGMENT_TEXT = { home: 'text-vx-accent', draw: 'text-slate-400', away: 'text-vx-live' } as const

function outcomeOf(outcomes: readonly Outcome[], key: string): Outcome | null {
  return outcomes.find((o) => o.key === key) ?? null
}

/** The strictly-leading outcome key — null on a tie. A uniform distribution
 *  (every model abstained) has NO leader, and emphasising the home side of a
 *  33/33/33 row would be a fabricated claim. */
export function leadingKey(outcomes: readonly Outcome[]): string | null {
  let best: Outcome | null = null
  let tied = false
  for (const o of outcomes) {
    if (best === null || o.probability > best.probability + 1e-9) {
      best = o
      tied = false
    } else if (Math.abs(o.probability - best.probability) <= 1e-9) {
      tied = true
    }
  }
  return tied ? null : (best?.key ?? null)
}

/**
 * The 1X2 distribution as one stacked horizontal bar plus three numerals,
 * the leading outcome's numeral emphasised. A single stacked bar (rather
 * than three separate ones) is what makes "these three sum to 1" visible.
 */
export function ThreeWaySplit({ outcomes, className, showLabels = true }: {
  readonly outcomes: readonly Outcome[]
  readonly className?: string
  readonly showLabels?: boolean
}) {
  const home = outcomeOf(outcomes, 'home')
  const draw = outcomeOf(outcomes, 'draw')
  const away = outcomeOf(outcomes, 'away')
  if (home === null || draw === null || away === null) {
    return <span className="text-xs text-vx-caption">No 1X2 distribution</span>
  }
  const lead = leadingKey(outcomes)

  return (
    <div className={cn('min-w-0', className)}>
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]"
        role="img"
        aria-label={`Home ${formatPct(home.probability)}, draw ${formatPct(draw.probability)}, away ${formatPct(away.probability)}`}
      >
        {(['home', 'draw', 'away'] as const).map((key) => {
          const o = key === 'home' ? home : key === 'draw' ? draw : away
          return (
            <div
              key={key}
              className={cn('h-full', SEGMENT_FILL[key])}
              style={{ width: `${Math.max(0, Math.min(1, o.probability)) * 100}%` }}
            />
          )
        })}
      </div>
      {showLabels && (
        <div className="mt-1 flex justify-between gap-2 text-[10px]">
          {(['home', 'draw', 'away'] as const).map((key) => {
            const o = key === 'home' ? home : key === 'draw' ? draw : away
            const isLead = key === lead
            return (
              <span key={key} className={cn('flex min-w-0 items-baseline gap-1', SEGMENT_TEXT[key])}>
                <span className="uppercase tracking-[0.1em]">{key === 'home' ? '1' : key === 'draw' ? 'X' : '2'}</span>
                <span className={cn('vx-num', isLead ? 'font-semibold text-vx-heading' : 'text-vx-body')}>
                  {formatPct(o.probability)}
                </span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fixture row (list screen + command center)
// ---------------------------------------------------------------------------

export function FixtureRow({ fixture, crests, nowMs, compact = false }: {
  readonly fixture: FixturePrediction
  readonly crests: Readonly<Record<string, string>>
  readonly nowMs: number
  readonly compact?: boolean
}) {
  const { game, prediction } = fixture
  const lead = leadingKey(prediction.outcomes)
  const leadOutcome = prediction.outcomes.find((o) => o.key === lead) ?? null

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* Kickoff: relative first (the decision-relevant number), absolute beneath. */}
        <div className="w-32 shrink-0">
          <div className="vx-num text-xs text-vx-heading">{formatRelative(game.kickoff, nowMs)}</div>
          <div className="vx-num whitespace-nowrap text-[10px] text-vx-caption">
            {formatKickoffShort(game.kickoff)}
          </div>
        </div>

        <Link href={matchHref(game.externalId)} className="group min-w-0 flex-1 basis-48">
          <div className="flex items-center gap-1.5 truncate text-xs">
            <Crest url={crestHref(game.homeTeamId, crests[game.homeTeamId] !== undefined)} alt="" />
            <span
              className={cn(
                'truncate',
                lead === 'home' ? 'font-semibold text-vx-heading' : 'text-vx-body',
                'group-hover:text-vx-accent-2',
              )}
            >
              {game.homeTeamName}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs">
            <Crest url={crestHref(game.awayTeamId, crests[game.awayTeamId] !== undefined)} alt="" />
            <span
              className={cn(
                'truncate',
                lead === 'away' ? 'font-semibold text-vx-heading' : 'text-vx-body',
                'group-hover:text-vx-accent-2',
              )}
            >
              {game.awayTeamName}
            </span>
          </div>
        </Link>

        <div className="min-w-40 flex-1 basis-40">
          <ThreeWaySplit outcomes={prediction.outcomes} />
        </div>

        {!compact && (
          <div className="flex shrink-0 flex-col items-end gap-1">
            <ConfidenceMeter value={prediction.confidence} label="Conf" segments={8} />
            <DataFreshness dataAsOf={prediction.dataTimestamp} />
          </div>
        )}
        {compact && leadOutcome !== null && (
          <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-vx-caption">
            Lead{' '}
            <span className="ml-1 normal-case tracking-normal text-vx-heading">{leadOutcome.label}</span>
          </span>
        )}
      </div>
    </li>
  )
}

/** A finished game in the recent-results strip. */
export function ResultRow({ game, crests }: {
  readonly game: Game
  readonly crests: Readonly<Record<string, string>>
}) {
  const home = game.homeScore
  const away = game.awayScore
  return (
    <li className="flex items-center gap-3 py-2 text-xs">
      <span className="vx-num w-32 shrink-0 whitespace-nowrap text-[10px] text-vx-caption">
        {formatKickoffShort(game.kickoff)}
      </span>
      <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 truncate text-right">
        <span className={cn('truncate', home !== null && away !== null && home > away ? 'font-semibold text-vx-heading' : 'text-vx-body')}>
          {game.homeTeamName}
        </span>
        <Crest url={crestHref(game.homeTeamId, crests[game.homeTeamId] !== undefined)} alt="" />
      </span>
      <span className="vx-num w-12 shrink-0 text-center text-vx-heading">
        {home !== null && away !== null ? `${home}–${away}` : '—'}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
        <Crest url={crestHref(game.awayTeamId, crests[game.awayTeamId] !== undefined)} alt="" />
        <span className={cn('truncate', home !== null && away !== null && away > home ? 'font-semibold text-vx-heading' : 'text-vx-body')}>
          {game.awayTeamName}
        </span>
      </span>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Early-season honesty note
// ---------------------------------------------------------------------------

/** Rendered whenever the current season has too few finished rounds to carry
 *  the models on its own — the engines already penalise confidence for this
 *  (regime-stability term); the note says WHY the numbers look hesitant. */
export function SeasonNote({ finishedGames }: { readonly finishedGames: number }) {
  return (
    <p className="border-l-2 border-vx-warn/40 bg-amber-300/[0.04] px-3 py-2 text-[11px] leading-relaxed text-vx-body">
      <span className="font-medium uppercase tracking-[0.12em] text-vx-warn">Early season</span>
      <span className="mx-2 text-vx-caption">·</span>
      {finishedGames === 0 ? 'No finished games' : `Only ${finishedGames} finished game${finishedGames === 1 ? '' : 's'}`} in
      the current season yet — models lean on last season&apos;s history across transfers and managerial
      changes, and confidence is reduced accordingly.
    </p>
  )
}
