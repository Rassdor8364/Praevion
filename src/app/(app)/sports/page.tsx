import type { Metadata } from 'next'
import { Suspense } from 'react'
import Link from 'next/link'
import { getSportsOrchestrator } from '@/engines/sports/orchestrator'
import { ESPN_LEAGUES } from '@/providers/sports/espn'
import { DataModeBanner } from '@/ui/DataModeBanner'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { EmptyState } from '@/ui/EmptyState'
import { ErrorState } from '@/ui/ErrorState'
import { Panel } from '@/ui/Panel'
import { SkeletonBlock } from '@/ui/SkeletonBlock'
import { cn } from '@/ui/lib'
import { AutoRefresh } from './AutoRefresh'
import { FixtureRow, ResultRow, SeasonNote, formatKickoffShort, formatRelative } from './ui'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Sports' }

const DEFAULT_LEAGUE = 'eng.1'

function LeagueTabs({ active }: { readonly active: string }) {
  return (
    <nav aria-label="Leagues" className="flex flex-wrap gap-1 border-b border-vx-border pb-px">
      {Object.entries(ESPN_LEAGUES).map(([id, meta]) => {
        const isActive = id === active
        return (
          <Link
            key={id}
            href={id === DEFAULT_LEAGUE ? '/sports' : `/sports?league=${id}`}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'border-b-2 px-3 py-1.5 text-xs transition-colors',
              isActive
                ? 'border-vx-accent text-vx-heading'
                : 'border-transparent text-vx-body hover:text-vx-heading',
            )}
          >
            {meta.name}
          </Link>
        )
      })}
    </nav>
  )
}

async function LeagueBoardView({ leagueId }: { readonly leagueId: string }) {
  const result = await getSportsOrchestrator().getLeagueBoard(leagueId)

  if (!result.ok) {
    return (
      <Panel title="Fixtures">
        <ErrorState message={result.error.message} />
      </Panel>
    )
  }

  const board = result.value
  const nowMs = Date.now()
  // One banner for the board: every row shares the same provenance path, so
  // the worst row's mode speaks for all of them.
  const worstMode =
    board.upcoming.find((f) => f.prediction.dataMode === 'demo')?.prediction.dataMode ??
    board.upcoming.find((f) => f.prediction.dataMode === 'partial')?.prediction.dataMode ??
    ('live' as const)

  return (
    <div className="space-y-5">
      {board.earlySeason && <SeasonNote finishedGames={board.currentSeasonFinishedGames} />}

      <Panel
        title={`Upcoming Fixtures — ${board.leagueName}`}
        right={<span className="vx-num">{board.upcoming.length + board.upcomingUnpredicted.length} in next 14d</span>}
      >
        <DataModeBanner mode={worstMode} className="mb-3" />
        {board.upcoming.length === 0 && board.upcomingUnpredicted.length === 0 ? (
          <EmptyState
            title="No fixtures in the next 14 days"
            detail="The league may be between rounds or in its off-season. Fixtures appear here as soon as the provider lists them."
          />
        ) : (
          <>
            <ul className="divide-y divide-vx-border">
              {board.upcoming.map((f) => (
                <FixtureRow key={f.game.externalId} fixture={f} crests={board.crests} nowMs={nowMs} />
              ))}
            </ul>
            {board.upcomingUnpredicted.length > 0 && (
              <div className="mt-3 border-t border-vx-border pt-3">
                <h3 className="mb-1 text-[10px] uppercase tracking-[0.14em] text-vx-caption">
                  Further fixtures (no prediction computed)
                </h3>
                <ul className="space-y-1">
                  {board.upcomingUnpredicted.map((g) => (
                    <li key={g.externalId} className="flex flex-wrap items-baseline gap-x-3 text-[11px] text-vx-body">
                      <span className="vx-num w-32 shrink-0 whitespace-nowrap text-vx-caption">
                        {formatKickoffShort(g.kickoff)}
                      </span>
                      <span className="truncate">
                        {g.homeTeamName} vs {g.awayTeamName}
                      </span>
                      <span className="vx-num text-vx-caption">{formatRelative(g.kickoff, nowMs)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Panel>

      <Panel title="Recent Results" right={<span className="vx-num">last 7 days</span>}>
        {board.results.length === 0 ? (
          <EmptyState
            title="No finished games in the last 7 days"
            detail="Results land here once matches complete."
          />
        ) : (
          <ul className="divide-y divide-vx-border">
            {board.results.map((g) => (
              <ResultRow key={g.externalId} game={g} crests={board.crests} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

function BoardSkeleton() {
  return (
    <Panel title="Upcoming Fixtures">
      <div className="space-y-3">
        {Array.from({ length: 6 }, (_, i) => (
          <SkeletonBlock key={i} className="h-10 w-full" />
        ))}
      </div>
    </Panel>
  )
}

interface PageProps {
  readonly searchParams: Promise<{ league?: string }>
}

export default async function SportsPage({ searchParams }: PageProps) {
  const requested = (await searchParams).league
  const leagueId = requested !== undefined && requested in ESPN_LEAGUES ? requested : DEFAULT_LEAGUE

  return (
    <div className="space-y-5">
      <AutoRefresh />
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-sm font-semibold uppercase tracking-[0.18em] text-vx-heading">
          Sports Intelligence
        </h1>
        <p className="text-[10px] font-medium uppercase tracking-[0.32em] text-vx-body">
          Dixon–Coles · Elo–Davidson · Form
        </p>
      </header>
      <LeagueTabs active={leagueId} />
      <Suspense key={leagueId} fallback={<BoardSkeleton />}>
        <LeagueBoardView leagueId={leagueId} />
      </Suspense>
      <DisclaimerFooter />
    </div>
  )
}
