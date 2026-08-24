/**
 * Prediction-market repository.
 *
 * Persists the universal market objects from src/core/markets/types.ts —
 * PredictionMarket, MarketOutcome, VixeraOpportunity, MarketDislocation — into
 * the 0008_prediction_markets tables. Nothing above `db/` constructs a Supabase
 * query against these tables directly.
 *
 * Write-path conventions, matching predictions.ts:
 *   - Every function returns `Result<T, Error>` and never throws. A database
 *     being unavailable is a routine condition, not an exception.
 *   - Every write is an upsert on the table's natural key, so a retried or
 *     double-fired ingestion job converges instead of duplicating.
 *   - The price series is APPEND-ONLY: `recordPrices` has no update or delete
 *     counterpart, because a probability-history chart that can be rewritten
 *     is not a history.
 */

import type { Result } from '@/core/result'
import { ok, err } from '@/core/result'
import type {
  MarketCategory,
  MarketDislocation,
  MarketStatus,
  OpportunitySort,
  PredictionMarket,
  VixeraOpportunity,
} from '@/core/markets/types'

import {
  createServiceClient,
  DB_UNAVAILABLE_MESSAGE,
  type VixeraSupabaseClient,
} from '../client'
import type {
  LiquidityDetailJson,
  MarketLinkInsert,
  MarketLinkMethod,
  OpportunityAction,
  OpportunityRow,
  PredictionMarketOutcomeInsert,
  PredictionMarketOutcomeRow,
  PredictionMarketPriceInsert,
  PredictionMarketRow,
} from '../types'

// ---------------------------------------------------------------------------
// Shared plumbing (same shape as predictions.ts, whose RepositoryOptions is
// reused so every repository takes the same options object)
// ---------------------------------------------------------------------------

import type { RepositoryOptions } from './predictions'

export type { RepositoryOptions } from './predictions'

function resolveClient(options?: RepositoryOptions): Result<VixeraSupabaseClient, Error> {
  const client = options?.client ?? createServiceClient()
  if (client === null) return err(new Error(DB_UNAVAILABLE_MESSAGE))
  return ok(client)
}

