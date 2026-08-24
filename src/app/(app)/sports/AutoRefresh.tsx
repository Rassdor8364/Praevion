'use client'

/**
 * Silent server-data refresh: re-runs the current route's server components
 * on an interval via router.refresh(), so the force-dynamic sports screens
 * pick up new fixtures/results without a manual reload. Renders nothing —
 * the visible freshness claim stays with DataFreshness, which shows the
 * data's actual age rather than implying this poll always succeeds.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export function AutoRefresh({ intervalMs = 120_000 }: { readonly intervalMs?: number }) {
  const router = useRouter()

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh()
    }, intervalMs)
    return () => clearInterval(id)
  }, [router, intervalMs])

  return null
}
