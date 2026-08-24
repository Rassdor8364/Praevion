/**
 * POST/GET /api/cron/settle — resolve finished games against persisted
 * predictions.
 *
 * The scoring half of the learning loop, designed to be hit on a schedule
 * (Vercel cron or any external scheduler). Idempotent: settled predictions
 * leave the unsettled scan, and re-settlement upserts on prediction_id, so a
 * double-fired schedule converges instead of duplicating.
 *
 * When CRON_SECRET is set, requests must carry `Authorization: Bearer
 * <secret>` (the header Vercel cron sends). Without the env var the route is
 * open — acceptable because settlement writes nothing an attacker controls:
 * results come from the provider datasets, never from the request.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getSportsOrchestrator } from '@/engines/sports/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

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
    const result = await getSportsOrchestrator().settleFinishedGames()
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Settlement unavailable', detail: result.error.message },
        { status: 503 },
      )
    }
    return NextResponse.json({ ...result.value, timestamp: new Date().toISOString() })
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
