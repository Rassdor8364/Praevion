/**
 * /sports/learning — the live state of the self-learning loop.
 *
 * The loop this page reports on: predict → persist (pre-kickoff snapshot) →
 * game finishes → settle against the verified score → score every model →
 * recompute adaptive ensemble weights → future predictions use them. Every
 * figure is measured; a stage whose backing store is not configured says so
 * in words rather than showing a zero that would read as "checked, empty".
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { getSportsOrchestrator } from '@/engines/sports/orchestrator'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { EmptyState } from '@/ui/EmptyState'
import { Panel } from '@/ui/Panel'
import { Stat } from '@/ui/Stat'
import { cn, formatPct } from '@/ui/lib'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Learning — Sports' }

const LOOP_STEPS = [
  { key: 'predict', label: 'Predict', detail: 'Ensemble prices upcoming fixtures' },
  { key: 'persist', label: 'Persist', detail: 'Pre-kickoff snapshot locked' },
  { key: 'resolve', label: 'Resolve', detail: 'Verified final score settles it' },
  { key: 'score', label: 'Score', detail: 'Brier & log loss per model' },
  { key: 'adapt', label: 'Adapt', detail: 'Measured skill reweights the pool' },
] as const

export default async function LearningPage() {
  const status = await getSportsOrchestrator().getLearningStatus()
  const { persistence, adaptiveWeights, ensembleScore } = status

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight text-vx-heading">Learning</h1>
        <p className="mt-0.5 text-xs text-vx-caption">
          The self-learning loop, reported from its own records. Nothing here is projected or
          illustrative — see the <Link href="/sports/model-lab" className="text-vx-accent-2 hover:underline">Model Lab</Link> for
          validation metrics.
        </p>
      </div>

      {/* The loop */}
      <Panel title="The Loop">
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-5">
          {LOOP_STEPS.map((step, i) => (
            <li key={step.key} className="rounded-md border border-vx-border bg-white/[0.02] p-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">
                {i + 1} · {step.label}
              </div>
              <div className="mt-1 text-[11px] leading-snug text-vx-body">{step.detail}</div>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[10px] leading-relaxed text-vx-caption">
          Adaptation means parameters, weights and calibration change with evidence — the code
          never rewrites itself, and no weight moves without a minimum sample behind it.
        </p>
      </Panel>

      {/* Live counters */}
      <Panel title="Loop State">
        {!status.databaseConfigured ? (
          <EmptyState
            title="Prediction memory not configured"
            detail="The loop's memory (persist → resolve → score → adapt) requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Predictions still compute live; they are just not being remembered, so nothing can settle or adapt yet."
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Open predictions" value={status.unsettledCount === null ? '—' : String(status.unsettledCount)} />
            <Stat label="Settled (scored)" value={status.settledTotal === null ? '—' : String(status.settledTotal)} />
            <Stat
              label="Ensemble Brier"
              value={ensembleScore === null ? '—' : ensembleScore.brier.toFixed(4)}
            />
            <Stat
              label="Ensemble accuracy"
              value={ensembleScore === null ? '—' : formatPct(ensembleScore.accuracy)}
            />
            <Stat
              label="Adaptive weights"
              value={adaptiveWeights === null ? 'designed' : `${adaptiveWeights.rationale.filter((r) => !r.gated).length} adapted`}
            />
            <Stat
              label="Saved this instance"
              value={`${persistence.saved}${persistence.failed > 0 ? ` (+${persistence.failed} failed)` : ''}`}
            />
          </div>
        )}
        {persistence.lastError !== null && (
          <p className="mt-3 border-t border-vx-border pt-2 text-[11px] text-vx-warn">
            Last persistence error: {persistence.lastError}
          </p>
        )}
        <p className="mt-3 border-t border-vx-border pt-2 text-[10px] leading-relaxed text-vx-caption">
          Model versions: ensemble{' '}
          <span className="vx-num text-[11px] text-vx-heading">{status.modelVersions['ensemble']}</span> ·
          learned{' '}
          <span className="vx-num text-[11px] text-vx-heading">{status.modelVersions['learned']}</span>.
          Snapshot cadence: at most one persisted snapshot per fixture per 30 minutes; the
          settlement job (`/api/cron/settle`) resolves finished games idempotently.
        </p>
      </Panel>

      {/* What the weights say — real learning output */}
      <Panel title="What Praevion Has Learned">
        {adaptiveWeights === null ? (
          <EmptyState
            title="Nothing yet — honestly"
            detail="Learning statements appear only when statistical evidence exists: settled predictions per model beyond the minimum sample. Until then Praevion reports designed behaviour rather than inventing insights."
          />
        ) : (
          <ul className="space-y-2 text-xs text-vx-body">
            {adaptiveWeights.rationale
              .filter((r) => !r.gated)
              .map((r) => (
                <li key={r.modelId} className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'vx-num w-12 shrink-0 text-right',
                      r.weight > 1 ? 'text-vx-pos' : r.weight < 1 ? 'text-vx-neg' : 'text-vx-caption',
                    )}
                  >
                    ×{r.weight.toFixed(2)}
                  </span>
                  <span>
                    {r.modelId} — Brier {r.brier.toFixed(4)} over {r.sampleSize} settled predictions
                    ({r.weight > 1 ? 'earning influence' : r.weight < 1 ? 'losing influence' : 'neutral'}).
                  </span>
                </li>
              ))}
            {adaptiveWeights.rationale.filter((r) => r.gated).length > 0 && (
              <li className="text-[11px] text-vx-caption">
                {adaptiveWeights.rationale
                  .filter((r) => r.gated)
                  .map((r) => r.modelId)
                  .join(', ')}{' '}
                remain below the 30-sample minimum and stay at neutral weight.
              </li>
            )}
          </ul>
        )}
      </Panel>

      {/* Recent resolved */}
      <Panel title="Recently Resolved">
        {status.recentResolved === null || status.recentResolved.length === 0 ? (
          <EmptyState
            title="No resolved predictions yet"
            detail="Rows appear after persisted predictions' games finish and the settlement job runs."
          />
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
                <th className="pb-1 font-normal">Fixture</th>
                <th className="pb-1 text-right font-normal">Forecast (H/D/A)</th>
                <th className="pb-1 text-right font-normal">Result</th>
                <th className="pb-1 text-right font-normal">Verdict</th>
                <th className="pb-1 text-right font-normal">Brier</th>
              </tr>
            </thead>
            <tbody>
              {status.recentResolved.map((r) => {
                const probs = ['home', 'draw', 'away']
                  .map((k) => formatPct(r.outcomes.find((o) => o.key === k)?.probability ?? Number.NaN, 0))
                  .join(' / ')
                const score = `${String(r.evidence['homeScore'] ?? '?')}–${String(r.evidence['awayScore'] ?? '?')}`
                return (
                  <tr key={r.id} className="border-t border-vx-border/60">
                    <td className="max-w-[14rem] truncate py-1.5 text-vx-heading" title={r.subjectLabel}>
                      {r.subjectLabel}
                    </td>
                    <td className="vx-num py-1.5 text-right text-vx-body">{probs}</td>
                    <td className="vx-num py-1.5 text-right text-vx-body">{score}</td>
                    <td
                      className={cn(
                        'py-1.5 text-right text-[10px] uppercase tracking-[0.1em]',
                        r.wasCorrect ? 'text-vx-pos' : 'text-vx-neg',
                      )}
                    >
                      {r.wasCorrect ? 'Correct' : 'Missed'}
                    </td>
                    <td className="vx-num py-1.5 text-right text-vx-caption">
                      {r.brierScore === null ? '—' : Number(r.brierScore).toFixed(3)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <DisclaimerFooter />
    </div>
  )
}
