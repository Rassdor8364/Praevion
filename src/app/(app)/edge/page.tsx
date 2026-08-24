import type { Metadata } from 'next'
import { getIntelligenceEngine } from '@/engines/orchestrator'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { EmptyState } from '@/ui/EmptyState'
import { ErrorState } from '@/ui/ErrorState'
import { MarketOpportunityCard } from '@/ui/MarketOpportunityCard'
import { Panel } from '@/ui/Panel'
import { EdgeExplorer } from './EdgeExplorer'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Vixera Edge' }

/** Cap the rendered card lists — the scan can cover hundreds of markets. */
const MAX_ACTIONABLE_SHOWN = 60
const MAX_REJECTED_SHOWN = 60

export default async function EdgePage() {
  const engine = getIntelligenceEngine()
  // Scoped to crypto: the current covering model prices crypto-threshold
  // markets. The scope is stated on-screen; when sports/macro models come
  // online, they widen this scan rather than pretending to cover it today.
  const result = await engine.scanMarkets({ limitPerVenue: 100, category: 'crypto' })

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <Panel title="Vixera Edge — Best Opportunities">
          <ErrorState message={result.error.message} />
        </Panel>
        <DisclaimerFooter />
      </div>
    )
  }

  const report = result.value
  const allActionable = report.opportunities.filter((o) => o.action === 'opportunity')
  const allRejected = report.opportunities.filter((o) => o.action === 'no_action')
  const actionable = allActionable.slice(0, MAX_ACTIONABLE_SHOWN)
  const rejected = allRejected.slice(0, MAX_REJECTED_SHOWN)

  return (
    <div className="space-y-5">
      <Panel
        title="Vixera Edge — Best Opportunities"
        right={
          <span className="vx-num">
            crypto scope · {report.scanned} scanned · {report.covered} covered · {report.noCoverage} no
            coverage
          </span>
        }
      >
        {report.failures.length > 0 && (
          <div className="mb-3 space-y-1 border-b border-vx-border pb-3">
            {report.failures.map((f) => (
              <ErrorState key={f} compact title="Venue" message={f} />
            ))}
          </div>
        )}
        <EdgeExplorer opportunities={actionable} />
        {allActionable.length > actionable.length && (
          <p className="mt-3 border-t border-vx-border pt-2 text-[11px] text-vx-caption">
            Showing top {actionable.length} of {allActionable.length} scored opportunities.
          </p>
        )}
      </Panel>

      {/* No-action is a FEATURE (§41): Vixera saying "nothing here" is the
          product working, and the reasons are shown, not buried. */}
      <Panel
        title="No Action — Evaluated and Rejected"
        right={<span className="vx-num">{allRejected.length} markets</span>}
      >
        {rejected.length === 0 ? (
          <EmptyState
            title="No rejected markets in this scan"
            detail="Every covered market cleared the action thresholds — or nothing was covered at all (see the counts above)."
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {rejected.map((o) => (
                <MarketOpportunityCard key={o.id} opportunity={o} compact />
              ))}
            </div>
            {allRejected.length > rejected.length && (
              <p className="mt-3 border-t border-vx-border pt-2 text-[11px] text-vx-caption">
                Showing {rejected.length} of {allRejected.length} rejected markets.
              </p>
            )}
          </>
        )}
      </Panel>

      <DisclaimerFooter />
    </div>
  )
}
