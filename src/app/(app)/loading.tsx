import { Panel } from '@/ui/Panel'
import { SkeletonBlock } from '@/ui/SkeletonBlock'

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading">
      <Panel title="Loading">
        <div className="space-y-3 py-1">
          <SkeletonBlock className="h-5 w-full" />
          <SkeletonBlock className="h-5 w-11/12" />
          <SkeletonBlock className="h-5 w-full" />
        </div>
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SkeletonBlock className="h-40 w-full" />
        <SkeletonBlock className="h-40 w-full" />
      </div>
    </div>
  )
}
