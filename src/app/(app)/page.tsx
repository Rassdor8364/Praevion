import { Suspense } from 'react'
import Link from 'next/link'
import { getIntelligenceEngine } from '@/engines/orchestrator'
import { getAnalystOrchestrator } from '@/engines/analyst/orchestrator'
import { getNewsOrchestrator } from '@/engines/news/orchestrator'
import { getSportsOrchestrator } from '@/engines/sports/orchestrator'
import { BriefingLineView } from './analyst/ui'
import { directionOf } from '@/core/prediction/types'
import { ClusterRow } from './news/ui'
import { FixtureRow } from './sports/ui'
import { DataFreshness } from '@/ui/DataFreshness'
import { DataModeBanner } from '@/ui/DataModeBanner'
import { DirectionBadge } from '@/ui/DirectionBadge'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { EmptyState } from '@/ui/EmptyState'
import { ErrorState } from '@/ui/ErrorState'
import { ConfidenceMeter } from '@/ui/ConfidenceMeter'
import { MarketOpportunityCard } from '@/ui/MarketOpportunityCard'
import { Panel } from '@/ui/Panel'
import { ProbabilityBar } from '@/ui/ProbabilityBar'
import { SkeletonBlock } from '@/ui/SkeletonBlock'
import { formatSignedPct, formatUsd } from '@/ui/lib'

export const dynamic = 'force-dynamic'

const MARKET_STATE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const

async function MarketStateRow({ symbol }: { readonly symbol: string }) {
  const engine = getIntelligenceEngine()
  const result = await engine.predictCryptoAllTimeframes(symbol, ['24h'])

  if (!result.ok) {
    return (
      <li className="py-2">
        <ErrorState compact title={symbol} message={result.error.message} />
      </li>
    )
  }

  const { predictions, market } = result.value
  const prediction = predictions['24h']
  if (prediction === undefined) {
    return (
      <li className="py-2">
        <ErrorState compact title={symbol} message="24h prediction unavailable" />
      </li>
    )
  }

  const up = prediction.outcomes.find((o) => o.key === 'up')
  const asset = symbol.replace(/USDT$/, '')

  return (
    <li className="py-2">
      <DataModeBanner mode={prediction.dataMode} className="mb-2" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href={`/crypto/${symbol}`}
          className="vx-num w-12 shrink-0 text-sm font-semibold text-vx-heading hover:text-vx-accent"
        >
          {asset}
        </Link>
        <span className="vx-num w-28 shrink-0 text-sm text-vx-heading">
          {market !== null ? formatUsd(market.price) : '—'}
        </span>
        <span
          className={
            market === null
              ? 'vx-num w-16 shrink-0 text-xs text-vx-caption'
              : market.change24hPct > 0
                ? 'vx-num w-16 shrink-0 text-xs text-vx-pos'
                : market.change24hPct < 0
                  ? 'vx-num w-16 shrink-0 text-xs text-vx-neg'
                  : 'vx-num w-16 shrink-0 text-xs text-vx-body'
          }
        >
          {market !== null ? formatSignedPct(market.change24hPct) : '—'}
        </span>
        <DirectionBadge direction={directionOf(prediction.outcomes)} />
        <div className="min-w-40 flex-1">
          {up !== undefined ? (
            <ProbabilityBar value={up.probability} label="P(up 24h)" compact />
          ) : (
            <span className="text-xs text-vx-caption">No up/down outcome</span>
          )}
        </div>
        <ConfidenceMeter value={prediction.confidence} label="Conf" segments={8} />
        <DataFreshness dataAsOf={prediction.dataTimestamp} />
      </div>
    </li>
  )
}

function MarketStatePanel() {
  return (
    <Panel title="Market State" right={<span className="vx-num">24h horizon</span>}>
      <ul className="divide-y divide-vx-border">
        {MARKET_STATE_SYMBOLS.map((symbol) => (
          <Suspense
            key={symbol}
            fallback={
              <li className="py-3">
                <SkeletonBlock className="h-5 w-full" />
              </li>
            }
          >
            <MarketStateRow symbol={symbol} />
          </Suspense>
        ))}
      </ul>
    </Panel>
  )
}

