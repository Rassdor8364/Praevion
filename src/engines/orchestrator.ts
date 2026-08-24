/**
 * VixeraIntelligenceEngine — the central orchestrator.
 *
 * This is the only layer that touches providers, engines AND the database. Its
 * job, per IMPLEMENTATION_PLAN.md §75 and the product brief §69:
 *
 *   collect data → validate freshness → build features → run models →
 *   combine → calibrate → score data quality & confidence →
 *   compute edge / liquidity / risk / opportunity → persist → explain
 *
 * Route handlers call this service; they contain no logic of their own.
 * Engines stay pure; every impure concern (network, clock, ids, persistence)
 * lives here and is injected downward.
 */

import { randomUUID } from 'node:crypto'
import { systemClock, type Clock, HOUR_MS, MINUTE_MS, DAY_MS } from '@/core/clock'
import { err, ok, type Result } from '@/core/result'
import type {
  MarketCategory,
  PredictionMarket,
  VixeraOpportunity,
} from '@/core/markets/types'
import type { Timeframe, VixeraPrediction, SourceRef } from '@/core/prediction/types'
import { computeDataQuality, type DatasetQuality } from '@/core/quality/data-quality'
import { TIMEFRAME_SPECS, buildCryptoFeatures } from '@/engines/crypto/features'
import { predictCrypto } from '@/engines/crypto/predict'
import { evaluateOpportunity } from '@/engines/markets/opportunity'
import {
  parseCryptoThreshold,
  rangeProbability,
  thresholdFromDerived,
  thresholdProbability,
} from '@/engines/markets/event-models/crypto-threshold'
import { annualise, ewmaVolatility, logReturns } from '@/engines/crypto/volatility'
import { getRegistry, getMarketProviders } from '@/providers'
import type { ProviderRegistry } from '@/providers/registry'
import type {
  Candle,
  CandleInterval,
  DerivativesData,
  MarketData,
  OrderBook,
} from '@/providers/types'
import type { PredictionMarketProvider } from '@/providers/markets/types'

// ---------------------------------------------------------------------------
// Freshness policy: how old each dataset may be before it degrades quality.
// These feed DatasetQuality.maxAgeMs and, through it, the data-quality score.
// ---------------------------------------------------------------------------

const MAX_AGE: Record<string, number> = {
  'crypto.candles.15m': 20 * MINUTE_MS,
  'crypto.candles.1h': 75 * MINUTE_MS,
  'crypto.candles.4h': 5 * HOUR_MS,
  'crypto.candles.1d': 26 * HOUR_MS,
  'crypto.orderbook': 2 * MINUTE_MS,
  'crypto.market': 5 * MINUTE_MS,
  'crypto.derivatives': 15 * MINUTE_MS,
  'markets.list': 10 * MINUTE_MS,
}

export interface CryptoPredictionBundle {
  readonly symbol: string
  readonly predictions: Partial<Record<Timeframe, VixeraPrediction>>
  readonly market: MarketData | null
  readonly failures: readonly string[]
}

export interface MarketScanReport {
  readonly scanned: number
  readonly covered: number
  readonly opportunities: readonly VixeraOpportunity[]
  readonly noCoverage: number
  readonly failures: readonly string[]
  readonly generatedAt: string
}

export class VixeraIntelligenceEngine {
  private readonly registry: ProviderRegistry
  private readonly clock: Clock

  constructor(deps?: { registry?: ProviderRegistry; clock?: Clock }) {
    this.registry = deps?.registry ?? getRegistry()
    this.clock = deps?.clock ?? systemClock
  }

  // -------------------------------------------------------------------------
  // Crypto
  // -------------------------------------------------------------------------

