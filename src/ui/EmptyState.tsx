import { Database } from 'lucide-react'
import { cn } from './lib'

export interface EmptyStateProps {
  readonly title: string
  readonly detail?: string
  readonly className?: string
}

/** A missing value renders WHY it is missing — never a placeholder number. */
export function EmptyState({ title, detail, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-2 py-8 text-center', className)}>
      <Database size={18} className="text-vx-caption" aria-hidden />
      <p className="text-sm text-vx-body">{title}</p>
      {detail !== undefined && <p className="max-w-md text-xs text-vx-caption">{detail}</p>}
    </div>
  )
}
