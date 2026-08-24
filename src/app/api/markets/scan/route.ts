/**
 * GET /api/markets/scan?category=&limit=
 *
 * Runs the full opportunity scan. Logic lives in the orchestrator; this route
 * only validates and maps.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getIntelligenceEngine } from '@/engines/orchestrator'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  category: z
    .enum([
      'politics',
      'economics',
      'crypto',
      'sports',
      'weather',
      'entertainment',
      'science',
      'companies',
      'other',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const sp = request.nextUrl.searchParams
    const parsed = querySchema.safeParse({
      category: sp.get('category') ?? undefined,
      limit: sp.get('limit') ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        { status: 400 },
      )
    }

    const result = await getIntelligenceEngine().scanMarkets({
      category: parsed.data.category,
      limitPerVenue: parsed.data.limit,
    })

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
