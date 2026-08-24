/**
 * GET /api/sports/compare?league=eng.1&home=eng.1:359&away=eng.1:360
 *
 * Side-by-side Vixera Team Strength (venue-aware), form and Elo for two
 * teams, plus a hypothetical predictMatch at the home side's venue as of
 * now. Thin route — all logic lives in the sports orchestrator.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSportsOrchestrator } from '@/engines/sports/orchestrator'
import { ESPN_LEAGUES } from '@/providers/sports/espn'

export const dynamic = 'force-dynamic'

const teamIdSchema = z.string().regex(/^[a-z0-9.]{2,24}:[A-Za-z0-9]{1,20}$/, "team ids look like 'eng.1:359'")

const querySchema = z
  .object({
    league: z.enum(Object.keys(ESPN_LEAGUES) as [string, ...string[]]),
    home: teamIdSchema,
    away: teamIdSchema,
  })
  .refine((q) => q.home !== q.away, { message: 'home and away must differ' })

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const sp = request.nextUrl.searchParams
    const parsed = querySchema.safeParse({
      league: sp.get('league') ?? undefined,
      home: sp.get('home') ?? undefined,
      away: sp.get('away') ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid query',
          detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
        { status: 400 },
      )
    }

    const result = await getSportsOrchestrator().compareTeams(
      parsed.data.league,
      parsed.data.home,
      parsed.data.away,
    )
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: result.error.message },
        { status: 503 },
      )
    }

    const value = result.value
    return NextResponse.json({
      league: value.leagueId,
      home: value.home,
      away: value.away,
      hypothetical: value.hypothetical,
      provenance: {
        sourceId: value.provenance.sourceId,
        fetchedAt: new Date(value.provenance.fetchedAt).toISOString(),
        dataAsOf: new Date(value.provenance.dataAsOf).toISOString(),
        isDemo: value.provenance.isDemo,
      },
      generatedAt: value.generatedAt,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
