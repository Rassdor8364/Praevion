import { CircleAlert } from 'lucide-react'
import { cn } from './lib'

export interface ErrorStateProps {
  readonly title?: string
  /** The ACTUAL error message. Never a euphemism, never placeholder numbers. */
  readonly message: string
  readonly className?: string
  readonly compact?: boolean
}

export function ErrorState({ title = 'Data unavailable', message, className, compact = false }: ErrorStateProps) {
  if (compact) {
    return (
      <div className={cn('flex items-center gap-2 py-1 text-xs text-vx-body', className)}>
        <CircleAlert size={13} className="shrink-0 text-vx-warn" aria-hidden />
        <span className="font-medium text-vx-heading">{title}:</span>
        <span className="truncate text-vx-caption" title={message}>
          {message}
        </span>
      </div>
    )
  }
  return (
    <div className={cn('flex flex-col items-center gap-2 py-8 text-center', className)}>
      <CircleAlert size={18} className="text-vx-warn" aria-hidden />
      <p className="text-sm font-medium text-vx-heading">{title}</p>
      <p className="max-w-lg break-words text-xs text-vx-caption">{message}</p>
    </div>
  )
}
