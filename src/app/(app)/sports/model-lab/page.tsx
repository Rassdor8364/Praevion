/**
 * /sports/model-lab — the actual brain of Praevion, shown honestly.
 *
 * Every number on this page is computed from real data at request time:
 * walk-forward validation replays the league's own history chronologically,
 * the leaderboard and calibration read settled predictions, and the adaptive
 * weights table shows the audit trail of the multipliers currently in force.
 * Sections whose backing data does not exist yet say so — there are no
 * placeholder metrics anywhere on this page.
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { getSportsOrchestrator, type ModelLabReport } from '@/engines/sports/orchestrator'
import { ESPN_LEAGUES } from '@/providers/sports/espn'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { EmptyState } from '@/ui/EmptyState'
import { ErrorState } from '@/ui/ErrorState'
import { Panel } from '@/ui/Panel'
import { Stat } from '@/ui/Stat'
import { cn, formatPct } from '@/ui/lib'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Model Lab — Sports' }

interface PageProps {
  readonly searchParams: Promise<{ league?: string }>
}

function fmt(value: number | null | undefined, digits = 4): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(digits)
}

const MODEL_LABELS: Record<string, string> = {
  'football.dixon-coles': 'Dixon–Coles',
  'football.elo-davidson': 'Elo–Davidson',
  'football.form-venue': 'Form/Venue',
  'football.learned': 'Learned Model',
  ensemble: 'Praevion Ensemble',
}

export default async function ModelLabPage({ searchParams }: PageProps) {
  const requested = (await searchParams).league
  const leagueId = requested !== undefined && requested in ESPN_LEAGUES ? requested : 'eng.1'

  const result = await getSportsOrchestrator().getModelLabReport(leagueId)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight text-vx-heading">Model Lab</h1>
        <p className="mt-0.5 text-xs text-vx-caption">
          Walk-forward validation, measured model performance and the ensemble weights in force —
          all computed from real data, never quoted.
        </p>
      </div>

      {/* League selector */}
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(ESPN_LEAGUES).map(([id, league]) => (
          <Link
            key={id}
            href={`/sports/model-lab?league=${id}`}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[11px]',
              id === leagueId
                ? 'border-vx-accent/60 bg-vx-accent/10 text-vx-heading'
                : 'border-vx-border text-vx-body hover:text-vx-heading',
            )}
          >
            {(league as { name: string }).name}
          </Link>
        ))}
      </div>

      {!result.ok ? (
        <Panel>
          <ErrorState message={result.error.message} />
        </Panel>
      ) : (
        <ModelLabBody report={result.value} />
      )}

      <DisclaimerFooter />
    </div>
  )
}