function toError(cause: unknown, context: string): Error {
  if (cause instanceof Error) return new Error(`${context}: ${cause.message}`, { cause })
  return new Error(`${context}: ${String(cause)}`)
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Rebuild a PredictionMarket from its row plus its outcome rows. */
function rowToMarket(
  row: PredictionMarketRow,
  outcomes: readonly PredictionMarketOutcomeRow[],
): PredictionMarket {
  return {
    // The canonical Vixera id is derived from the unique key, never stored.
    id: `${row.provider}:${row.external_id}`,
    provider: row.provider,
    externalId: row.external_id,
    ticker: row.ticker,
    title: row.title,
    description: row.description,
    category: row.category,
    outcomes: outcomes.map((o) => ({
      id: o.external_outcome_id,
      name: o.name,
      marketProbability: o.market_probability,
      bid: o.bid,
      ask: o.ask,
    })),
    volume: row.volume,
    volume24h: row.volume_24h,
    liquidity: row.liquidity,
    openInterest: row.open_interest,
    spread: row.spread,
    closeTime: row.close_time,
    resolutionTime: row.resolution_time,
    resolutionRules: row.resolution_rules,
    url: row.url,
    status: row.status,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// upsertMarket
// ---------------------------------------------------------------------------

export interface UpsertMarketResult {
  readonly market: PredictionMarketRow
  readonly outcomes: PredictionMarketOutcomeRow[]
}

/**
 * Persist a market and its outcomes.
 *
 * Idempotent on `(provider, external_id)` for the market and
 * `(market_id, external_outcome_id)` for each outcome — re-polling a venue is
 * a no-op update, never a duplicate. The returned outcome rows carry the
 * database uuids that `recordPrices` and `saveOpportunity` need.
 */
export async function upsertMarket(
  m: PredictionMarket,
  options?: RepositoryOptions,
): Promise<Result<UpsertMarketResult, Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  try {
    const { data: market, error } = await client
      .from('prediction_markets')
      .upsert(
        {
          provider: m.provider,
          external_id: m.externalId,
          ticker: m.ticker,
          title: m.title,
          description: m.description,
          category: m.category,
          status: m.status,
          volume: m.volume,
          volume_24h: m.volume24h,
          liquidity: m.liquidity,
          open_interest: m.openInterest,
          spread: m.spread,
          close_time: m.closeTime,
          resolution_time: m.resolutionTime,
          resolution_rules: m.resolutionRules,
          url: m.url,
          updated_at: m.updatedAt,
        },
        { onConflict: 'provider,external_id' },
      )
      .select('*')
      .single()

    if (error !== null) return err(toError(error, 'upsertMarket'))
    if (market === null) return err(new Error('upsertMarket: upsert returned no row'))

    const row: PredictionMarketRow = market

    if (m.outcomes.length === 0) return ok({ market: row, outcomes: [] })

    const outcomeInserts: PredictionMarketOutcomeInsert[] = m.outcomes.map((o) => ({
      market_id: row.id,
      external_outcome_id: o.id,
      name: o.name,
      market_probability: o.marketProbability,
      bid: o.bid,
      ask: o.ask,
    }))

    const { data: outcomes, error: outcomeError } = await client
      .from('prediction_market_outcomes')
      .upsert(outcomeInserts, { onConflict: 'market_id,external_outcome_id' })
      .select('*')

    if (outcomeError !== null) return err(toError(outcomeError, 'upsertMarket(outcomes)'))

    return ok({ market: row, outcomes: outcomes ?? [] })
  } catch (cause) {
    return err(toError(cause, 'upsertMarket'))
  }
}

// ---------------------------------------------------------------------------
// recordPrices
// ---------------------------------------------------------------------------

export interface MarketPricePoint {
  /** prediction_markets.id (database uuid, from upsertMarket). */
  readonly marketId: string
  /** prediction_market_outcomes.id (database uuid, from upsertMarket). */
  readonly outcomeId: string
  readonly probability: number
  readonly bid?: number | null
  readonly ask?: number | null
  readonly volume?: number | null
  /** ISO instant of the observation. Part of the natural key. */
  readonly ts: string
}

/**
 * Append points to the outcome-probability time-series.
 *
 * Idempotent on `(outcome_id, ts)`: a re-polled snapshot for the same instant
 * collapses onto the existing row instead of duplicating the chart point.
 * Append-only — there is deliberately no update or delete counterpart.
 */
export async function recordPrices(
  points: MarketPricePoint | readonly MarketPricePoint[],
  options?: RepositoryOptions,
): Promise<Result<number, Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  const list = Array.isArray(points) ? points : [points as MarketPricePoint]
  if (list.length === 0) return ok(0)

  const rows: PredictionMarketPriceInsert[] = list.map((point) => ({
    market_id: point.marketId,
    outcome_id: point.outcomeId,
    probability: point.probability,
    bid: point.bid ?? null,
    ask: point.ask ?? null,
    volume: point.volume ?? null,
    ts: point.ts,
  }))

  try {
    const { error } = await client
      .from('prediction_market_prices')
      .upsert(rows, { onConflict: 'outcome_id,ts', ignoreDuplicates: true })

    if (error !== null) return err(toError(error, 'recordPrices'))
    return ok(rows.length)
  } catch (cause) {
    return err(toError(cause, 'recordPrices'))
  }
}

// ---------------------------------------------------------------------------
// listMarkets
// ---------------------------------------------------------------------------

export interface MarketFilters {
  readonly provider?: string
  readonly category?: MarketCategory
  readonly status?: MarketStatus
  readonly limit?: number
}

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 500

/**
 * List market rows (without outcomes — list screens show the headline quote,
 * and the per-outcome detail is one `getMarket` away).
 */
export async function listMarkets(
  filters: MarketFilters = {},
  options?: RepositoryOptions,
): Promise<Result<PredictionMarketRow[], Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)

  try {
    let query = client.from('prediction_markets').select('*')

    if (filters.provider !== undefined) query = query.eq('provider', filters.provider)
    if (filters.category !== undefined) query = query.eq('category', filters.category)
    if (filters.status !== undefined) query = query.eq('status', filters.status)

    const { data, error } = await query
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (error !== null) return err(toError(error, 'listMarkets'))
    return ok(data ?? [])
  } catch (cause) {
    return err(toError(cause, 'listMarkets'))
  }
}

// ---------------------------------------------------------------------------
// getMarket
// ---------------------------------------------------------------------------

/**
 * One market, fully hydrated with its outcomes.
 *
 * Accepts either the canonical Vixera id (`${provider}:${externalId}`) or the
 * database uuid. Returns `ok(null)` — not an error — when the market is
 * unknown: "not ingested yet" is a legitimate state the UI renders, not a
 * failure.
 */