async function OpportunitiesPanel() {
  const engine = getIntelligenceEngine()
  // Scoped to the crypto category: threshold markets are the models' current
  // coverage (the scan-scope label below says so). An unscoped scan would
  // burn the venue page budget on categories no model can price yet.
  const result = await engine.scanMarkets({ limitPerVenue: 50, category: 'crypto' })

  if (!result.ok) {
    return (
      <Panel title="Top Opportunities">
        <ErrorState message={result.error.message} />
      </Panel>
    )
  }

  const report = result.value
  const actionable = report.opportunities.filter((o) => o.action === 'opportunity')
  const top = (actionable.length >= 5 ? actionable : report.opportunities).slice(0, 5)

  return (
    <Panel
      title="Top Opportunities"
      right={
        <Link href="/edge" className="text-vx-accent hover:underline">
          Vixera Edge →
        </Link>
      }
    >
      {/* Coverage honesty strip: how much of the scan Vixera actually models. */}
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 border-b border-vx-border pb-3">
        <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
          Scanned <span className="vx-num ml-1 text-xs text-vx-heading">{report.scanned}</span>
        </span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
          Covered <span className="vx-num ml-1 text-xs text-vx-heading">{report.covered}</span>
        </span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
          No coverage <span className="vx-num ml-1 text-xs text-vx-heading">{report.noCoverage}</span>
        </span>
        {report.failures.length > 0 && (
          <span className="text-[10px] uppercase tracking-[0.14em] text-vx-warn">
            {report.failures.length} venue failure{report.failures.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-vx-caption">
          Scan scope: crypto (current model coverage)
        </span>
      </div>
      {top.length === 0 ? (
        <EmptyState
          title="No scored opportunities in this scan"
          detail="Vixera only scores markets its models cover — an empty list means no covered market is currently mispriced enough to rank."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {top.map((o) => (
            <MarketOpportunityCard key={o.id} opportunity={o} compact />
          ))}
        </div>
      )}
    </Panel>
  )
}

async function TopSportsPanel() {
  // Premier League is the flagship coverage; the /sports screen carries the
  // other six leagues. The board path is dataset-only, so this panel costs
  // one fixtures fetch once the league dataset is warm.
  const result = await getSportsOrchestrator().getLeagueBoard('eng.1', { predictLimit: 3 })

  const right = (
    <Link href="/sports" className="text-vx-accent hover:underline">
      Sports →
    </Link>
  )

  if (!result.ok) {
    return (
      <Panel title="Top Sports" right={right}>
        <ErrorState compact title="Premier League" message={result.error.message} />
      </Panel>
    )
  }

  const board = result.value
  const nowMs = Date.now()
  return (
    <Panel title="Top Sports" right={right}>
      {board.upcoming.length === 0 ? (
        <EmptyState
          title="No upcoming fixtures with predictions"
          detail="The next Premier League round has not been listed by the provider yet."
        />
      ) : (
        <ul className="divide-y divide-vx-border">
          {board.upcoming.slice(0, 3).map((f) => (
            <FixtureRow key={f.game.externalId} fixture={f} crests={board.crests} nowMs={nowMs} compact />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function TopSportsSkeleton() {
  return (
    <Panel title="Top Sports">
      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <SkeletonBlock key={i} className="h-9 w-full" />
        ))}
      </div>
    </Panel>
  )
}

async function TopNewsPanel() {
  const result = await getNewsOrchestrator().getNewsBoard()

  const right = (
    <Link href="/news" className="text-vx-accent hover:underline">
      News →
    </Link>
  )

  if (!result.ok) {
    return (
      <Panel title="Top News" right={right}>
        <ErrorState compact title="News board" message={result.error.message} />
      </Panel>
    )
  }

  const board = result.value
  const nowMs = Date.now()
  // Real clusters only, importance-sorted with breaking first — the same
  // ordering the News screen uses.
  const top = board.clusters.slice(0, 3)

  return (
    <Panel title="Top News" right={right}>
      {top.length === 0 ? (
        <EmptyState
          title="No story clusters in the current window"
          detail="The RSS window is empty right now — clusters appear as feeds publish."
        />
      ) : (
        <ul className="divide-y divide-vx-border">
          {top.map((c) => (
            <ClusterRow key={c.cluster.id} scored={c} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function TopNewsSkeleton() {
  return (
    <Panel title="Top News">
      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <SkeletonBlock key={i} className="h-7 w-full" />
        ))}
      </div>
    </Panel>
  )
}

/** Compact Analyst teaser: the pulse headline + top opportunity, linking to
 *  the full briefing. Shares the analyst orchestrator's 120s cache, so it
 *  costs nothing extra once the briefing has been assembled. */
async function AnalystTeaserPanel() {
  const result = await getAnalystOrchestrator().getBriefing()

  const right = (
    <Link href="/analyst" className="text-vx-accent hover:underline">
      Full briefing →
    </Link>
  )

  if (!result.ok) {
    return (
      <Panel title="Analyst" right={right}>
        <ErrorState compact title="Briefing" message={result.error.message} />
      </Panel>
    )
  }

  const { briefing } = result.value
  const pulse = briefing.sections.find((s) => s.id === 'market_pulse')
  const opportunities = briefing.sections.find((s) => s.id === 'top_opportunities')
  const topOpportunity = opportunities?.bullets.find((b) =>
    b.evidence.some((e) => e.value.startsWith('edge=')),
  )

  return (
    <Panel
      title="Analyst"
      right={
        <span className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
            computed from live Praevion data
          </span>
          {right}
        </span>
      }
    >
      <div className="space-y-2">
        {pulse !== undefined && <BriefingLineView line={pulse.headline} className="text-vx-heading" />}
        {topOpportunity !== undefined ? (
          <BriefingLineView line={topOpportunity} />
        ) : (
          opportunities !== undefined && <BriefingLineView line={opportunities.headline} />
        )}
      </div>
    </Panel>
  )
}

function AnalystTeaserSkeleton() {
  return (
    <Panel title="Analyst">
      <div className="space-y-2">
        <SkeletonBlock className="h-5 w-full" />
        <SkeletonBlock className="h-5 w-4/5" />
      </div>
    </Panel>
  )
}

/** About block — Praevion's place in the Vixera ecosystem. */
function AboutPraevion() {
  return (
    <section aria-label="About Praevion" className="border-t border-vx-border pt-4">
      <p className="max-w-3xl text-[11px] leading-relaxed text-vx-caption">
        <span className="font-semibold uppercase tracking-[0.14em] text-vx-body">Praevion</span> is the
        predictive intelligence layer of the Vixera ecosystem. We aggregate markets, models, smart money,
        news and data to identify mispriced outcomes and high-probability opportunities across prediction
        markets, sports, and futures. Find the <span className="text-vx-live">edge</span> before the market.
      </p>
    </section>
  )
}

function OpportunitiesSkeleton() {
  return (
    <Panel title="Top Opportunities">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonBlock key={i} className="h-32 w-full" />
        ))}
      </div>
    </Panel>
  )
}

export default function CommandCenterPage() {
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-sm font-semibold uppercase tracking-[0.18em] text-vx-heading">
          Command Center
        </h1>
        <p className="text-[10px] font-medium uppercase tracking-[0.32em] text-vx-body">
          See <span className="text-vx-live">before</span> it happens.
        </p>
      </header>
      <MarketStatePanel />
      <Suspense fallback={<AnalystTeaserSkeleton />}>
        <AnalystTeaserPanel />
      </Suspense>
      <Suspense fallback={<TopSportsSkeleton />}>
        <TopSportsPanel />
      </Suspense>
      <Suspense fallback={<TopNewsSkeleton />}>
        <TopNewsPanel />
      </Suspense>
      <Suspense fallback={<OpportunitiesSkeleton />}>
        <OpportunitiesPanel />
      </Suspense>
      <AboutPraevion />
      <DisclaimerFooter />
    </div>
  )
}
