import { Panel } from '@/ui/Panel'
import { SkeletonBlock } from '@/ui/SkeletonBlock'

export default function SportsLoading() {
  return (
    <div className="space-y-5">
      <SkeletonBlock className="h-6 w-56" />
      <SkeletonBlock className="h-8 w-full" />
      <Panel title="Upcoming Fixtures">
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonBlock key={i} className="h-10 w-full" />
          ))}
        </div>
      </Panel>
      <Panel title="Recent Results">
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonBlock key={i} className="h-6 w-full" />
          ))}
        </div>
      </Panel>
    </div>
  )
}
