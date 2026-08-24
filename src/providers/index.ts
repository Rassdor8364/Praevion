/**
 * Provider wiring — the one place that decides who is asked first.
 *
 * `ProviderRegistry.register()` appends a provider to the chain of every
 * capability it declares, so REGISTRATION ORDER IS PREFERENCE ORDER. It also
 * already drops unconfigured live providers and demo providers when demo mode is
 * not allowed, so nothing here re-checks keys or environment flags — doing so
 * would put the same rule in two places and let them drift apart.
 *
 * Intended chains:
 *
 *   crypto.candles / crypto.orderbook   Coinbase → Kraken → Binance → Demo
 *   crypto.price   / crypto.market      CoinGecko → Coinbase → Kraken → Demo
 *   crypto.derivatives                  Binance → Demo
 *   sports.*                            football-data → ESPN → Demo
 *   news.*                              RSS → Demo
 *   markets.*                           Kalshi, Polymarket (PEERS) → Demo
 *
 * Prediction-market venues are a special case: Kalshi and Polymarket list
 * DIFFERENT markets, so one is not a fallback for the other — falling through
 * would silently swap datasets. They still live on the registry chains (for
 * registration, health and the demo gate), but the scanner enumerates venues
 * via `getMarketProviders()` below instead of `resolve()`.
 *
 * One nuance falls out of the single-registration model: Binance declares price
 * and market too, so it lands between Kraken and Demo on those chains as well.
 * That is intentional and harmless — it is a real venue, and reaching a live
 * source before falling back to synthetic data is always the better outcome.
 */

import { BinanceProvider } from './crypto/binance'
import { CoinbaseExchangeProvider } from './crypto/coinbase'
import { CoinGeckoProvider } from './crypto/coingecko'
import { DemoCryptoProvider } from './crypto/demo'
import { KrakenProvider } from './crypto/kraken'
import { DemoPredictionMarketProvider } from './markets/demo'
import { KalshiProvider } from './markets/kalshi'
import { PolymarketProvider } from './markets/polymarket'
import type { PredictionMarketProvider } from './markets/types'
import { DemoNewsProvider } from './news/demo'
import { RssNewsProvider } from './news/rss'
import { TheOddsApiProvider } from './odds/the-odds-api'
import { ProviderRegistry } from './registry'
import { DemoFootballProvider } from './sports/demo'
import { EspnFootballProvider } from './sports/espn'
import { FootballDataProvider } from './sports/football-data'

export { ProviderRegistry, demoAllowed } from './registry'
export type { AttemptRecord, ResolvedFetch } from './registry'
export { FEEDS } from './news/rss'
export type { PredictionMarketProvider } from './markets/types'

/**
 * Build a fresh registry.
 *
 * Exported separately from `getRegistry()` so tests can construct an isolated
 * registry after mutating process.env, without the module-level memo pinning an
 * earlier environment.
 */
export function createRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry()

  // --- Crypto -------------------------------------------------------------
  // CoinGecko first: it is the only source that reports market cap, and for a
  // spot quote its couple of minutes of aggregation lag is immaterial next to
  // the 24h window most consumers ask about.
  registry.register(new CoinGeckoProvider())
  // Coinbase heads candles and order books: keyless, US-reachable and a primary
  // venue with a real book.
  registry.register(new CoinbaseExchangeProvider())
  // Kraken second — also US-reachable, and the only live source with a NATIVE
  // 4h candle, which is precisely the interval Coinbase refuses.
  registry.register(new KrakenProvider())
  // Binance last among live venues: it answers 451 from US infrastructure, so it
  // is expected to fail there. It stays registered because it is the only source
  // of taker-buy volume and of funding / open interest.
  registry.register(new BinanceProvider())
  // Demo is the terminal link on every crypto chain. It is registered only when
  // demoAllowed(), and everything it returns is flagged isDemo.
  registry.register(new DemoCryptoProvider())

  // --- Sports -------------------------------------------------------------
  // football-data.org first when its key is present (register() already skips
  // it otherwise, so listing it first costs nothing keyless). ESPN is the
  // keyless live fallback — an undocumented API whose schema drift surfaces as
  // schema_mismatch and falls through here rather than to demo.
  registry.register(new FootballDataProvider())
  registry.register(new EspnFootballProvider())
  registry.register(new DemoFootballProvider())

  // --- Sportsbook odds -------------------------------------------------------
  // Keyed; register() skips it without ODDS_API_KEY, leaving 'sports.odds'
  // with no chain — consumers then render "Sportsbook odds unavailable".
  // There is deliberately NO demo odds provider: a fabricated bookmaker
  // price would flow into edge/EV numbers and defeat the product's honesty
  // guarantee at its most sensitive point.
  registry.register(new TheOddsApiProvider())

  // --- News ---------------------------------------------------------------
  registry.register(new RssNewsProvider())
  registry.register(new DemoNewsProvider())

  // --- Prediction markets ---------------------------------------------------
  // Kalshi and Polymarket are registered as peers (see header comment): both
  // keyless, both first-party venues. Order here only decides who answers a
  // registry.resolve() call — enumeration goes through getMarketProviders().
  registry.register(new KalshiProvider())
  registry.register(new PolymarketProvider())
  // Demo is terminal, registered only when demoAllowed().
  registry.register(new DemoPredictionMarketProvider())

  return registry
}

/**
 * Every prediction-market venue in the registry, in registration order.
 *
 * The scanner iterates ALL of these — venue coverage, not fallback — because
 * each venue lists different markets. Demo (present only when demoAllowed())
 * is included so demo mode still has a venue to enumerate; its payloads are
 * already flagged isDemo and cannot masquerade as live data.
 */
export function getMarketProviders(registry: ProviderRegistry): readonly PredictionMarketProvider[] {
  // Every provider registered under markets.list implements the full
  // PredictionMarketProvider surface (all four markets.* capabilities are
  // declared together), so the cast is safe.
  return registry.chain('markets.list') as readonly PredictionMarketProvider[]
}

let memo: ProviderRegistry | null = null

/**
 * Process-wide registry.
 *
 * Memoised because the providers hold the HTTP client's token buckets by id:
 * rebuilding the registry per request would not reset those (they are keyed
 * globally in http.ts), but it would allocate on every call for no benefit. The
 * registry is stateless beyond its chains, so sharing it is safe across
 * concurrent requests.
 */
export function getRegistry(): ProviderRegistry {
  if (memo === null) memo = createRegistry()
  return memo
}

/** Drop the memo. Tests use this after changing environment variables. */
export function resetRegistry(): void {
  memo = null
}
