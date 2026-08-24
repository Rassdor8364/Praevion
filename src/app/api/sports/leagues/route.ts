/**
 * GET /api/sports/leagues
 *
 * The football leagues the sports stack serves. A compile-time allowlist
 * (each ESPN league is a path segment known in advance), so this is static —
 * but stays force-dynamic for envelope consistency with the other sports
 * routes and to avoid a stale build artifact if the allowlist changes.
 */

import { NextResponse } from 'next/server'
import { ESPN_LEAGUES } from '@/providers/sports/espn'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const leagues = Object.entries(ESPN_LEAGUES).map(([id, meta]) => ({
    id,
    name: meta.name,
    country: meta.country,
  }))
  return NextResponse.json({ leagues, count: leagues.length })
}
