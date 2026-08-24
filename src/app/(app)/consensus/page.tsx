import type { Metadata } from 'next'
import { ComingSoon } from '@/ui/ComingSoon'

export const metadata: Metadata = { title: 'Consensus' }

export default function Page() {
  return (
    <ComingSoon
      feature="Consensus"
      phase="Phase 5 — Cross-domain"
      detail="Cross-venue consensus and dislocation views arrive with the knowledge-graph linkage work."
    />
  )
}
