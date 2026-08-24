/**
 * POST/GET /api/cron/snapshot — generate and persist pre-kickoff prediction
 * snapshots for every supported league.
 *
 * The memory half of the learning loop: each league board run persists its
 * scheduled-fixture predictions (throttled per subject — see the
 * orchestrator's maybePersist), so a scheduled hit of this route keeps a
 * regular probability time-series flowing into the database without waiting
 * for page views. Failures per league are reported, never hidden: a league
 * whose provider is down contributes an error string, not a fabricated
 * board.
 */

import { NextResponse, type NextRequest } from 'next/server'
import {
  ESPN_LEAGUES,
  getSportsOrchestrator,
  getSportsPersistenceStats,
} from '@/engines/sports/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function unauthorized(request: NextRequest): boolean {
  const secret = process.env['CRON_SECRET']
  if (secret === undefined || secret.length === 0) return false
  return request.headers.get('authorization') !== `Bearer ${secret}`
}

async function run(request: NextRequest): Promise<NextResponse> {
  if (unauthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized', detail: 'CRON_SECRET mismatch' }, { status: 401 })
  }
  try {
    const orchestrator = getSportsOrchestrator()
    const leagues: Record<string, { predicted: number } | { error: string }> = {}

    // Sequential on purpose: the boards share one unkeyed upstream provider,
    // and a parallel burst across 7 leagues is exactly the stampede the
    // per-league caches exist to avoid.
    for (const leagueId of Object.keys(ESPN_LEAGUES)) {
      const board = await orchestrator.getLeagueBoard(leagueId)
      leagues[leagueId] = board.ok
        ? { predicted: board.value.upcoming.length }
        : { error: board.error.message }
    }

    return NextResponse.json({
      leagues,
      persistence: getSportsPersistenceStats(),
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return run(request)
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return run(request)
}
