/**
 * GET /api/sports/predict?game=eng.1:401879301
 *
 * The full match prediction: the universal VixeraPrediction plus the engine
 * extras that only exist for football (Dixon–Coles O/U 2.5 and BTTS, fair
 * decimal odds per outcome, and the §57 strength comparison). Thin route —
 * all logic lives in the sports orchestrator.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSportsOrchestrator } from '@/engines/sports/orchestrator'
import { ESPN_LEAGUES } from '@/providers/sports/espn'

export const dynamic = 'force-dynamic'

const gameSchema = z
  .string()
  .regex(/^[a-z0-9.]{2,24}:[A-Za-z0-9]{1,20}$/, "game must look like 'eng.1:401879301'")
  .refine((id) => id.slice(0, id.lastIndexOf(':')) in ESPN_LEAGUES, {
    message: `league prefix must be one of ${Object.keys(ESPN_LEAGUES).join(', ')}`,
  })

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const parsed = gameSchema.safeParse(request.nextUrl.searchParams.get('game') ?? undefined)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query', detail: parsed.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      )
    }

    const result = await getSportsOrchestrator().predictGame(parsed.data)
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: result.error.message },
        { status: 503 },
      )
    }

    const value = result.value
    return NextResponse.json({
      game: value.game,
      prediction: value.prediction,
      markets: value.markets,
      betMarkets: value.betMarkets,
      lambdas: value.lambdas,
      fairOdds: value.fairOdds,
      comparison: value.comparison,
      confidenceBreakdown: value.confidenceBreakdown,
      learnedTrainingSamples: value.learnedTrainingSamples,
      adaptiveWeights: value.adaptiveWeights,
      marketOdds: value.marketOdds,
      earlySeason: value.earlySeason,
      currentSeasonFinishedGames: value.currentSeasonFinishedGames,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