export async function getMarket(
  id: string,
  options?: RepositoryOptions,
): Promise<Result<PredictionMarket | null, Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  try {
    let query = client.from('prediction_markets').select('*')

    const separator = id.indexOf(':')
    if (separator > 0) {
      query = query
        .eq('provider', id.slice(0, separator))
        .eq('external_id', id.slice(separator + 1))
    } else {
      query = query.eq('id', id)
    }

    const { data, error } = await query.maybeSingle()

    if (error !== null) return err(toError(error, 'getMarket'))
    if (data === null) return ok(null)

    const row: PredictionMarketRow = data

    const { data: outcomes, error: outcomeError } = await client
      .from('prediction_market_outcomes')
      .select('*')
      .eq('market_id', row.id)
      .order('external_outcome_id', { ascending: true })

    if (outcomeError !== null) return err(toError(outcomeError, 'getMarket(outcomes)'))

    return ok(rowToMarket(row, outcomes ?? []))
  } catch (cause) {
    return err(toError(cause, 'getMarket'))
  }
}

// ---------------------------------------------------------------------------
// saveOpportunity
// ---------------------------------------------------------------------------

/**
 * Persist a scored opportunity.
 *
 * The embedded market (and its outcomes) are upserted first so the foreign
 * keys always resolve — the scanner's snapshot of the market is exactly as
 * fresh as the scores derived from it, so writing both together is correct,
 * not merely convenient.
 *
 * Idempotent on `(market_id, outcome_id, generated_at)`: a re-run of the
 * scanner over the same snapshot converges instead of duplicating the feed.
 */
export async function saveOpportunity(
  o: VixeraOpportunity,
  options?: RepositoryOptions,
): Promise<Result<OpportunityRow, Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  const marketResult = await upsertMarket(o.market, { client })
  if (!marketResult.ok) return marketResult

  const { market, outcomes } = marketResult.value
  const outcome = outcomes.find((row) => row.external_outcome_id === o.outcomeId)
  if (outcome === undefined) {
    return err(
      new Error(
        `saveOpportunity: outcome '${o.outcomeId}' is not among the market's outcomes [${o.market.outcomes
          .map((x) => x.id)
          .join(', ')}]`,
      ),
    )
  }

  const liquidityDetail: LiquidityDetailJson = {
    spreadPp: o.liquidity.spreadPp,
    depthScore: o.liquidity.depthScore,
    volumeScore: o.liquidity.volumeScore,
    notes: [...o.liquidity.notes],
  }

  try {
    const { data, error } = await client
      .from('opportunities')
      .upsert(
        {
          market_id: market.id,
          outcome_id: outcome.id,
          vixera_probability: o.vixeraProbability,
          market_probability: o.marketProbability,
          edge_pp: o.edgePp,
          expected_value: o.expectedValue,
          confidence: o.confidence,
          data_quality: o.dataQuality,
          model_agreement: o.modelAgreement,
          liquidity_score: o.liquidity.score,
          liquidity_grade: o.liquidity.grade,
          liquidity_detail: liquidityDetail,
          resolution_risk: o.resolutionRisk.level,
          resolution_risk_reasons: [...o.resolutionRisk.reasons],
          news_risk: o.newsRisk,
          hours_to_resolution: o.hoursToResolution,
          opportunity_score: o.opportunityScore,
          action: o.action,
          no_action_reasons: [...o.noActionReasons],
          score_breakdown: { ...o.scoreBreakdown },
          prediction_id: o.predictionId,
          data_mode: o.dataMode,
          generated_at: o.generatedAt,
        },
        { onConflict: 'market_id,outcome_id,generated_at' },
      )
      .select('*')
      .single()

    if (error !== null) return err(toError(error, 'saveOpportunity'))
    if (data === null) return err(new Error('saveOpportunity: upsert returned no row'))
    return ok(data)
  } catch (cause) {
    return err(toError(cause, 'saveOpportunity'))
  }
}

// ---------------------------------------------------------------------------
// listOpportunities
// ---------------------------------------------------------------------------

export interface OpportunityFilters {
  readonly action?: OpportunityAction
  readonly sort?: OpportunitySort
  readonly limit?: number
}

/**
 * List opportunity rows, ranked.
 *
 * `probability_change` cannot be sorted in a single-table read (it needs the
 * price series); it falls back to newest-first, which is the closest
 * single-column proxy, and the caller re-ranks in memory if it needs the
 * real thing.
 */
