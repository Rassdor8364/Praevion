/**
 * GET /api/news/entity?id=btc
 *
 * Story clusters mentioning one curated dictionary entity, importance-sorted.
 * An unknown id is a 404 with the honest reason (dictionary-based extraction
 * only knows its dictionary — see engines/news/entities.ts).
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getNewsOrchestrator } from '@/engines/news/orchestrator'
import { toClusterDto } from '../dto'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
})

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const parsed = querySchema.safeParse({
      id: request.nextUrl.searchParams.get('id') ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query', detail: 'id must be a lowercase dictionary entity id, e.g. btc' },
        { status: 400 },
      )
    }

    const result = await getNewsOrchestrator().getEntityNews(parsed.data.id)
    if (!result.ok) {
      const unknown = result.error.message.startsWith('Unknown entity')
      return NextResponse.json(
        { error: unknown ? 'Unknown entity' : 'Data unavailable', detail: result.error.message },
        { status: unknown ? 404 : 503 },
      )
    }

    const { entity, clusters, provenance, generatedAt } = result.value
    return NextResponse.json({
      entity: {
        id: entity.id,
        name: entity.name,
        type: entity.type,
        relatedAssets: entity.relatedAssets,
      },
      clusters: clusters.map(toClusterDto),
      counts: { clusters: clusters.length },
      provenance: {
        sourceId: provenance.sourceId,
        fetchedAt: new Date(provenance.fetchedAt).toISOString(),
        dataAsOf: new Date(provenance.dataAsOf).toISOString(),
        isDemo: provenance.isDemo,
      },
      generatedAt,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
