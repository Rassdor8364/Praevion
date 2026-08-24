/**
 * GET /api/news/breaking
 *
 * Only the clusters whose BREAKING status was earned by reporting velocity
 * (independent sources per hour on a young, corroborated cluster) — never by
 * the word "BREAKING" in a headline. An empty array is the normal state and
 * is returned as such: no news is not an error.
 */

import { NextResponse } from 'next/server'
import { getNewsOrchestrator } from '@/engines/news/orchestrator'
import { toClusterDto } from '../dto'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  try {
    const result = await getNewsOrchestrator().getNewsBoard()
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: result.error.message },
        { status: 503 },
      )
    }

    const board = result.value
    return NextResponse.json({
      breaking: board.breaking.map(toClusterDto),
      counts: { breaking: board.breaking.length },
      provenance: {
        sourceId: board.provenance.sourceId,
        fetchedAt: new Date(board.provenance.fetchedAt).toISOString(),
        dataAsOf: new Date(board.provenance.dataAsOf).toISOString(),
        isDemo: board.provenance.isDemo,
      },
      generatedAt: board.generatedAt,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
