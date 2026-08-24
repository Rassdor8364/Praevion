import type { Metadata } from 'next'
import { MIN_CALIBRATION_SAMPLES } from '@/core/metrics/calibration'
import { MIN_SAMPLE_FOR_DISPLAY } from '@/core/metrics/scoring'
import { isSupabaseConfigured } from '@/db/client'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { Panel } from '@/ui/Panel'
import { MetricsPanels } from '@/ui/performance/MetricsPanels'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Model Performance' }

/**
 * Model performance — the honest cold-start state.
 *
 * No settled prediction history exists yet, so there are no accuracy numbers
 * and none are invented. The panels render the real thresholds they wait for
 * and switch to real metrics automatically once settlement jobs populate the
 * database (MetricsPanels already accepts them).
 */
export default function PerformancePage() {
  const dbConfigured = isSupabaseConfigured()

  return (
    <div className="space-y-5">
      <Panel title="Model Performance" padded>
        <p className="max-w-3xl text-sm leading-relaxed text-vx-body">
          Every Vixera prediction is scored against reality once its horizon settles. Nothing on this
          page is backfilled, simulated, or extrapolated: scores appear only after{' '}
          <span className="vx-num text-vx-heading">{MIN_SAMPLE_FOR_DISPLAY}</span> live predictions have
          settled, and the calibration curve only after{' '}
          <span className="vx-num text-vx-heading">{MIN_CALIBRATION_SAMPLES}</span>. Demo-mode
          predictions are excluded from all statistics by construction.
        </p>
        {!dbConfigured && (
          <p className="mt-3 border-t border-vx-border pt-3 text-xs text-vx-caption">
            Data unavailable — database not configured. Settled-prediction history is written by
            background jobs once a database is attached; until then the thresholds below are the whole
            truth.
          </p>
        )}
      </Panel>

      <MetricsPanels />

      <Panel title="How these metrics are computed" padded>
        <ol className="max-w-3xl list-decimal space-y-2 pl-5 text-xs leading-relaxed text-vx-body">
          <li>
            A prediction is <span className="text-vx-heading">frozen</span> at generation time with its full
            probability distribution, model pool and data provenance.
          </li>
          <li>
            When the horizon elapses, the realised outcome is recorded from the same provider layer that
            fed the prediction — with its own timestamp and source.
          </li>
          <li>
            Brier score and log loss are computed per prediction and aggregated per model, per domain and
            per timeframe; the meta-combiner&apos;s weights derive from exactly these scores.
          </li>
          <li>
            Calibration buckets predictions by stated probability and compares each bucket&apos;s stated
            probability to its observed hit rate. Isotonic recalibration is applied only above{' '}
            <span className="vx-num text-vx-heading">{MIN_CALIBRATION_SAMPLES}</span> samples.
          </li>
        </ol>
      </Panel>

      <DisclaimerFooter />
    </div>
  )
}
