'use client'

/**
 * Left sidebar navigation.
 *
 *  - lg and up: full labels.
 *  - md: collapses to icons only (labels hidden, tooltips via title).
 *  - below md: hidden entirely; a bottom-safe hamburger opens an overlay drawer.
 *
 * Active state: blue left rule + slightly lighter background. No glow, no
 * animation beyond the drawer transition.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Menu, X } from 'lucide-react'
import { LogoLockup } from '../brand/logo'
import { cn } from '../lib'
import { NAV_ITEMS, type NavItem } from './nav'

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/') return pathname === '/'
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}

function NavLinks({ pathname, showLabels, onNavigate }: {
  readonly pathname: string
  readonly showLabels: boolean
  readonly onNavigate?: () => void
}) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item)
        const Icon = item.icon
        return (
          <div key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              title={item.label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 border-l-2 px-3 py-2 text-xs transition-colors',
                active
                  ? 'border-vx-accent bg-white/[0.04] text-vx-heading'
                  : 'border-transparent text-vx-body hover:bg-white/[0.02] hover:text-vx-heading',
              )}
            >
              <Icon size={15} strokeWidth={1.75} className="shrink-0" aria-hidden />
              {showLabels && <span className="truncate">{item.label}</span>}
            </Link>
            {showLabels && item.children !== undefined && active && (
              <div className="ml-8 flex flex-col gap-0.5 border-l border-vx-border py-1">
                {item.children.map((child) => (
                  <Link
                    key={child.href}
                    href={child.href}
                    onClick={onNavigate}
                    aria-current={pathname === child.href ? 'page' : undefined}
                    className={cn(
                      'px-3 py-1 text-[11px] transition-colors',
                      pathname === child.href ? 'text-vx-accent' : 'text-vx-caption hover:text-vx-body',
                    )}
                  >
                    {child.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}

export function SidebarNav() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* Desktop / tablet sidebar */}
      <aside className="sticky top-0 hidden h-screen shrink-0 flex-col border-r border-vx-border bg-vx-panel/60 py-3 backdrop-blur-md md:flex md:w-14 lg:w-56">
        <div className="hidden lg:block">
          <NavLinks pathname={pathname} showLabels />
        </div>
        <div className="lg:hidden">
          <NavLinks pathname={pathname} showLabels={false} />
        </div>
      </aside>

      {/* Mobile: bottom-safe hamburger + overlay drawer */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-vx-border-strong bg-vx-panel text-vx-heading shadow-lg md:hidden"
      >
        <Menu size={18} aria-hidden />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col overflow-y-auto border-r border-vx-border bg-vx-panel py-3">
            <div className="mb-2 flex items-center justify-between px-3">
              <LogoLockup markSize={22} textSize={11} byline={false} />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="p-1 text-vx-body hover:text-vx-heading"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <NavLinks pathname={pathname} showLabels onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  )
}
