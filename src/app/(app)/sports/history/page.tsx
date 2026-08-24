/**
 * /sports/history — the permanent prediction record.
 *
 * Every row shows the probabilities persisted BEFORE kickoff, exactly as they
 * were, against the verified final result. Nothing on this page is ever
 * recomputed with a newer model — an accuracy record you can amend after the
 * result is known is a marketing asset, not a record.
 */

import type { Metadata } from 'next'
import { isServiceRoleConfigured } from '@/db/client'
import { listPredictions, listResolvedPredictions } from '@/db/repositories'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { EmptyState } from '@/ui/EmptyState'
import { ErrorState } from '@/ui/ErrorState'
import { Panel } from '@/ui/Panel'
import { cn, formatPct } from '@/ui/lib'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Prediction History — Sports' }

function fmtWhen(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

export default async function HistoryPage() {
  if (!isServiceRoleConfigured()) {
    return (
      <div className="space-y-5">
        <Header />
        <Panel>
          <EmptyState
            title="Prediction memory not configured"
            detail="History requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY so predictions persist and settle. Once configured, every pre-kickoff forecast is stored permanently and scored against the verified result."
          />
        </Panel>
        <DisclaimerFooter />
      </div>
    )
  }

  const [resolved, open] = await Promise.all([
    listResolvedPredictions('sports', { limit: 100 }),
    listPredictions({ domain: 'sports', settled: false, limit: 50 }),
  ])

  return (
    <div className="space-y-5">
      <Header />

      <Panel title="Awaiting Result">
        {!open.ok ? (
          <ErrorState compact message={open.error.message} />
        ) : open.value.length === 0 ? (
          <EmptyState
            title="No open predictions"
            detail="Pre-kickoff snapshots appear here as fixtures are predicted, then move below once settled."
          />
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
                <th className="pb-1 font-normal">Fixture</th>
                <th className="pb-1 text-right font-normal">H / D / A</th>
                <th className="pb-1 text-right font-normal">Confidence</th>
                <th className="pb-1 text-right font-normal">Model</th>
                <th className="pb-1 text-right font-normal">Generated (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {open.value.map((p) => {
                const probs = ['home', 'draw', 'away']
                  .map((k) => formatPct(p.outcomes.find((o) => o.key === k)?.probability ?? Number.NaN, 0))
                  .join(' / ')
                return (
                  <tr key={p.id} className="border-t border-vx-border/60">
                    <td className="max-w-[16rem] truncate py-1.5 text-vx-heading" title={p.subject_label}>
                      {p.subject_label}
                    </td>
                    <td className="vx-num py-1.5 text-right text-vx-body">{probs}</td>
                    <td className="vx-num py-1.5 text-right text-vx-body">{formatPct(p.confidence, 0)}</td>
                    <td className="vx-num py-1.5 text-right text-vx-caption">{p.model_version}</td>
                    <td className="vx-num py-1.5 text-right text-vx-caption">{fmtWhen(p.generated_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Resolved — permanent record">
        {!resolved.ok ? (
          <ErrorState compact message={resolved.error.message} />
        ) : resolved.value.length === 0 ? (
          <EmptyState
            title="Nothing resolved yet"
            detail="Rows appear once persisted predictions' games finish and the settlement job scores them against the verified final score."
          />
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
                <th className="pb-1 font-normal">Fixture</th>
                <th className="pb-1 text-right font-normal">H / D / A</th>
                <th className="pb-1 text-right font-normal">Final</th>
                <th className="pb-1 text-right font-normal">Verdict</th>
                <th className="pb-1 text-right font-normal">Brier</th>
                <th className="pb-1 text-right font-normal">Model</th>
                <th className="pb-1 text-right font-normal">Predicted (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {resolved.value.map((r) => {
                const probs = ['home', 'draw', 'away']
                  .map((k) => formatPct(r.outcomes.find((o) => o.key === k)?.probability ?? Number.NaN, 0))
                  .join(' / ')
                const score = `${String(r.evidence['homeScore'] ?? '?')}–${String(r.evidence['awayScore'] ?? '?')}`
                return (
                  <tr key={r.id} className="border-t border-vx-border/60">
                    <td className="max-w-[16rem] truncate py-1.5 text-vx-heading" title={r.subjectLabel}>
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
                    <td className="vx-num py-1.5 text-right text-vx-caption">{r.modelVersion}</td>
                    <td className="vx-num py-1.5 text-right text-vx-caption">{fmtWhen(r.generatedAt)}</td>
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

function Header() {
  return (
    <div>
      <h1 className="text-base font-semibold tracking-tight text-vx-heading">Prediction History</h1>
      <p className="mt-0.5 text-xs text-vx-caption">
        Pre-kickoff forecasts, stored permanently and scored against verified results. Failed
        predictions stay in the record, in their original form, forever.
      </p>
    </div>
  )
}
