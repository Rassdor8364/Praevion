/**
 * GET /api/sports/games?league=eng.1
 *
 * Upcoming fixtures (next 14 days) plus recent results (last 7 days) for one
 * league. Thin route: validates input, calls the sports orchestrator, maps
 * the Result. A provider-chain failure is a 503 with the real reason — never
 * a fabricated fixture list (§19 no-fake-data guarantee).
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSportsOrchestrator } from '@/engines/sports/orchestrator'
import { ESPN_LEAGUES } from '@/providers/sports/espn'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  league: z.enum(Object.keys(ESPN_LEAGUES) as [string, ...string[]]),
})

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const parsed = querySchema.safeParse({
      league: request.nextUrl.searchParams.get('league') ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid query',
          detail: `league must be one of ${Object.keys(ESPN_LEAGUES).join(', ')}`,
        },
        { status: 400 },
      )
    }

    const result = await getSportsOrchestrator().getFixtures(parsed.data.league)
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: result.error.message },
        { status: 503 },
      )
    }

    const { leagueId, upcoming, results, provenance } = result.value
    return NextResponse.json({
      league: leagueId,
      upcoming,
      results,
      provenance: {
        sourceId: provenance.sourceId,
        fetchedAt: new Date(provenance.fetchedAt).toISOString(),
        dataAsOf: new Date(provenance.dataAsOf).toISOString(),
        isDemo: provenance.isDemo,
      },
      counts: { upcoming: upcoming.length, results: results.length },
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