  /**
   * Full multi-timeframe crypto prediction for one symbol.
   *
   * Each timeframe is an independent prediction with its own feature window —
   * they are never blended, and disagreement between horizons is shown, not
   * hidden (§14 of the original brief).
   */
  async predictCryptoAllTimeframes(
    symbol: string,
    timeframes?: readonly Timeframe[],
  ): Promise<Result<CryptoPredictionBundle, Error>> {
    const wanted = timeframes ?? (Object.keys(TIMEFRAME_SPECS) as Timeframe[])
    const failures: string[] = []

    // Which candle intervals do the requested timeframes need?
    const intervals = new Set<CandleInterval>()
    for (const tf of wanted) {
      const spec = TIMEFRAME_SPECS[tf]
      if (spec) intervals.add(spec.interval)
    }

    // ---- Gather. Every fetch is independent; a failure degrades quality
    // ---- rather than aborting the run.
    const candlesByInterval: Partial<Record<CandleInterval, readonly Candle[]>> = {}
    const datasets: DatasetQuality[] = []
    const sources: SourceRef[] = []
    let anyDemo = false

    await Promise.all(
      [...intervals].map(async (interval) => {
        const fetched = await this.registry.resolve('crypto.candles', (p) =>
          (p as import('@/providers/types').CryptoProvider).getCandles(symbol, interval, 300),
        )
        if (fetched.result.ok) {
          const { data, provenance } = fetched.result.value
          candlesByInterval[interval] = data
          anyDemo = anyDemo || provenance.isDemo
          const capability = `crypto.candles.${interval}`
          datasets.push({
            capability,
            dataAsOf: new Date(provenance.dataAsOf).toISOString(),
            maxAgeMs: MAX_AGE[capability] ?? HOUR_MS,
            completeness: data.length / 300,
            sourceCount: 1,
            reliability: 'PRIMARY_SOURCE',
            disagreement: null,
            isDemo: provenance.isDemo,
          })
          sources.push({
            providerId: provenance.sourceId,
            capability,
            reliability: 'PRIMARY_SOURCE',
            fetchedAt: new Date(provenance.fetchedAt).toISOString(),
            dataAsOf: new Date(provenance.dataAsOf).toISOString(),
            isDemo: provenance.isDemo,
          })
        } else {
          failures.push(`candles:${interval}: ${fetched.result.error.message}`)
        }
      }),
    )

    const [bookR, marketR, derivR] = await Promise.all([
      this.registry.resolve('crypto.orderbook', (p) =>
        (p as import('@/providers/types').CryptoProvider).getOrderBook(symbol, 100),
      ),
      this.registry.resolve('crypto.market', (p) =>
        (p as import('@/providers/types').CryptoProvider).getMarketData(symbol),
      ),
      this.registry.has('crypto.derivatives')
        ? this.registry.resolve('crypto.derivatives', (p) => {
            const provider = p as import('@/providers/types').CryptoProvider
            return provider.getDerivatives
              ? provider.getDerivatives(symbol)
              : Promise.reject(new Error('no derivatives support'))
          })
        : Promise.resolve(null),
    ])

    const book = this.absorb<OrderBook>('crypto.orderbook', bookR, datasets, sources, failures)
    const market = this.absorb<MarketData>('crypto.market', marketR, datasets, sources, failures)
    const derivatives = derivR
      ? this.absorb<DerivativesData>('crypto.derivatives', derivR, datasets, sources, failures)
      : null
    anyDemo = anyDemo || sources.some((s) => s.isDemo)

    if (Object.keys(candlesByInterval).length === 0) {
      return err(new Error(`No candle data available for ${symbol}: ${failures.join('; ')}`))
    }

    // ---- Predict each requested timeframe.
    const predictions: Partial<Record<Timeframe, VixeraPrediction>> = {}
    for (const timeframe of wanted) {
      const spec = TIMEFRAME_SPECS[timeframe]
      if (!spec) continue
      const candles = candlesByInterval[spec.interval]
      if (!candles) continue

      const features = buildCryptoFeatures({
        candles,
        book,
        derivatives,
        market,
        timeframe,
        nowMs: this.clock.now(),
      })

      predictions[timeframe] = predictCrypto({
        symbol,
        features,
        // Model skills come from model_metrics once enough history has been
        // settled; null → prior weight. No fabricated skill on day one.
        skills: [],
        datasets,
        sources,
        timeframe,
        clock: this.clock,
        predictionIdFactory: () => randomUUID(),
        calibrator: null, // fitted once ≥ MIN_CALIBRATION_SAMPLES outcomes exist
      })
    }

    return ok({ symbol, predictions, market, failures })
  }

