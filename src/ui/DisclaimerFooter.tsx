import { PROBABILISTIC_DISCLAIMER } from '@/core/prediction/types'
import { cn } from './lib'

export interface DisclaimerFooterProps {
  readonly className?: string
}

/** Persistent probabilistic disclaimer — present on every financial screen. */
export function DisclaimerFooter({ className }: DisclaimerFooterProps) {
  return (
    <footer className={cn('border-t border-vx-border pt-4 pb-2', className)}>
      <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.18em] text-vx-body">
        Praevion <span className="text-vx-caption">· by Vixera AI</span>
      </p>
      <p className="text-[11px] leading-relaxed text-vx-caption">{PROBABILISTIC_DISCLAIMER}</p>
    </footer>
  )
}
