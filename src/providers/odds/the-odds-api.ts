/**
 * The Odds API (the-odds-api.com) — sportsbook odds adapter.
 *
 * A real aggregator of real bookmaker prices, keyed (free tier: 500
 * requests/month). The provider is registered ONLY when ODDS_API_KEY is
 * present; without it the 'sports.odds' capability simply has no chain and
 * every consumer renders "Sportsbook odds unavailable" — a fake bookmaker
 * price is the one thing this file must never produce, because everything
 * downstream (no-vig probabilities, edge, EV) would inherit the fabrication
 * and dress it in analytical clothing.
 *
 * Request budget: one request returns ALL upcoming events for a league with
 * every bookmaker's h2h and totals prices, so the orchestrator caches per
 * league and the free tier comfortably covers a polling cadence of one
 * fetch per league per ~15 minutes.
 */

import { z } from 'zod'
import { err, ok } from '@/core/result'
import { fetchJson } from '../http'
import { ProviderError } from '@/core/errors'
import type {
  Capability,
  GameOdds,
  OddsProvider,
  ProviderHealth,
  ProviderResult,
} from '../types'

/** ESPN league id → The Odds API sport key. */
export const ODDS_API_SPORT_KEYS: Readonly<Record<string, string>> = {
  'eng.1': 'soccer_epl',
  'esp.1': 'soccer_spain_la_liga',
  'ger.1': 'soccer_germany_bundesliga',
  'ita.1': 'soccer_italy_serie_a',
  'fra.1': 'soccer_france_ligue_one',
  'usa.1': 'soccer_usa_mls',
  'uefa.champions': 'soccer_uefa_champs_league',
}

const outcomeSchema = z.object({
  name: z.string(),
  price: z.number().positive(),
  point: z.number().optional(),
})

const marketSchema = z.object({
  key: z.string(),
  last_update: z.string().optional(),
  outcomes: z.array(outcomeSchema),
})

const bookmakerSchema = z.object({
  key: z.string(),
  title: z.string(),
  last_update: z.string().optional(),
  markets: z.array(marketSchema),
})

const eventSchema = z.object({
  id: z.string(),
  commence_time: z.string(),
  home_team: z.string(),
  away_team: z.string(),
  bookmakers: z.array(bookmakerSchema),
})

const responseSchema = z.array(eventSchema)

const BASE_URL = 'https://api.the-odds-api.com/v4'

export class TheOddsApiProvider implements OddsProvider {
  readonly id = 'the-odds-api'
  readonly displayName = 'The Odds API'
  readonly reliability = 'SECONDARY' as const
  readonly isDemo = false
  readonly capabilities: readonly Capability[] = ['sports.odds']

  private apiKey(): string | null {
    const key = process.env['ODDS_API_KEY']
    return key !== undefined && key.length > 0 ? key : null
  }

  isConfigured(): boolean {
    return this.apiKey() !== null
  }

  async health(): Promise<ProviderHealth> {
    if (!this.isConfigured()) {
      return { healthy: false, latencyMs: null, message: 'ODDS_API_KEY not configured' }
    }
    const started = Date.now()
    const result = await fetchJson({
      providerId: this.id,
      url: `${BASE_URL}/sports/?apiKey=${this.apiKey()}`,
      schema: z.array(z.object({ key: z.string() })),
      timeoutMs: 8_000,
      retries: 0,
    })
    return result.ok
      ? { healthy: true, latencyMs: Date.now() - started, message: null }
      : { healthy: false, latencyMs: Date.now() - started, message: result.error.message }
  }

  async getOdds(params: { competitionId: string }): Promise<ProviderResult<GameOdds[]>> {
    const key = this.apiKey()
    if (key === null) {
      return err(
        new ProviderError({
          kind: 'unauthorized',
          providerId: this.id,
          message: 'ODDS_API_KEY not configured',
        }),
      )
    }

    const sportKey = ODDS_API_SPORT_KEYS[params.competitionId]
    if (sportKey === undefined) {
      return err(
        new ProviderError({
          kind: 'unsupported_capability',
          providerId: this.id,
          message: `No odds sport key mapped for competition '${params.competitionId}'`,
        }),
      )
    }

    const fetchedAt = Date.now()
    const result = await fetchJson({
      providerId: this.id,
      url: `${BASE_URL}/sports/${sportKey}/odds/?apiKey=${key}&regions=eu&markets=h2h,totals&oddsFormat=decimal`,
      schema: responseSchema,
      timeoutMs: 12_000,
      retries: 1,
      // The free tier is request-budgeted; the odds engine caches upstream,
      // and a stale-by-minutes price is fine for an ANALYTICAL comparison
      // (the UI shows the collected-at timestamp either way).
      revalidateSeconds: 0,
    })
    if (!result.ok) return err(result.error)

    let newest = 0
    const data: GameOdds[] = result.value.map((event) => {
      const markets = event.bookmakers.flatMap((book) =>
        book.markets
          .filter((m): m is typeof m & { key: 'h2h' | 'totals' } => m.key === 'h2h' || m.key === 'totals')
          .map((m) => {
            const lastUpdate = Date.parse(m.last_update ?? book.last_update ?? event.commence_time)
            if (lastUpdate > newest) newest = lastUpdate
            return {
              bookmaker: book.title,
              marketKey: m.key,
              outcomes: m.outcomes.map((o) => ({
                name: o.name,
                decimalOdds: o.price,
                point: o.point ?? null,
              })),
              lastUpdate,
            }
          }),
      )
      return {
        externalId: event.id,
        homeTeamName: event.home_team,
        awayTeamName: event.away_team,
        kickoff: Date.parse(event.commence_time),
        markets,
      }
    })

    return ok({
      data,
      provenance: {
        sourceId: this.id,
        fetchedAt,
        dataAsOf: newest > 0 ? newest : fetchedAt,
        isDemo: false,
      },
    })
  }
}
