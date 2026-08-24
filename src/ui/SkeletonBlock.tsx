import { cn } from './lib'

export interface SkeletonBlockProps {
  readonly className?: string
}

export function SkeletonBlock({ className }: SkeletonBlockProps) {
  return (
    <div
      className={cn('animate-pulse rounded bg-white/[0.05]', className ?? 'h-4 w-full')}
      aria-hidden
    />
  )
}
