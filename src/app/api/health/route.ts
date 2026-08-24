/**
 * GET /api/health — system health: provider registry, database configuration,
 * prediction persistence and the learning loop. No credentials are ever
 * echoed — configuration is reported as booleans, errors as messages.
 */

import { NextResponse } from 'next/server'
import { isServiceRoleConfigured, isSupabaseConfigured } from '@/db/client'
import { getSportsPersistenceStats } from '@/engines/sports/orchestrator'
import { getRegistry } from '@/providers'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  try {
    const providers = await getRegistry().healthReport()
    const healthy = Object.values(providers).every((p) => p.healthy)
    const persistence = getSportsPersistenceStats()

    return NextResponse.json({
      status: healthy ? 'ok' : 'degraded',
      providers,
      database: {
        configured: isSupabaseConfigured(),
        serviceRole: isServiceRoleConfigured(),
      },
      predictionPersistence: {
        enabled: isServiceRoleConfigured(),
        ...persistence,
      },
      oddsProvider: {
        configured: (process.env['ODDS_API_KEY'] ?? '').length > 0,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
