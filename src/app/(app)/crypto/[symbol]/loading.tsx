import { Panel } from '@/ui/Panel'
import { SkeletonBlock } from '@/ui/SkeletonBlock'

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading crypto analysis">
      <SkeletonBlock className="h-8 w-72" />
      <Panel>
        <SkeletonBlock className="h-10 w-96 max-w-full" />
      </Panel>
      <Panel title="Multi-Timeframe Outlook">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonBlock key={i} className="h-36 w-full" />
          ))}
        </div>
      </Panel>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SkeletonBlock className="h-40 w-full" />
        <SkeletonBlock className="h-40 w-full" />
      </div>
    </div>
  )
}
