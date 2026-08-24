/**
 * GET /api/sports/learning
 *
 * Live state of the self-learning loop: persistence counters, open and
 * settled prediction counts, the measured ensemble score, the adaptive
 * weights in force and the most recent resolved predictions. Null fields
 * mean "backing store not configured", and the UI says exactly that.
 */

import { NextResponse } from 'next/server'
import { getSportsOrchestrator } from '@/engines/sports/orchestrator'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  try {
    const status = await getSportsOrchestrator().getLearningStatus()
    return NextResponse.json(status)
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
