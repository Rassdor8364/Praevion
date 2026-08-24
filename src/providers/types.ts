/**
 * Provider contracts.
 *
 * Nothing above this layer knows which vendor supplied a number. Every method
 * returns Result rather than throwing, and every payload carries its own
 * provenance (`fetchedAt`, `sourceId`, `isDemo`) so freshness and data mode are
 * measured at the boundary rather than guessed at later.
 */

import type { Result } from '@/core/result'
import type { ProviderError } from '@/core/errors'
import type { ReliabilityClass } from '@/core/prediction/types'

export type Capability =
  | 'crypto.price'
  | 'crypto.candles'
  | 'crypto.orderbook'
  | 'crypto.market'
  | 'crypto.derivatives'
  | 'crypto.onchain'
  | 'sports.competitions'
  | 'sports.teams'
  | 'sports.games'
  | 'sports.teamStats'
  | 'sports.playerStats'
  | 'sports.injuries'
  | 'sports.lineups'
  | 'sports.odds'
  | 'news.latest'
  | 'news.search'
  | 'macro.series'
  | 'markets.list'
  | 'markets.detail'
  | 'markets.orderbook'
  | 'markets.trades'

export interface Provenance {
  readonly sourceId: string
  /** Epoch ms at which we fetched. */
  readonly fetchedAt: number
  /** Epoch ms of the newest datum in the payload. */
  readonly dataAsOf: number
  readonly isDemo: boolean
}

export interface Sourced<T> {
  readonly data: T
  readonly provenance: Provenance
}

export type ProviderResult<T> = Result<Sourced<T>, ProviderError>

export interface ProviderHealth {
  readonly healthy: boolean
  readonly latencyMs: number | null
  readonly message: string | null
}

