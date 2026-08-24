/**
 * GET /api/sports/crest?team=eng.1:359
 *
 * Server-side crest relay. Crests are decoration, but hotlinking the
 * upstream CDN from the browser couples the UI to the client's network path
 * (ad blockers, corporate proxies, the CDN's own referrer rules). The server
 * already has a working egress path to the provider, so it fetches the crest
 * once and serves it cacheably from our own origin. Only URLs the provider
 * itself reported for the team are fetched — this is not an open proxy.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSportsOrchestrator } from '@/engines/sports/orchestrator'
import { ESPN_LEAGUES } from '@/providers/sports/espn'

export const dynamic = 'force-dynamic'

const teamSchema = z
  .string()
  .regex(/^[a-z0-9.]{2,24}:[A-Za-z0-9]{1,20}$/, "team must look like 'eng.1:359'")
  .refine((id) => id.slice(0, id.lastIndexOf(':')) in ESPN_LEAGUES, {
    message: 'unknown league prefix',
  })

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const parsed = teamSchema.safeParse(request.nextUrl.searchParams.get('team') ?? undefined)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query', detail: parsed.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      )
    }
    const teamId = parsed.data
    const leagueId = teamId.slice(0, teamId.lastIndexOf(':'))

    const teams = await getSportsOrchestrator().getTeams(leagueId)
    if (!teams.ok) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: teams.error.message },
        { status: 503 },
      )
    }
    const crestUrl = teams.value.get(teamId)?.crestUrl ?? null
    if (crestUrl === null) {
      return NextResponse.json({ error: 'Not found', detail: `no crest for ${teamId}` }, { status: 404 })
    }

    const upstream = await fetch(crestUrl, { signal: AbortSignal.timeout(8000) })
    if (!upstream.ok) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: `crest upstream answered ${upstream.status}` },
        { status: 502 },
      )
    }
    const body = await upstream.arrayBuffer()
    return new NextResponse(body, {
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'image/png',
        // Crests change on a timescale of rebrands; a day of caching is safe.
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