  // -------------------------------------------------------------------------
  // Prediction markets
  // -------------------------------------------------------------------------

  /**
   * Scan all live prediction-market venues, compute Vixera fair probabilities
   * where a domain model covers the market, and score opportunities.
   *
   * Coverage honesty: a market with no covering model produces NO opportunity
   * and is counted in `noCoverage`. Vixera does not invent a probability for
   * an event it has no model for — an edge computed from a made-up number
   * would be the exact failure mode this product exists to avoid.
   */
  async scanMarkets(params?: {
    limitPerVenue?: number
    category?: MarketCategory
  }): Promise<Result<MarketScanReport, Error>> {
    const limit = params?.limitPerVenue ?? 100
    const venues = getMarketProviders(this.registry)
    if (venues.length === 0) return err(new Error('No prediction-market providers available'))

    const failures: string[] = []
    const markets: PredictionMarket[] = []

    await Promise.all(
      venues.map(async (venue) => {
        const r = await venue.getMarkets({ limit, category: params?.category })
        if (r.ok) markets.push(...r.value.data.markets)
        else failures.push(`${venue.id}: ${r.error.message}`)
      }),
    )

    // Volatility inputs are shared across every threshold market on the same
    // symbol — fetch once per symbol, not once per market.
    const volCache = new Map<string, { spot: number; annualVol: number } | null>()

    const opportunities: VixeraOpportunity[] = []
    let covered = 0
    let noCoverage = 0

    for (const market of markets) {
      const evaluated = await this.evaluateMarket(market, volCache)
      if (evaluated === null) {
        noCoverage++
        continue
      }
      covered++
      opportunities.push(evaluated)
    }

    opportunities.sort((a, b) => b.opportunityScore - a.opportunityScore)

    return ok({
      scanned: markets.length,
      covered,
      opportunities,
      noCoverage,
      failures,
      generatedAt: new Date(this.clock.now()).toISOString(),
    })
  }

  /**
   * Evaluate a single market against Vixera's covering models.
   * Returns null when no model covers the event — never a guessed probability.
   *
   * Current coverage: crypto threshold markets via the driftless-lognormal
   * digital model — from venue-structured strikes (Kalshi floor/cap, incl.
   * range markets) where available, else from title parsing ("Will BTC exceed
   * $X by …"). Sports, macro and politics models attach here as they come
   * online, each behind the same shape.
   */
  async evaluateMarket(
    market: PredictionMarket,
    volCache?: Map<string, { spot: number; annualVol: number } | null>,
  ): Promise<VixeraOpportunity | null> {
    // STRUCTURED coverage first: venues that report the underlying and strikes
    // as data (Kalshi's floor_strike/cap_strike) need no title parsing — the
    // venue has already answered the question the parser tries to reverse-
    // engineer, exactly. Title parsing remains as the fallback for venues
    // whose only carrier of the threshold is prose (Polymarket).
    const structured = thresholdFromDerived(market)
    const parsed = structured === null ? parseCryptoThreshold(market.title, market.description) : null
    if (structured === null && parsed === null) return null
    const symbol = structured !== null ? structured.symbol : parsed !== null ? parsed.symbol : null
    if (symbol === null) return null

    const cache = volCache ?? new Map<string, { spot: number; annualVol: number } | null>()
    let volInputs = cache.get(symbol)
    if (volInputs === undefined) {
      volInputs = await this.fetchVolInputs(symbol)
      cache.set(symbol, volInputs)
    }
    if (volInputs === null) return null

    // Horizon: the market's own close/resolution time is authoritative — the
    // parsed deadline phrase is only a fallback and is currently unused when
    // the venue reports a timestamp.
    const horizonIso = market.resolutionTime ?? market.closeTime
    if (horizonIso === null) return null
    const horizonMs = Date.parse(horizonIso)
    if (!Number.isFinite(horizonMs)) return null
    const yearsToDeadline = Math.max(0, horizonMs - this.clock.now()) / (365.25 * DAY_MS)

    const p =
      structured !== null
        ? rangeProbability({
            spot: volInputs.spot,
            floor: structured.floor,
            cap: structured.cap,
            annualVol: volInputs.annualVol,
            yearsToDeadline,
          })
        : parsed !== null
          ? thresholdProbability({
              spot: volInputs.spot,
              strike: parsed.strike,
              op: parsed.op,
              annualVol: volInputs.annualVol,
              yearsToDeadline,
            })
          : null
    if (p === null) return null

    // The YES outcome is the one asserting the threshold event.
    const yes = market.outcomes.find((o) => o.id.toLowerCase() === 'yes' || o.name.toLowerCase() === 'yes')
    const outcome = yes ?? market.outcomes[0]
    if (outcome === undefined) return null

    // Single-model coverage: agreement is 1 by construction, so confidence
    // leans on data quality and the model's own regime instead. A modest
    // fixed confidence reflects that a one-model estimate is exactly that.
    const dataQuality = computeDataQuality({
      datasets: [
        {
          capability: 'markets.list',
          dataAsOf: market.updatedAt,
          maxAgeMs: MAX_AGE['markets.list'] ?? 10 * MINUTE_MS,
          completeness: 1,
          sourceCount: 1,
          reliability: 'PRIMARY_SOURCE',
          disagreement: null,
          isDemo: false,
        },
      ],
      expectedCapabilities: ['markets.list'],
      clock: this.clock,
    })

    return evaluateOpportunity({
      market,
      outcomeId: outcome.id,
      vixeraProbability: p,
      confidence: 0.55,
      dataQuality: dataQuality.score,
      modelAgreement: 1,
      newsRisk: 0,
      historicalCategoryAccuracy: { brierSkill: null, sampleSize: 0 },
      book: null,
      nowMs: this.clock.now(),
      predictionId: null,
      dataMode: 'live',
    })
  }

