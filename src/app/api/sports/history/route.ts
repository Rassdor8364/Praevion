/**
 * GET /api/sports/history?limit=50
 *
 * The permanent prediction record: resolved predictions with the
 * probabilities persisted BEFORE kickoff and the verified final result, plus
 * open (locked, unresolved) predictions still awaiting their game. Nothing
 * is ever recomputed here — regenerating yesterday's prediction with today's
 * model and calling it history would be a fabricated accuracy record.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { isServiceRoleConfigured } from '@/db/client'
import { listPredictions, listResolvedPredictions } from '@/db/repositories'

export const dynamic = 'force-dynamic'

const limitSchema = z.coerce.number().int().min(1).max(200).default(50)

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const parsed = limitSchema.safeParse(request.nextUrl.searchParams.get('limit') ?? undefined)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query', detail: parsed.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      )
    }

    if (!isServiceRoleConfigured()) {
      return NextResponse.json({
        databaseConfigured: false,
        resolved: [],
        open: [],
        detail: 'Prediction history requires the database configuration (SUPABASE_SERVICE_ROLE_KEY).',
      })
    }

    const [resolved, open] = await Promise.all([
      listResolvedPredictions('sports', { limit: parsed.data }),
      listPredictions({ domain: 'sports', settled: false, limit: parsed.data }),
    ])

    if (!resolved.ok) {
      return NextResponse.json(
        { error: 'Data unavailable', detail: resolved.error.message },
        { status: 503 },
      )
    }

    return NextResponse.json({
      databaseConfigured: true,
      resolved: resolved.value,
      open: open.ok
        ? open.value.map((p) => ({
            id: p.id,
            subject: p.subject,
            subjectLabel: p.subject_label,
            generatedAt: p.generated_at,
            modelVersion: p.model_version,
            confidence: p.confidence,
            outcomes: p.outcomes,
          }))
        : [],
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Internal error', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
