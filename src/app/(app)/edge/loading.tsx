import { Panel } from '@/ui/Panel'
import { SkeletonBlock } from '@/ui/SkeletonBlock'

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Scanning markets">
      <Panel title="Vixera Edge — Best Opportunities">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonBlock key={i} className="h-44 w-full" />
          ))}
        </div>
      </Panel>
    </div>
  )
}