function ModelLabBody({ report }: { readonly report: ModelLabReport }) {
  const wf = report.walkForward
  const settled = report.settledPerformance
  const calibration = report.calibration
  const weights = report.adaptiveWeights

  return (
    <>
      {/* Current model */}
      <Panel title={`Current Model — ${report.leagueName}`}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Ensemble version" value={report.modelVersions['ensemble'] ?? '—'} />
          <Stat label="Learned version" value={report.modelVersions['learned'] ?? '—'} />
          <Stat label="Dataset games" value={String(report.datasetGames)} />
          <Stat label="Training samples" value={String(report.trainingSamples)} />
          <Stat label="Cold-start skips" value={String(report.skippedColdStart)} />
          <Stat label="Settled predictions" value={settled === null ? '0' : String(settled.totalSettled)} />
        </div>
        <p className="mt-3 border-t border-vx-border pt-2 text-[10px] leading-relaxed text-vx-caption">
          The pool: Dixon–Coles (fitted attack/defence), Elo–Davidson (result trajectory),
          Form/Venue (transparent heuristic), and the Learned Model (L2-regularized multinomial
          logistic regression trained on this league&rsquo;s own history at every request). Combined by
          weighted log-odds pooling; abstention removes a model from the pool entirely.
        </p>
      </Panel>

      {/* Walk-forward validation */}
      <Panel title="Walk-Forward Validation — Learned Model vs Base Rates">
        {wf === null ? (
          <EmptyState
            title="History too thin"
            detail={`Walk-forward validation needs at least ${120 + 40} usable training games in this league's dataset window; predictions fall back to the fitted models meanwhile.`}
          />
        ) : (
          <>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
                  <th className="pb-1 font-normal">Model</th>
                  <th className="pb-1 text-right font-normal">Brier ↓</th>
                  <th className="pb-1 text-right font-normal">Log loss ↓</th>
                  <th className="pb-1 text-right font-normal">Accuracy</th>
                  <th className="pb-1 text-right font-normal">Validated</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: 'Learned Model', r: wf.learned },
                  { name: 'Base-rate benchmark', r: wf.baseRate },
                ].map(({ name, r }) => (
                  <tr key={name} className="border-t border-vx-border/60">
                    <td className="py-1.5 text-vx-heading">{name}</td>
                    <td className="vx-num py-1.5 text-right text-vx-body">{fmt(r.brier)}</td>
                    <td className="vx-num py-1.5 text-right text-vx-body">{fmt(r.logLoss)}</td>
                    <td className="vx-num py-1.5 text-right text-vx-body">{formatPct(r.accuracy)}</td>
                    <td className="vx-num py-1.5 text-right text-vx-caption">{r.totalValidated}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-vx-body">
              {wf.learned.brier < wf.baseRate.brier ? (
                <>
                  The learned features carry real signal in this league: Brier{' '}
                  <span className="vx-num text-vx-pos">{fmt(wf.learned.brier)}</span> vs the
                  base-rate benchmark&rsquo;s{' '}
                  <span className="vx-num">{fmt(wf.baseRate.brier)}</span> over{' '}
                  {wf.learned.totalValidated} chronologically held-out games.
                </>
              ) : (
                <>
                  The learned model does NOT currently beat base rates in this league (Brier{' '}
                  <span className="vx-num text-vx-neg">{fmt(wf.learned.brier)}</span> vs{' '}
                  <span className="vx-num">{fmt(wf.baseRate.brier)}</span>) — its low ensemble
                  confidence reflects exactly that.
                </>
              )}
            </p>
            <div className="mt-3 border-t border-vx-border pt-2">
              <h4 className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-vx-caption">
                Folds (train → validate, rolling forward)
              </h4>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
                    <th className="pb-1 font-normal">Window</th>
                    <th className="pb-1 text-right font-normal">Train</th>
                    <th className="pb-1 text-right font-normal">Validate</th>
                    <th className="pb-1 text-right font-normal">Brier</th>
                    <th className="pb-1 text-right font-normal">Accuracy</th>
                  </tr>
                </thead>
                <tbody>
                  {wf.learned.folds.map((f) => (
                    <tr key={f.from} className="border-t border-vx-border/60">
                      <td className="vx-num py-1 text-vx-body">
                        {new Date(f.from).toISOString().slice(0, 10)} →{' '}
                        {new Date(f.to).toISOString().slice(0, 10)}
                      </td>
                      <td className="vx-num py-1 text-right text-vx-caption">{f.trainSize}</td>
                      <td className="vx-num py-1 text-right text-vx-caption">{f.validationSize}</td>
                      <td className="vx-num py-1 text-right text-vx-body">{fmt(f.brier)}</td>
                      <td className="vx-num py-1 text-right text-vx-body">{formatPct(f.accuracy)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1.5 text-[10px] leading-relaxed text-vx-caption">
                Each fold trains only on games BEFORE its validation window — the model never sees
                its own future. No random shuffling across time, ever.
              </p>
            </div>
          </>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Measured leaderboard */}
        <Panel title="Model Leaderboard — settled predictions">
          {settled === null ? (
            <EmptyState
              title="No settled predictions yet"
              detail={
                report.databaseConfigured
                  ? 'Predictions are being persisted; the leaderboard appears once games finish and the settlement job scores them.'
                  : 'Requires the database configuration (SUPABASE_SERVICE_ROLE_KEY) so predictions persist and settle.'
              }
            />
          ) : (
            <>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
                    <th className="pb-1 font-normal">Model</th>
                    <th className="pb-1 text-right font-normal">Brier ↓</th>
                    <th className="pb-1 text-right font-normal">Log loss ↓</th>
                    <th className="pb-1 text-right font-normal">Accuracy</th>
                    <th className="pb-1 text-right font-normal">Samples</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(settled.ensemble !== null ? [settled.ensemble] : []), ...settled.perModel].map((m) => (
                    <tr key={m.modelId} className="border-t border-vx-border/60">
                      <td className="py-1.5 text-vx-heading">{MODEL_LABELS[m.modelId] ?? m.modelId}</td>
                      <td className="vx-num py-1.5 text-right text-vx-body">{fmt(m.brier)}</td>
                      <td className="vx-num py-1.5 text-right text-vx-body">{fmt(m.logLoss)}</td>
                      <td className="vx-num py-1.5 text-right text-vx-body">{formatPct(m.accuracy)}</td>
                      <td className="vx-num py-1.5 text-right text-vx-caption">{m.sampleSize}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[10px] leading-relaxed text-vx-caption">
                Scored from each model&rsquo;s own persisted pre-kickoff distribution against the
                verified result. Demo-mode predictions are excluded at the aggregation boundary.
              </p>
            </>
          )}
        </Panel>

        {/* Adaptive weights */}
        <Panel title="Adaptive Ensemble Weights">
          {weights === null ? (
            <EmptyState
              title="Designed weights in force"
              detail="Weights adapt from measured settled performance (minimum 30 samples per model, shrunk and capped). Until then every model keeps its designed influence — a lucky streak buys nothing."
            />
          ) : (
            <>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
                    <th className="pb-1 font-normal">Model</th>
                    <th className="pb-1 text-right font-normal">Brier</th>
                    <th className="pb-1 text-right font-normal">Skill</th>
                    <th className="pb-1 text-right font-normal">Weight</th>
                    <th className="pb-1 text-right font-normal">Samples</th>
                  </tr>
                </thead>
                <tbody>
                  {weights.rationale.map((r) => (
                    <tr key={r.modelId} className="border-t border-vx-border/60">
                      <td className="py-1.5 text-vx-heading">{MODEL_LABELS[r.modelId] ?? r.modelId}</td>
                      <td className="vx-num py-1.5 text-right text-vx-body">{fmt(r.brier)}</td>
                      <td className="vx-num py-1.5 text-right text-vx-body">
                        {r.gated ? '—' : fmt(r.shrunkSkill, 3)}
                      </td>
                      <td
                        className={cn(
                          'vx-num py-1.5 text-right',
                          r.gated ? 'text-vx-caption' : r.weight > 1 ? 'text-vx-pos' : r.weight < 1 ? 'text-vx-neg' : 'text-vx-body',
                        )}
                      >
                        {r.weight.toFixed(2)}
                        {r.gated ? ' (gated)' : ''}
                      </td>
                      <td className="vx-num py-1.5 text-right text-vx-caption">{r.sampleSize}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[10px] leading-relaxed text-vx-caption">
                From {weights.totalSettled} settled predictions, computed {weights.computedAt}.
                Skill = 1 − Brier/(2⁄3) shrunk by sample size; weights clamp to [0.4, 1.6]. Models
                under the 30-sample minimum stay at exactly 1.0.
              </p>
            </>
          )}
        </Panel>
      </div>

      {/* Calibration */}
      <Panel title="Calibration — predicted vs observed">
        {calibration === null || calibration.sampleSize === 0 ? (
          <EmptyState
            title="No calibration data yet"
            detail="The reliability curve compares predicted probabilities with observed frequencies over settled predictions. It appears once real outcomes accumulate — calibrating on tiny samples would be fabrication."
          />
        ) : (
          <>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
                  <th className="pb-1 font-normal">Bucket</th>
                  <th className="pb-1 text-right font-normal">Mean predicted</th>
                  <th className="pb-1 text-right font-normal">Observed</th>
                  <th className="pb-1 text-right font-normal">Gap</th>
                  <th className="pb-1 text-right font-normal">n</th>
                </tr>
              </thead>
              <tbody>
                {calibration.bins
                  .filter((b) => b.count > 0)
                  .map((b) => (
                    <tr key={b.lower} className="border-t border-vx-border/60">
                      <td className="vx-num py-1 text-vx-body">
                        {formatPct(b.lower, 0)}–{formatPct(b.upper, 0)}
                      </td>
                      <td className="vx-num py-1 text-right text-vx-body">{formatPct(b.meanPredicted)}</td>
                      <td className="vx-num py-1 text-right text-vx-body">{formatPct(b.observedFrequency)}</td>
                      <td
                        className={cn(
                          'vx-num py-1 text-right',
                          Math.abs(b.meanPredicted - b.observedFrequency) > 0.05
                            ? 'text-vx-warn'
                            : 'text-vx-caption',
                        )}
                      >
                        {formatPct(b.meanPredicted - b.observedFrequency)}
                      </td>
                      <td className="vx-num py-1 text-right text-vx-caption">{b.count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-vx-caption">
              ECE {fmt(calibration.ece, 4)} · MCE {fmt(calibration.mce, 4)} · {calibration.sampleSize}{' '}
              outcome observations (one-vs-rest over the full probability vector).
            </p>
          </>
        )}
      </Panel>
    </>
  )
}
