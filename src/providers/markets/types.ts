/**
 * Prediction-market provider contract.
 *
 * Kalshi and Polymarket are PEERS, not fallbacks for each other: they list
 * different markets, so "Kalshi failed, ask Polymarket" is not a recovery — it
 * is a different dataset. The registry's per-capability chain is still used for
 * registration and health, but the scanner enumerates venues through
 * `getMarketProviders()` (see providers/index.ts) rather than resolving down a
 * chain.
 */

import type {
  MarketCategory,
  MarketOrderBook,
  MarketTrade,
  PredictionMarket,
} from '@/core/markets/types'
import type { Provider, ProviderResult } from '../types'

export interface PredictionMarketProvider extends Provider {
  /**
   * List open markets, newest/most-active first (venue-defined ordering).
   *
   * `cursor` is an opaque venue-specific pagination token from a previous
   * page's `nextCursor`; `nextCursor: null` means the listing is exhausted.
   * `category` is best-effort: venues differ in whether it can be filtered
   * server-side, so a page may come back shorter than `limit` after client-side
   * filtering — shorter, never mislabelled.
   */
  getMarkets(params: {
    category?: MarketCategory
    limit: number
    cursor?: string
  }): Promise<ProviderResult<{ markets: PredictionMarket[]; nextCursor: string | null }>>

  /** Fetch a single market by the venue's own id (Kalshi ticker, Polymarket id). */
  getMarket(externalId: string): Promise<ProviderResult<PredictionMarket>>

  /**
   * Order book for one outcome of a market, prices normalised to
   * probabilities (0..1) with bids best-first descending and asks best-first
   * ascending — regardless of how the venue orients its book.
   */
  getOrderBook(externalId: string, outcomeId: string): Promise<ProviderResult<MarketOrderBook>>

  /** Most recent trades, newest first, prices normalised to probabilities. */
  getTrades(externalId: string, limit: number): Promise<ProviderResult<MarketTrade[]>>
}
