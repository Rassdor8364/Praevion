/**
 * Model-performance metric panels.
 *
 * Cold-start honesty (plan §18 R6, brief §40): with no settled prediction
 * history there are NO statistics to show, and none are fabricated. Each panel
 * states the real sample threshold it is waiting for. The `metrics` prop is
 * already wired: the moment settled history exists, the same panels render the
 * real numbers.
 */

import { MIN_CALIBRATION_SAMPLES } from '@/core/metrics/calibration'
import { MIN_SAMPLE_FOR_DISPLAY } from '@/core/metrics/scoring'
import { Panel } from '../Panel'
import { cn } from '../lib'

export interface PerformanceMetrics {
  readonly settledCount: number
  readonly brierScore: number | null
  readonly logLoss: number | null
  /** Mean |predicted − observed| across calibration buckets, 0..1. */
  readonly calibrationError: number | null
  readonly calibrationSampleSize: number
}

export interface MetricsPanelsProps {
  readonly metrics?: PerformanceMetrics
  readonly className?: string
}

function MetricPanel({
  title,
  value,
  requiredSamples,
  haveSamples,
  explainer,
}: {
  readonly title: string
  readonly value: string | null
  readonly requiredSamples: number
  readonly haveSamples: number
  readonly explainer: string
}) {
  return (
    <Panel title={title}>
      {value !== null ? (
        <p className="vx-num py-2 text-2xl font-semibold text-vx-heading">{value}</p>
      ) : (
        <div className="py-2">
          <p className="text-sm text-vx-body">
            Insufficient data — <span className="vx-num text-vx-heading">{requiredSamples}</span> settled
            predictions required
            <span className="vx-num text-vx-caption"> ({haveSamples} settled so far)</span>
          </p>
        </div>
      )}
      <p className="border-t border-vx-border pt-2 text-[11px] leading-relaxed text-vx-caption">{explainer}</p>
    </Panel>
  )
}

export function MetricsPanels({ metrics, className }: MetricsPanelsProps) {
  const settled = metrics?.settledCount ?? 0
  const showScores = metrics !== undefined && settled >= MIN_SAMPLE_FOR_DISPLAY
  const showCalibration =
    metrics !== undefined && metrics.calibrationSampleSize >= MIN_CALIBRATION_SAMPLES

  return (
    <div className={cn('grid grid-cols-1 gap-5 lg:grid-cols-3', className)}>
      <MetricPanel
        title="Brier Score"
        value={showScores && metrics !== undefined && metrics.brierScore !== null ? metrics.brierScore.toFixed(4) : null}
        requiredSamples={MIN_SAMPLE_FOR_DISPLAY}
        haveSamples={settled}
        explainer="Mean squared error between forecast probability and the 0/1 outcome. 0 is perfect; 0.25 is what always guessing 50% scores. It rewards both being right and being confident only when right."
      />
      <MetricPanel
        title="Log Loss"
        value={showScores && metrics !== undefined && metrics.logLoss !== null ? metrics.logLoss.toFixed(4) : null}
        requiredSamples={MIN_SAMPLE_FOR_DISPLAY}
        haveSamples={settled}
        explainer="Negative log-likelihood of the observed outcomes. It punishes confident wrong calls hard — a 99% forecast that misses costs far more than a 60% one. Lower is better."
      />
      <MetricPanel
        title="Calibration"
        value={
          showCalibration && metrics !== undefined && metrics.calibrationError !== null
            ? `${(metrics.calibrationError * 100).toFixed(1)}pp`
            : null
        }
        requiredSamples={MIN_CALIBRATION_SAMPLES}
        haveSamples={metrics?.calibrationSampleSize ?? 0}
        explainer="Of everything forecast at 70%, did about 70% actually happen? Calibration compares stated probability to observed frequency per bucket; the number shown is the mean gap. It is the difference between a probability and a vibe."
      />
    </div>
  )
}
