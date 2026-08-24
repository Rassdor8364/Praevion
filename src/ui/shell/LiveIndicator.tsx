'use client'

/**
 * "Live" indicator: shows the current session clock ticking, which is the
 * honest claim being made — the terminal is rendering server data fetched at
 * request time, and this clock is the client's own. No fake heartbeat.
 */

import { useEffect, useState } from 'react'

export function LiveIndicator() {
  const [time, setTime] = useState<string | null>(null)

  useEffect(() => {
    const tick = () =>
      setTime(
        new Date().toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZone: 'UTC',
        }),
      )
    tick()
    const id = setInterval(tick, 1_000)
    return () => clearInterval(id)
  }, [])

  return (
    <span className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-vx-body">
      <span className="h-1.5 w-1.5 rounded-full bg-vx-live" aria-hidden />
      Live
      <span className="vx-num text-vx-caption" suppressHydrationWarning>
        {time === null ? '—' : `${time} UTC`}
      </span>
    </span>
  )
}
