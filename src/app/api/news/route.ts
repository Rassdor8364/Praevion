/**
 * GET /api/news?category=crypto&limit=30
 *
 * The news board: importance-sorted story clusters (breaking first), with
 * per-category counts. Thin route: validates input, calls the news
 * orchestrator, maps the Result. A provider-chain failure is a 503 with the
 * real reason — never a fabricated cluster list (§19 no-fake-data guarantee).
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { BOARD_CATEGORIES, getNewsOrchestrator } from '@/engines/news/orchestrator'
import { toClusterDto } from './dto'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  category: z.enum(BOARD_CATEGORIES as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
})

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const parsed = querySchema.safeParse({
      category: request.nextUrl.searchParams.get('category') ?? undefined,
      limit: request.nextUrl.searchParams.get('limit') ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid query',
          detail: `category must be one of ${BOARD_CATEGORIES.join(', ')}; limit 1-100`,
        },
        { status: 400 },
      )
    }

    const result = await getNewsOrchestrator().getNewsBoard()
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: result.error.message },
        { status: 503 },
      )
    }

    const board = result.value
    const category = parsed.data.category
    const filtered =
      category === undefined ? board.clusters : board.clusters.filter((c) => c.category === category)
    const clusters = filtered.slice(0, parsed.data.limit).map(toClusterDto)

    return NextResponse.json({
      clusters,
      categoryCounts: board.categoryCounts,
      counts: { clusters: filtered.length, returned: clusters.length, articles: board.articleCount },
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
