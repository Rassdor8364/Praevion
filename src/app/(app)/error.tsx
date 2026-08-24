'use client'

import { RotateCcw } from 'lucide-react'
import { ErrorState } from '@/ui/ErrorState'
import { Panel } from '@/ui/Panel'

export default function AppError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string }
  readonly reset: () => void
}) {
  return (
    <div className="mx-auto max-w-2xl py-16">
      <Panel>
        <ErrorState
          title="This screen failed to render"
          message={error.message || 'Unknown error'}
        />
        <div className="flex justify-center pb-4">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex items-center gap-1.5 rounded border border-vx-border-strong px-3 py-1.5 text-xs text-vx-heading transition-colors hover:border-vx-accent/50 hover:bg-vx-accent/10"
          >
            <RotateCcw size={12} aria-hidden />
            Retry
          </button>
        </div>
        {error.digest !== undefined && (
          <p className="vx-num text-center text-[10px] text-vx-caption">digest {error.digest}</p>
        )}
      </Panel>
    </div>
  )
}