export interface Provider {
  readonly id: string
  readonly displayName: string
  readonly reliability: ReliabilityClass
  readonly isDemo: boolean
  readonly capabilities: readonly Capability[]
  /** Whether required configuration (API key etc.) is present. */
  isConfigured(): boolean
  health(): Promise<ProviderHealth>
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

export interface Candle {
  /** Epoch ms of the candle open. */
  readonly openTime: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly closeTime: number
  /** Number of trades in the candle, when the venue reports it. */
  readonly trades: number | null
  /** Volume executed against the ask (buyer-initiated), when reported. */
  readonly takerBuyVolume: number | null
}

export interface PriceTick {
  readonly symbol: string
  readonly price: number
  readonly timestamp: number
}

export interface OrderBookLevel {
  readonly price: number
  readonly quantity: number
}

export interface OrderBook {
  readonly symbol: string
  readonly bids: readonly OrderBookLevel[]
  readonly asks: readonly OrderBookLevel[]
  readonly timestamp: number
}

export interface MarketData {
  readonly symbol: string
  readonly price: number
  readonly change24hPct: number
  readonly high24h: number
  readonly low24h: number
  readonly volume24h: number
  readonly quoteVolume24h: number
  readonly marketCap: number | null
  readonly timestamp: number
}

export interface DerivativesData {
  readonly symbol: string
  readonly fundingRate: number | null
  readonly nextFundingTime: number | null
  readonly openInterest: number | null
  readonly openInterestValue: number | null
  readonly timestamp: number
}

export interface CryptoProvider extends Provider {
  getPrice(symbol: string): Promise<ProviderResult<PriceTick>>
  getCandles(
    symbol: string,
    interval: CandleInterval,
    limit: number,
  ): Promise<ProviderResult<Candle[]>>
  getOrderBook(symbol: string, depth: number): Promise<ProviderResult<OrderBook>>
  getMarketData(symbol: string): Promise<ProviderResult<MarketData>>
  getDerivatives?(symbol: string): Promise<ProviderResult<DerivativesData>>
}

// ---------------------------------------------------------------------------
// Sports
// ---------------------------------------------------------------------------

export type SportKey =
  | 'football'
  | 'basketball'
  | 'american_football'
  | 'ice_hockey'
  | 'baseball'
  | 'tennis'
  | 'mma'
  | 'boxing'
  | 'motorsport'
  | 'esports'

export interface Competition {
  readonly externalId: string
  readonly name: string
  readonly sport: SportKey
  readonly country: string | null
  readonly currentSeason: string | null
}

export interface Team {
  readonly externalId: string
  readonly name: string
  readonly shortName: string
  readonly competitionId: string | null
  readonly crestUrl: string | null
}

export type GameStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled'

export interface Game {
  readonly externalId: string
  readonly competitionId: string
  readonly season: string
  readonly kickoff: number
  readonly status: GameStatus
  readonly homeTeamId: string
  readonly awayTeamId: string
  readonly homeTeamName: string
  readonly awayTeamName: string
  readonly homeScore: number | null
  readonly awayScore: number | null
  readonly matchday: number | null
  readonly venue: string | null
}

/** Sport-agnostic per-game team box score. Sport-specific extras live in `extra`. */
export interface TeamGameStats {
  readonly gameId: string
  readonly teamId: string
  readonly isHome: boolean
  readonly scored: number
  readonly conceded: number
  readonly result: 'W' | 'D' | 'L'
  readonly shots: number | null
  readonly shotsOnTarget: number | null
  readonly possession: number | null
  readonly expectedGoalsFor: number | null
  readonly expectedGoalsAgainst: number | null
  readonly extra: Readonly<Record<string, number>>
}

export interface Injury {
  readonly playerId: string
  readonly playerName: string
  readonly teamId: string
  readonly status: 'out' | 'doubtful' | 'questionable' | 'probable' | 'suspended'
  readonly reason: string | null
  readonly reportedAt: number
  readonly expectedReturn: number | null
}

export interface LineupPlayer {
  readonly playerId: string
  readonly playerName: string
  readonly position: string | null
  readonly isStarter: boolean
}

export interface Lineup {
  readonly gameId: string
  readonly teamId: string
  readonly confirmed: boolean
  readonly formation: string | null
  readonly players: readonly LineupPlayer[]
}

export interface SportsProvider extends Provider {
  readonly sport: SportKey
  getCompetitions(): Promise<ProviderResult<Competition[]>>
  getTeams(competitionId: string): Promise<ProviderResult<Team[]>>
  getGames(params: {
    competitionId: string
    from?: number
    to?: number
    status?: GameStatus
  }): Promise<ProviderResult<Game[]>>
  getTeamGameStats(teamId: string, limit: number): Promise<ProviderResult<TeamGameStats[]>>
  getInjuries?(teamId: string): Promise<ProviderResult<Injury[]>>
  getLineups?(gameId: string): Promise<ProviderResult<Lineup[]>>
}

// ---------------------------------------------------------------------------
// Sportsbook odds
// ---------------------------------------------------------------------------

export interface BookOddsOutcome {
  /** Outcome name as the venue labels it (team name, 'Draw', 'Over', …). */
  readonly name: string
  readonly decimalOdds: number
  /** Line for totals/handicaps ('Over 2.5' → 2.5); null for 1X2. */
  readonly point: number | null
}

export interface BookMarketOdds {
  readonly bookmaker: string
  /** Provider-normalised market key: 'h2h' (1X2) or 'totals'. */
  readonly marketKey: 'h2h' | 'totals'
  readonly outcomes: readonly BookOddsOutcome[]
  /** Epoch ms the venue last updated these prices. */
  readonly lastUpdate: number
}

/**
 * One event's odds as the odds venue describes it. Team naming and event ids
 * are the VENUE'S, not ours — matching an odds event to a provider game is a
 * separate, deliberately conservative step (engines/sports/odds-edge.ts):
 * a wrong match would price one fixture with another's market.
 */
export interface GameOdds {
  readonly externalId: string
  readonly homeTeamName: string
  readonly awayTeamName: string
  readonly kickoff: number
  readonly markets: readonly BookMarketOdds[]
}

export interface OddsProvider extends Provider {
  getOdds(params: { competitionId: string }): Promise<ProviderResult<GameOdds[]>>
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export interface RawArticle {
  readonly externalId: string
  readonly title: string
  readonly url: string
  readonly sourceName: string
  readonly sourceId: string
  readonly author: string | null
  readonly publishedAt: number
  readonly summary: string | null
  readonly body: string | null
  readonly category: string | null
  readonly imageUrl: string | null
}

export interface NewsProvider extends Provider {
  getLatestNews(params: { category?: string; limit: number }): Promise<ProviderResult<RawArticle[]>>
  searchNews(params: { query: string; limit: number }): Promise<ProviderResult<RawArticle[]>>
}
