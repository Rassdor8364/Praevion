/**
 * GET /api/markets?venue=&limit=&category=
 *
 * Lists open markets from the venue providers. Each venue is independent —
 * one venue failing degrades the response (reported in `failures`) rather
 * than failing it, unless every venue fails.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { PredictionMarket } from '@/core/markets/types'
import { getMarketProviders, getRegistry } from '@/providers'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  venue: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
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
})

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const sp = request.nextUrl.searchParams
    const parsed = querySchema.safeParse({
      venue: sp.get('venue') ?? undefined,
      limit: sp.get('limit') ?? undefined,
      category: sp.get('category') ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        { status: 400 },
      )
    }

    const providers = getMarketProviders(getRegistry()).filter(
      (p) => parsed.data.venue === undefined || p.id === parsed.data.venue,
    )
    if (providers.length === 0) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: `No prediction-market provider matches venue "${parsed.data.venue ?? '*'}"` },
        { status: 503 },
      )
    }

    const markets: PredictionMarket[] = []
    const failures: string[] = []
    await Promise.all(
      providers.map(async (p) => {
        const r = await p.getMarkets({
          limit: parsed.data.limit ?? 50,
          category: parsed.data.category,
        })
        if (r.ok) markets.push(...r.value.data.markets)
        else failures.push(`${p.id}: ${r.error.message}`)
      }),
    )

    if (markets.length === 0 && failures.length > 0) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: failures.join('; ') },
        { status: 503 },
      )
    }

    return NextResponse.json({ markets, failures, count: markets.length })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
