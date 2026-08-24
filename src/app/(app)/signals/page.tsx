import type { Metadata } from 'next'
import { ComingSoon } from '@/ui/ComingSoon'

export const metadata: Metadata = { title: 'Signals' }

export default function Page() {
  return (
    <ComingSoon
      feature="Signals"
      phase="the Signals phase (plan step 15)"
      detail="The signals engine attaches to the existing prediction pipeline; no synthetic signals will be shown before it exists."
    />
  )
}
