import { cn } from './lib'

export interface SparklineProps {
  readonly values: readonly number[]
  readonly width?: number
  readonly height?: number
  readonly className?: string
}

/** Inline SVG sparkline. Neutral cyan stroke — data accent, not valence. */
export function Sparkline({ values, width = 120, height = 28, className }: SparklineProps) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pad = 2
  const step = (width - pad * 2) / (values.length - 1)
  const points = values
    .map((v, i) => {
      const x = pad + i * step
      const y = pad + (1 - (v - min) / span) * (height - pad * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0', className)}
      role="img"
      aria-label="Trend sparkline"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--vx-live)"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.85}
      />
    </svg>
  )
}
