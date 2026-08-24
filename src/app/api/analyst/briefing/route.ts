/**
 * GET /api/analyst/briefing?diff=true
 *
 * The deterministic Analyst briefing: typed sections composed from live
 * Praevion systems, every claim carrying evidence refs. `diff=true` includes
 * the whatChanged delta vs the previous briefing. Thin route: validates,
 * calls the analyst orchestrator, maps the Result — no logic of its own.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getAnalystOrchestrator } from '@/engines/analyst/orchestrator'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const includeDiff = request.nextUrl.searchParams.get('diff') === 'true'

    const result = await getAnalystOrchestrator().getBriefing()
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: result.error.message },
        { status: 503 },
      )
    }

    const { briefing, delta } = result.value
    return NextResponse.json(includeDiff ? { briefing, delta } : { briefing })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