  /** Spot + EWMA annualised volatility for a symbol, from daily candles. */
  private async fetchVolInputs(
    symbol: string,
  ): Promise<{ spot: number; annualVol: number } | null> {
    const fetched = await this.registry.resolve('crypto.candles', (p) =>
      (p as import('@/providers/types').CryptoProvider).getCandles(`${symbol}USD`, '1d', 200),
    )
    if (!fetched.result.ok) return null
    const candles = fetched.result.value.data
    const last = candles[candles.length - 1]
    if (last === undefined) return null

    const returns = logReturns(candles.map((c) => c.close))
    const daily = ewmaVolatility(returns, 0.94)
    const lastVol = daily[daily.length - 1]
    if (lastVol === undefined || lastVol === null || !(lastVol > 0)) return null

    return { spot: last.close, annualVol: annualise(lastVol, 365) }
  }

  // -------------------------------------------------------------------------

  private absorb<T>(
    capability: string,
    resolved: {
      result: Result<{ data: T; provenance: { sourceId: string; fetchedAt: number; dataAsOf: number; isDemo: boolean } }, Error>
    },
    datasets: DatasetQuality[],
    sources: SourceRef[],
    failures: string[],
  ): T | null {
    if (!resolved.result.ok) {
      failures.push(`${capability}: ${resolved.result.error.message}`)
      return null
    }
    const { data, provenance } = resolved.result.value
    datasets.push({
      capability,
      dataAsOf: new Date(provenance.dataAsOf).toISOString(),
      maxAgeMs: MAX_AGE[capability] ?? HOUR_MS,
      completeness: 1,
      sourceCount: 1,
      reliability: 'PRIMARY_SOURCE',
      disagreement: null,
      isDemo: provenance.isDemo,
    })
    sources.push({
      providerId: provenance.sourceId,
      capability,
      reliability: 'PRIMARY_SOURCE',
      fetchedAt: new Date(provenance.fetchedAt).toISOString(),
      dataAsOf: new Date(provenance.dataAsOf).toISOString(),
      isDemo: provenance.isDemo,
    })
    return data
  }
}

/** Module-level singleton for route handlers. */
let engine: VixeraIntelligenceEngine | null = null

export function getIntelligenceEngine(): VixeraIntelligenceEngine {
  if (engine === null) engine = new VixeraIntelligenceEngine()
  return engine
}
