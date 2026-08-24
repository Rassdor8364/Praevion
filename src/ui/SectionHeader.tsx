import type { ReactNode } from 'react'
import { cn } from './lib'

export interface SectionHeaderProps {
  readonly title: string
  readonly right?: ReactNode
  readonly className?: string
}

export function SectionHeader({ title, right, className }: SectionHeaderProps) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3', className)}>
      <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-vx-caption">
        {title}
      </h2>
      {right !== undefined && <div className="text-xs text-vx-caption">{right}</div>}
    </div>
  )
}