export async function listOpportunities(
  filters: OpportunityFilters = {},
  options?: RepositoryOptions,
): Promise<Result<OpportunityRow[], Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)

  try {
    let query = client.from('opportunities').select('*')

    if (filters.action !== undefined) query = query.eq('action', filters.action)

    switch (filters.sort ?? 'score') {
      case 'edge':
        query = query.order('edge_pp', { ascending: false })
        break
      case 'confidence':
        query = query.order('confidence', { ascending: false })
        break
      case 'liquidity':
        query = query.order('liquidity_score', { ascending: false })
        break
      case 'risk':
        // Enum declaration order is low -> medium -> high, so ascending is
        // safest-first; news_risk breaks ties in the same direction.
        query = query
          .order('resolution_risk', { ascending: true })
          .order('news_risk', { ascending: true })
        break
      case 'ending_soon':
        query = query.order('hours_to_resolution', { ascending: true, nullsFirst: false })
        break
      case 'newest':
      case 'probability_change':
        query = query.order('generated_at', { ascending: false })
        break
      case 'score':
      default:
        query = query.order('opportunity_score', { ascending: false })
        break
    }

    const { data, error } = await query.limit(limit)

    if (error !== null) return err(toError(error, 'listOpportunities'))
    return ok(data ?? [])
  } catch (cause) {
    return err(toError(cause, 'listOpportunities'))
  }
}

// ---------------------------------------------------------------------------
// linkMarkets
// ---------------------------------------------------------------------------

/**
 * Assert that a set of markets trade the same real-world event.
 *
 * Idempotent on `(event_key, market_id)`: re-running the linker refreshes
 * confidence/method on existing links rather than duplicating them. Links are
 * additive — this never unlinks a market that is absent from `marketIds`,
 * because an embedding pass going quiet on a pair is not evidence the pair
 * was wrong.
 */
export async function linkMarkets(
  eventKey: string,
  marketIds: readonly string[],
  method: MarketLinkMethod,
  confidence: number,
  options?: RepositoryOptions,
): Promise<Result<number, Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  if (marketIds.length === 0) return ok(0)
  if (confidence < 0 || confidence > 1) {
    return err(new Error(`linkMarkets: confidence ${confidence} is outside [0, 1]`))
  }

  const rows: MarketLinkInsert[] = marketIds.map((marketId) => ({
    event_key: eventKey,
    market_id: marketId,
    confidence,
    method,
  }))

  try {
    const { error } = await client
      .from('market_links')
      .upsert(rows, { onConflict: 'event_key,market_id' })

    if (error !== null) return err(toError(error, 'linkMarkets'))
    return ok(rows.length)
  } catch (cause) {
    return err(toError(cause, 'linkMarkets'))
  }
}

// ---------------------------------------------------------------------------
// getDislocations
// ---------------------------------------------------------------------------

const MAX_LINK_SCAN = 2000

/** Pick the quote-defining outcome of a market: the YES side where one exists,
 * otherwise the current leader. Cross-venue comparison needs one probability
 * per market, and the YES side is the only convention every binary venue
 * shares; multi-outcome markets fall back to the leader, which is honest as a
 * disagreement measure even if the leaders differ. */
function primaryOutcome(
  outcomes: readonly PredictionMarketOutcomeRow[],
): PredictionMarketOutcomeRow | null {
  let best: PredictionMarketOutcomeRow | null = null
  for (const o of outcomes) {
    if (o.external_outcome_id.toLowerCase() === 'yes' || o.name.toLowerCase() === 'yes') {
      return o
    }
    if (best === null || o.market_probability > best.market_probability) best = o
  }
  return best
}

/**
 * Cross-venue dislocations: linked events whose venues disagree by at least
 * `minSpreadPp` probability points (0.05 = 5pp).
 *
 * Disagreement between venues is itself a signal, and the largest Vixera edge
 * across the venues says WHERE the mispricing lives. `vixeraProbability` and
 * `largestEdge` come from the latest opportunity row per linked market and are
 * null when the scanner has not scored the event.
 */
