import Link from 'next/link'
import { Search } from 'lucide-react'
import { LogoLockup } from '../brand/logo'
import { LiveIndicator } from './LiveIndicator'

/** Top bar: brand lockup, (future) global search, live freshness indicator. */
export function TopBar() {
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-4 border-b border-vx-border bg-vx-panel/60 px-4 backdrop-blur-md">
      <Link href="/" className="shrink-0 select-none" aria-label="Praevion — command center">
        <LogoLockup markSize={28} textSize={12} />
      </Link>

      <div className="relative mx-auto hidden w-full max-w-md sm:block">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-vx-caption" aria-hidden />
        <input
          type="search"
          placeholder="Search markets, assets, events…"
          aria-label="Global search (not yet functional — ships in a later phase)"
          className="w-full rounded border border-vx-border bg-white/[0.03] py-1.5 pl-8 pr-3 text-xs text-vx-heading placeholder:text-vx-caption focus:border-vx-accent/50 focus:outline-none"
        />
      </div>

      <div className="ml-auto shrink-0">
        <LiveIndicator />
      </div>
    </header>
  )
}
