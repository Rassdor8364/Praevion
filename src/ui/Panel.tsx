import type { ReactNode } from 'react'
import { cn } from './lib'
import { SectionHeader } from './SectionHeader'

export interface PanelProps {
  readonly title?: string
  readonly right?: ReactNode
  readonly children: ReactNode
  readonly className?: string
  readonly padded?: boolean
}

/** Glass panel — the base surface of every data-bearing region. */
export function Panel({ title, right, children, className, padded = true }: PanelProps) {
  return (
    <section className={cn('vx-glass', padded && 'p-4', className)}>
      {(title !== undefined || right !== undefined) && (
        <SectionHeader title={title ?? ''} right={right} className={cn('mb-3', !padded && 'px-4 pt-4')} />
      )}
      {children}
    </section>
  )
}