export async function getDislocations(
  minSpreadPp: number,
  options?: RepositoryOptions,
): Promise<Result<MarketDislocation[], Error>> {
  const clientResult = resolveClient(options)
  if (!clientResult.ok) return clientResult
  const client = clientResult.value

  try {
    const { data: links, error: linkError } = await client
      .from('market_links')
      .select('*')
      .order('event_key', { ascending: true })
      .limit(MAX_LINK_SCAN)

    if (linkError !== null) return err(toError(linkError, 'getDislocations(links)'))

    const byEvent = new Map<string, string[]>()
    for (const link of links ?? []) {
      const ids = byEvent.get(link.event_key)
      if (ids === undefined) byEvent.set(link.event_key, [link.market_id])
      else ids.push(link.market_id)
    }

    // A dislocation needs at least two venues.
    const eventKeys = [...byEvent.entries()].filter(([, ids]) => ids.length >= 2)
    if (eventKeys.length === 0) return ok([])

    const marketIds = [...new Set(eventKeys.flatMap(([, ids]) => ids))]

    const [marketsResponse, outcomesResponse, opportunitiesResponse] = await Promise.all([
      client.from('prediction_markets').select('*').in('id', marketIds),
      client.from('prediction_market_outcomes').select('*').in('market_id', marketIds),
      client
        .from('opportunities')
        .select('*')
        .in('market_id', marketIds)
        .order('generated_at', { ascending: false })
        .limit(MAX_LIST_LIMIT),
    ])

    if (marketsResponse.error !== null) {
      return err(toError(marketsResponse.error, 'getDislocations(markets)'))
    }
    if (outcomesResponse.error !== null) {
      return err(toError(outcomesResponse.error, 'getDislocations(outcomes)'))
    }
    if (opportunitiesResponse.error !== null) {
      return err(toError(opportunitiesResponse.error, 'getDislocations(opportunities)'))
    }

    const marketsById = new Map<string, PredictionMarketRow>()
    for (const m of marketsResponse.data ?? []) marketsById.set(m.id, m)

    const outcomesByMarket = new Map<string, PredictionMarketOutcomeRow[]>()
    for (const o of outcomesResponse.data ?? []) {
      const list = outcomesByMarket.get(o.market_id)
      if (list === undefined) outcomesByMarket.set(o.market_id, [o])
      else list.push(o)
    }

    // Latest opportunity per market (the query is newest-first).
    const latestOpportunityByMarket = new Map<string, OpportunityRow>()
    for (const opp of opportunitiesResponse.data ?? []) {
      if (!latestOpportunityByMarket.has(opp.market_id)) {
        latestOpportunityByMarket.set(opp.market_id, opp)
      }
    }

    const dislocations: MarketDislocation[] = []

    for (const [eventKey, ids] of eventKeys) {
      const quotes: {
        provider: string
        marketId: string
        title: string
        outcomeName: string
        marketProbability: number
        liquidity: number | null
      }[] = []

      for (const marketId of ids) {
        const market = marketsById.get(marketId)
        if (market === undefined) continue
        const outcome = primaryOutcome(outcomesByMarket.get(marketId) ?? [])
        if (outcome === null) continue
        quotes.push({
          provider: market.provider,
          marketId: `${market.provider}:${market.external_id}`,
          title: market.title,
          outcomeName: outcome.name,
          marketProbability: outcome.market_probability,
          liquidity: market.liquidity,
        })
      }

      // Bind the first quote explicitly: under noUncheckedIndexedAccess the
      // length check above does not narrow `quotes[0]`, and a non-null
      // assertion would silence the compiler instead of convincing it.
      const firstQuote = quotes[0]
      if (firstQuote === undefined || quotes.length < 2) continue

      let minProbability = firstQuote.marketProbability
      let maxProbability = firstQuote.marketProbability
      for (const quote of quotes) {
        if (quote.marketProbability < minProbability) minProbability = quote.marketProbability
        if (quote.marketProbability > maxProbability) maxProbability = quote.marketProbability
      }
      const crossMarketSpreadPp = maxProbability - minProbability
      if (crossMarketSpreadPp < minSpreadPp) continue

      // Vixera's own view, where the scanner has one: the freshest opportunity
      // across the linked markets, and the venue where the edge is largest.
      let vixeraProbability: number | null = null
      let freshestGeneratedAt: string | null = null
      let largestEdge: { provider: string; edgePp: number } | null = null

      for (const marketId of ids) {
        const opp = latestOpportunityByMarket.get(marketId)
        if (opp === undefined) continue
        const market = marketsById.get(marketId)
        if (market === undefined) continue

        if (freshestGeneratedAt === null || opp.generated_at > freshestGeneratedAt) {
          freshestGeneratedAt = opp.generated_at
          vixeraProbability = opp.vixera_probability
        }
        if (largestEdge === null || Math.abs(opp.edge_pp) > Math.abs(largestEdge.edgePp)) {
          largestEdge = { provider: market.provider, edgePp: opp.edge_pp }
        }
      }

      dislocations.push({
        eventKey,
        eventTitle: firstQuote.title,
        quotes,
        crossMarketSpreadPp,
        vixeraProbability,
        largestEdge,
      })
    }

    // Largest disagreement first: that is the ranking the screen shows.
    dislocations.sort((a, b) => b.crossMarketSpreadPp - a.crossMarketSpreadPp)

    return ok(dislocations)
  } catch (cause) {
    return err(toError(cause, 'getDislocations'))
  }
}
