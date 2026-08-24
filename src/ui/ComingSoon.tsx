import { Hourglass } from 'lucide-react'
import { Panel } from './Panel'

export interface ComingSoonProps {
  readonly feature: string
  /** Which development phase honestly delivers this (per IMPLEMENTATION_PLAN §17). */
  readonly phase: string
  readonly detail?: string
}

/** Honest placeholder for navigation targets that are planned, not built. */
export function ComingSoon({ feature, phase, detail }: ComingSoonProps) {
  return (
    <div className="mx-auto max-w-2xl py-16">
      <Panel>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Hourglass size={20} className="text-vx-caption" aria-hidden />
          <h1 className="text-base font-semibold tracking-wide text-vx-heading">{feature}</h1>
          <p className="text-sm text-vx-body">
            Not built yet. This screen ships in <span className="text-vx-accent">{phase}</span>.
          </p>
          {detail !== undefined && <p className="max-w-md text-xs text-vx-caption">{detail}</p>}
          <p className="text-[11px] text-vx-caption">
            Vixera does not render placeholder numbers — this page will stay honest until the real data exists.
          </p>
        </div>
      </Panel>
    </div>
  )
}
