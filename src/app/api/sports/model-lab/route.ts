/**
 * GET /api/sports/model-lab?league=eng.1
 *
 * The Model Lab payload: real walk-forward validation of the learned model
 * on the league's own history, the measured per-model leaderboard from
 * settled predictions (when a database is configured), the calibration
 * report, and the adaptive weights in force. Thin route — everything is
 * computed in the sports orchestrator.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSportsOrchestrator } from '@/engines/sports/orchestrator'
import { ESPN_LEAGUES } from '@/providers/sports/espn'

export const dynamic = 'force-dynamic'

const leagueSchema = z
  .string()
  .refine((id) => id in ESPN_LEAGUES, {
    message: `league must be one of ${Object.keys(ESPN_LEAGUES).join(', ')}`,
  })

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const parsed = leagueSchema.safeParse(request.nextUrl.searchParams.get('league') ?? 'eng.1')
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query', detail: parsed.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      )
    }

    const result = await getSportsOrchestrator().getModelLabReport(parsed.data)
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: result.error.message },
        { status: 503 },
      )
    }
    return NextResponse.json(result.value)
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
