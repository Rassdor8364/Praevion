import type { Metadata } from 'next'
import { ComingSoon } from '@/ui/ComingSoon'

export const metadata: Metadata = { title: 'Backtesting' }

export default function Page() {
  return (
    <ComingSoon
      feature="Backtesting"
      phase="Phase 7 — Validation"
      detail="Point-in-time replay with an automated leakage guard; results will be labelled backtest, never live record."
    />
  )
}
