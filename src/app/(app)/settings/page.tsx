import type { Metadata } from 'next'
import { ComingSoon } from '@/ui/ComingSoon'

export const metadata: Metadata = { title: 'Settings' }

export default function Page() {
  return (
    <ComingSoon
      feature="Settings"
      phase="a later phase (auth and tiers)"
      detail="Account, organisation and tier settings arrive with authentication."
    />
  )
}
