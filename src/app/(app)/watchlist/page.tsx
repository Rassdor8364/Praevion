import type { Metadata } from 'next'
import { ComingSoon } from '@/ui/ComingSoon'

export const metadata: Metadata = { title: 'Watchlist' }

export default function Page() {
  return (
    <ComingSoon
      feature="Watchlist"
      phase="the Watchlist phase (plan step 15)"
      detail="Watchlist and alert architecture landed in Phase 1; the user-facing screen ships with signals and alerts."
    />
  )
}
