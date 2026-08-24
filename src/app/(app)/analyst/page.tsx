/**
 * The Analyst screen: a deterministic intelligence briefing composed from
 * Praevion's quantitative systems (plan §81), rendered as a terminal-style
 * report. Honesty contract: the header says "computed from live Praevion
 * data", the method note says no generative model is involved, and every
 * evidence-bearing line carries source chips back to the producing screen.
 * This page must never look like a chatbot, because it is not one.
 */

import type { Metadata } from 'next'
import { getAnalystOrchestrator } from '@/engines/analyst/orchestrator'
import { DataFreshness } from '@/ui/DataFreshness'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { ErrorState } from '@/ui/ErrorState'
import { Panel } from '@/ui/Panel'
import { AutoRefresh } from '../sports/AutoRefresh'
import { BriefingLineView, SectionView } from './ui'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'AI Analyst' }

function briefingClock(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })
}

export default async function AnalystPage() {
  const result = await getAnalystOrchestrator().getBriefing()

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <Panel title="Analyst Briefing">
          <ErrorState message={result.error.message} />
        </Panel>
        <DisclaimerFooter />
      </div>
    )
  }

  const { briefing, delta } = result.value

  return (
    <div className="space-y-5">
      <AutoRefresh intervalMs={120_000} />

      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-sm font-semibold uppercase tracking-[0.18em] text-vx-heading">
          Analyst Briefing
        </h1>
        <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-vx-body">
          computed from live Praevion data ·{' '}
          <span className="vx-num">{briefingClock(briefing.generatedAt)} UTC</span>
        </p>
        <span className="ml-auto">
          <DataFreshness dataAsOf={briefing.generatedAt} />
        </span>
      </header>

      {delta.since !== null && (
        <details className="vx-glass group p-0">
          <summary className="cursor-pointer list-none px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.18em] text-vx-caption hover:text-vx-heading">
            <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>
            What changed since {briefingClock(delta.since)} UTC
            <span className="vx-num ml-2 text-vx-accent">
              {delta.changes.length} change{delta.changes.length === 1 ? '' : 's'}
            </span>
          </summary>
          <div className="border-t border-vx-border px-4 py-3">
            {delta.changes.length === 0 ? (
              <p className="text-[13px] text-vx-caption">
                No material change: no direction flips, no confidence swings above 10pp, no new or
                dropped opportunities, no new breaking clusters.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {delta.changes.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-vx-accent" aria-hidden />
                    <BriefingLineView line={{ text: c.text, evidence: c.evidence }} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      )}

      <Panel padded>
        <div className="space-y-4">
          {briefing.sections.map((section, i) => (
            <SectionView key={section.id} section={section} index={i} />
          ))}
        </div>
      </Panel>

      <p className="text-[11px] leading-relaxed text-vx-caption">
        <span className="font-semibold uppercase tracking-[0.14em] text-vx-body">Method</span> —
        Deterministic briefing composed from Praevion&apos;s quantitative systems. No generative
        model is involved; every figure is computed, and every claim links to the system that
        produced it.
      </p>

      <DisclaimerFooter />
    </div>
  )
}
