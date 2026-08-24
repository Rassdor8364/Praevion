/**
 * GET /api/crypto/[symbol]/predict
 *
 * Thin route: validates input, calls the orchestrator, maps the Result.
 * A failed prediction is a 503 with the real reason — NEVER a fabricated
 * fallback body (§19 no-fake-data guarantee).
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { ALL_CRYPTO_TIMEFRAMES, type Timeframe } from '@/core/prediction/types'
import { getIntelligenceEngine } from '@/engines/orchestrator'

export const dynamic = 'force-dynamic'

const paramsSchema = z.object({
  symbol: z
    .string()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{5,20}$/, 'symbol must be 5–20 alphanumerics, e.g. BTCUSDT')),
})

const timeframeSchema = z.enum(
  ALL_CRYPTO_TIMEFRAMES as readonly [Timeframe, ...Timeframe[]],
)

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ symbol: string }> },
): Promise<NextResponse> {
  try {
    const parsedParams = paramsSchema.safeParse(await context.params)
    if (!parsedParams.success) {
      return NextResponse.json(
        { error: 'Invalid symbol', detail: parsedParams.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      )
    }

    // Optional ?timeframes=24h,7d — defaults to all.
    const tfRaw = request.nextUrl.searchParams.get('timeframes')
    let timeframes: readonly Timeframe[] | undefined
    if (tfRaw !== null) {
      const parsedTfs = z.array(timeframeSchema).min(1).safeParse(tfRaw.split(','))
      if (!parsedTfs.success) {
        return NextResponse.json(
          { error: 'Invalid timeframes', detail: `expected comma-separated subset of ${ALL_CRYPTO_TIMEFRAMES.join(',')}` },
          { status: 400 },
        )
      }
      timeframes = parsedTfs.data
    }

    const result = await getIntelligenceEngine().predictCryptoAllTimeframes(
      parsedParams.data.symbol,
      timeframes,
    )

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
