import { Panel } from '@/ui/Panel'
import { SkeletonBlock } from '@/ui/SkeletonBlock'

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading markets">
      <Panel title="Prediction Markets">
        <div className="space-y-2 py-1">
          {Array.from({ length: 12 }, (_, i) => (
            <SkeletonBlock key={i} className="h-5 w-full" />
          ))}
        </div>
      </Panel>
    </div>
  )
}
