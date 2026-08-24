/**
 * GET /api/health — provider registry health report.
 */

import { NextResponse } from 'next/server'
import { getRegistry } from '@/providers'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  try {
    const providers = await getRegistry().healthReport()
    const healthy = Object.values(providers).every((p) => p.healthy)
    return NextResponse.json({
      status: healthy ? 'ok' : 'degraded',
      providers,
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
