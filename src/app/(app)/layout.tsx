import type { ReactNode } from 'react'
import { SidebarNav } from '@/ui/shell/SidebarNav'
import { TopBar } from '@/ui/shell/TopBar'

export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-screen">
      <SidebarNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 pb-24 md:pb-8">{children}</main>
      </div>
    </div>
  )
}
