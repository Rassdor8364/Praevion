/**
 * Dictionary-based entity extraction.
 *
 * This is honest keyless NER: a curated dictionary of the entities Praevion's
 * domains actually care about, matched with word boundaries against the raw
 * (case-preserved) article text. The trade is explicit — HIGH precision (a
 * match is a real mention of a known entity), KNOWN-LIMITED recall (an entity
 * not in the dictionary does not exist to this extractor; misspellings and
 * novel names are invisible). An LLM extractor upgrades recall later at the
 * seam declared in ./seam.ts, per plan §12 — it must not change this module's
 * output contract, only add candidates to it.
 *
 * CASE SENSITIVITY is per-alias and deliberate. "Fed" must be matched
 * case-sensitively or "fed up with delays" and "the cattle were fed" become
 * Federal Reserve mentions; likewise "SEC" (vs. "sec"), "SOL" (vs. Spanish
 * "sol"), "DOGE" (vs. "doge of Venice"), "Meta" (vs. "meta discussion"),
 * "Apple" (vs. "apple pie"), "US"/"U.S." (vs. the pronoun "us"). Multi-word
 * proper names ("Federal Reserve", "Manchester City") are safe to match
 * case-insensitively because the collision surface is effectively zero.
 */

export type EntityType =
  | 'asset'
  | 'org'
  | 'macro'
  | 'company'
  | 'league'
  | 'team'
  | 'country'
  | 'topic'

export interface EntityAlias {
  readonly text: string
  /** Default false — see the case-sensitivity note in the file header. */
  readonly caseSensitive?: boolean
}

export interface EntityDefinition {
  readonly id: string
  /** Canonical display name. */
  readonly name: string
  readonly type: EntityType
  readonly aliases: readonly EntityAlias[]
  /**
   * Ticker-style symbols this entity's news plausibly moves. Consumed by the
   * importance scorer and (later) the news→market linkage; empty when the
   * entity has no direct market read-through.
   */
  readonly relatedAssets: readonly string[]
}

const cs = (text: string): EntityAlias => ({ text, caseSensitive: true })
const ci = (text: string): EntityAlias => ({ text })

function def(
  id: string,
  name: string,
  type: EntityType,
  aliases: readonly EntityAlias[],
  relatedAssets: readonly string[] = [],
): EntityDefinition {
  return { id, name, type, aliases, relatedAssets }
}

/**
 * ~100 curated entries across Praevion's domains. Ordering is cosmetic; every
 * entry is matched independently.
 */
export const NEWS_ENTITIES: readonly EntityDefinition[] = [
  // --- Crypto assets -------------------------------------------------------
  def('btc', 'Bitcoin', 'asset', [ci('bitcoin'), cs('BTC')], ['BTC']),
  def('eth', 'Ethereum', 'asset', [ci('ethereum'), cs('ETH'), cs('Ether')], ['ETH']),
  def('sol', 'Solana', 'asset', [ci('solana'), cs('SOL')], ['SOL']),
  def('xrp', 'XRP', 'asset', [cs('XRP'), ci('ripple')], ['XRP']),
  def('doge', 'Dogecoin', 'asset', [ci('dogecoin'), cs('DOGE')], ['DOGE']),
  def('bnb', 'BNB', 'asset', [cs('BNB')], ['BNB']),
  def('ada', 'Cardano', 'asset', [ci('cardano'), cs('ADA')], ['ADA']),
  def('usdt', 'Tether', 'asset', [ci('tether'), cs('USDT')], ['USDT', 'BTC']),
  def('usdc', 'USDC', 'asset', [cs('USDC')], ['USDC']),
  def('stablecoins', 'Stablecoins', 'topic', [ci('stablecoin'), ci('stablecoins')], ['USDT', 'USDC']),

  // --- Crypto orgs / infrastructure ---------------------------------------
  def('coinbase', 'Coinbase', 'org', [ci('coinbase')], ['COIN', 'BTC', 'ETH']),
  def('binance', 'Binance', 'org', [ci('binance')], ['BNB', 'BTC']),
  def('kraken', 'Kraken', 'org', [ci('kraken')], ['BTC', 'ETH']),
  def('okx', 'OKX', 'org', [cs('OKX')], ['BTC']),
  def('bybit', 'Bybit', 'org', [ci('bybit')], ['BTC']),
  def('grayscale', 'Grayscale', 'org', [ci('grayscale')], ['BTC', 'ETH']),
  def('microstrategy', 'Strategy (MicroStrategy)', 'company', [ci('microstrategy'), cs('MSTR')], ['MSTR', 'BTC']),
  def('defi', 'DeFi', 'topic', [cs('DeFi'), ci('decentralized finance')], ['ETH']),
  def('nft', 'NFTs', 'topic', [cs('NFT'), cs('NFTs')], ['ETH']),
  def('crypto-etf', 'Crypto ETFs', 'topic', [ci('spot etf'), ci('bitcoin etf'), ci('ether etf'), ci('crypto etf')], ['BTC', 'ETH']),
  def('mining', 'Crypto mining', 'topic', [ci('bitcoin miner'), ci('bitcoin miners'), ci('bitcoin mining'), ci('crypto mining')], ['BTC']),
  def('halving', 'Bitcoin halving', 'topic', [ci('halving')], ['BTC']),

  // --- Macro / central banks / regulators ----------------------------------
  // The Fed moves everything priced in dollars; BTC included (plan §11:
  // twelve outlets on one Fed decision must read as ONE important event).
  def('fed', 'Federal Reserve', 'macro', [ci('federal reserve'), cs('Fed'), cs('FOMC'), ci('jerome powell')], ['USD', 'BTC', 'ETH', 'SPX']),
  def('ecb', 'European Central Bank', 'macro', [ci('european central bank'), cs('ECB'), ci('lagarde')], ['EUR']),
  def('boe', 'Bank of England', 'macro', [ci('bank of england'), cs('BoE')], ['GBP']),
  def('boj', 'Bank of Japan', 'macro', [ci('bank of japan'), cs('BOJ')], ['JPY']),
  def('sec', 'SEC', 'macro', [cs('SEC'), ci('securities and exchange commission')], ['BTC', 'ETH', 'COIN']),
  def('cftc', 'CFTC', 'macro', [cs('CFTC')], ['BTC']),
  def('cpi', 'CPI', 'macro', [cs('CPI'), ci('consumer price index')], ['USD', 'SPX', 'BTC']),
  def('inflation', 'Inflation', 'macro', [ci('inflation'), ci('disinflation')], ['USD', 'SPX', 'BTC']),
  def('interest-rates', 'Interest rates', 'macro', [ci('interest rate'), ci('interest rates'), ci('rate hike'), ci('rate cut'), ci('rate hikes'), ci('rate cuts')], ['USD', 'SPX', 'BTC']),
  def('treasury', 'U.S. Treasury', 'macro', [cs('Treasury'), ci('treasury yields'), ci('treasury bonds')], ['USD', 'SPX']),
  def('gdp', 'GDP', 'macro', [cs('GDP'), ci('gross domestic product')], ['SPX']),
  def('jobs', 'US labor market', 'macro', [ci('nonfarm payrolls'), ci('jobs report'), ci('unemployment rate'), ci('jobless claims')], ['USD', 'SPX']),
  def('tariffs', 'Tariffs', 'macro', [ci('tariff'), ci('tariffs'), ci('trade war')], ['SPX', 'USD']),
  def('recession', 'Recession', 'macro', [ci('recession')], ['SPX', 'USD']),
  def('imf', 'IMF', 'macro', [cs('IMF'), ci('international monetary fund')]),
  def('opec', 'OPEC', 'macro', [cs('OPEC')], ['OIL']),
  def('oil', 'Oil', 'topic', [ci('crude oil'), ci('brent crude'), cs('WTI'), ci('oil prices')], ['OIL']),
  def('gold', 'Gold', 'topic', [ci('gold price'), ci('gold prices'), ci('bullion')], ['GOLD']),
  def('dollar', 'US Dollar', 'topic', [ci('us dollar'), cs('USD'), ci('greenback')], ['USD']),
  // Leaders are typed 'macro': what makes them dictionary-worthy here is
  // policy read-through, not biography.
  def('trump', 'Donald Trump', 'macro', [cs('Trump'), ci('donald trump')], ['SPX', 'USD']),
  def('white-house', 'White House', 'macro', [ci('white house')], ['SPX', 'USD']),
  def('congress', 'US Congress', 'macro', [cs('Congress'), cs('Senate')], ['SPX']),

  // --- Companies -----------------------------------------------------------
  def('apple', 'Apple', 'company', [cs('Apple'), cs('AAPL'), cs('iPhone')], ['AAPL']),
  def('tesla', 'Tesla', 'company', [ci('tesla'), cs('TSLA'), ci('elon musk')], ['TSLA']),
  def('nvidia', 'Nvidia', 'company', [ci('nvidia'), cs('NVDA')], ['NVDA']),
  def('microsoft', 'Microsoft', 'company', [ci('microsoft'), cs('MSFT')], ['MSFT']),
  def('google', 'Google / Alphabet', 'company', [ci('google'), ci('alphabet'), cs('GOOGL')], ['GOOGL']),
  def('amazon', 'Amazon', 'company', [cs('Amazon'), cs('AMZN'), cs('AWS')], ['AMZN']),
  def('meta', 'Meta', 'company', [cs('Meta'), ci('facebook'), ci('instagram'), cs('META')], ['META']),
  def('openai', 'OpenAI', 'company', [ci('openai'), ci('chatgpt')], ['MSFT']),
  def('intel', 'Intel', 'company', [cs('Intel'), cs('INTC')], ['INTC']),
  def('amd', 'AMD', 'company', [cs('AMD')], ['AMD']),
  def('netflix', 'Netflix', 'company', [ci('netflix'), cs('NFLX')], ['NFLX']),
  def('jpmorgan', 'JPMorgan', 'company', [ci('jpmorgan'), ci('jp morgan')], ['JPM']),
  def('goldman', 'Goldman Sachs', 'company', [ci('goldman sachs'), cs('Goldman')], ['GS']),
  def('boeing', 'Boeing', 'company', [ci('boeing')], ['BA']),
  def('disney', 'Disney', 'company', [cs('Disney'), cs('DIS')], ['DIS']),
  def('tsmc', 'TSMC', 'company', [cs('TSMC'), ci('taiwan semiconductor')], ['TSM']),
  def('samsung', 'Samsung', 'company', [ci('samsung')]),
  def('ai', 'Artificial intelligence', 'topic', [ci('artificial intelligence'), cs('AI')], ['NVDA', 'MSFT', 'GOOGL']),
  def('semiconductors', 'Semiconductors', 'topic', [ci('semiconductor'), ci('semiconductors'), ci('chipmaker'), ci('chipmakers')], ['NVDA', 'INTC', 'AMD', 'TSM']),

  // --- Sports: the 7 covered leagues + marquee clubs -----------------------
  def('premier-league', 'Premier League', 'league', [ci('premier league'), cs('EPL')]),
  def('la-liga', 'La Liga', 'league', [ci('la liga'), cs('LaLiga')]),
  def('bundesliga', 'Bundesliga', 'league', [ci('bundesliga')]),
  def('serie-a', 'Serie A', 'league', [ci('serie a')]),
  def('ligue-1', 'Ligue 1', 'league', [ci('ligue 1')]),
  def('mls', 'MLS', 'league', [cs('MLS'), ci('major league soccer')]),
  def('champions-league', 'Champions League', 'league', [ci('champions league'), cs('UCL')]),
  def('man-city', 'Manchester City', 'team', [ci('manchester city'), ci('man city')]),
  def('man-united', 'Manchester United', 'team', [ci('manchester united'), ci('man united'), ci('man utd')]),
  def('liverpool', 'Liverpool', 'team', [ci('liverpool')]),
  def('arsenal', 'Arsenal', 'team', [cs('Arsenal')]),
  def('real-madrid', 'Real Madrid', 'team', [ci('real madrid')]),
  def('barcelona', 'Barcelona', 'team', [ci('barcelona'), ci('barça')]),
  def('bayern', 'Bayern Munich', 'team', [ci('bayern munich'), cs('Bayern')]),

  // --- Countries (market-relevant) ----------------------------------------
  def('usa', 'United States', 'country', [ci('united states'), cs('U.S.'), cs('US'), cs('USA')], ['USD', 'SPX']),
  def('china', 'China', 'country', [cs('China'), ci('beijing')], ['SPX']),
  def('russia', 'Russia', 'country', [ci('russia'), ci('kremlin')], ['OIL']),
  def('ukraine', 'Ukraine', 'country', [ci('ukraine'), ci('kyiv')], ['OIL']),
  def('israel', 'Israel', 'country', [ci('israel')], ['OIL']),
  def('iran', 'Iran', 'country', [ci('iran'), ci('tehran')], ['OIL']),
  def('japan', 'Japan', 'country', [ci('japan'), ci('tokyo')], ['JPY']),
  def('germany', 'Germany', 'country', [ci('germany'), ci('berlin')], ['EUR']),
  def('uk', 'United Kingdom', 'country', [ci('united kingdom'), cs('UK'), ci('britain')], ['GBP']),
  def('india', 'India', 'country', [ci('india'), ci('new delhi')]),
  def('taiwan', 'Taiwan', 'country', [ci('taiwan')], ['TSM']),
  def('eu', 'European Union', 'country', [ci('european union'), cs('EU'), ci('brussels')], ['EUR']),
  def('france', 'France', 'country', [ci('france'), ci('paris')], ['EUR']),
]

/** Dictionary lookup by id. */
const BY_ID: ReadonlyMap<string, EntityDefinition> = new Map(
  NEWS_ENTITIES.map((e) => [e.id, e]),
)

export function getEntity(id: string): EntityDefinition | null {
  return BY_ID.get(id) ?? null
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface EntityMatch {
  readonly entityId: string
  /** Total mentions across all aliases. */
  readonly count: number
  /** Character offsets (start of each mention) in the scanned text. */
  readonly offsets: readonly number[]
}

interface CompiledAlias {
  readonly entityId: string
  readonly regex: RegExp
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Word-boundary regexes, compiled once at module load. `\b` handles the token
 * edges ("BTC" does not match inside "BTCUSDT"); aliases ending in "." (like
 * "U.S.") get a custom right edge because `\b` after a period behaves
 * inversely to intuition.
 */
const COMPILED: readonly CompiledAlias[] = NEWS_ENTITIES.flatMap((entity) =>
  entity.aliases.map((alias): CompiledAlias => {
    const body = escapeRegex(alias.text)
    const left = /^[a-z0-9]/i.test(alias.text) ? '\\b' : ''
    const right = /[a-z0-9]$/i.test(alias.text) ? '\\b' : '(?![a-zA-Z0-9])'
    return {
      entityId: entity.id,
      regex: new RegExp(`${left}${body}${right}`, alias.caseSensitive === true ? 'g' : 'gi'),
    }
  }),
)

/**
 * All dictionary entities mentioned in the text, with counts and offsets.
 * Deterministic; the same text always yields the same matches.
 */
export function extractEntities(text: string): EntityMatch[] {
  const byEntity = new Map<string, number[]>()

  for (const { entityId, regex } of COMPILED) {
    regex.lastIndex = 0 // shared compiled regexes are stateful under /g
    for (const m of text.matchAll(regex)) {
      if (m.index === undefined) continue
      const list = byEntity.get(entityId)
      if (list === undefined) byEntity.set(entityId, [m.index])
      else list.push(m.index)
    }
  }

  const out: EntityMatch[] = []
  for (const [entityId, rawOffsets] of byEntity) {
    // Two aliases can overlap on the same mention ("Federal Reserve" + "Fed"
    // never do, but "US" and "USA" can); dedupe offsets so counts are honest.
    const offsets = [...new Set(rawOffsets)].sort((a, b) => a - b)
    out.push({ entityId, count: offsets.length, offsets })
  }
  // Stable order: most-mentioned first, then id for determinism.
  return out.sort((a, b) => b.count - a.count || (a.entityId < b.entityId ? -1 : 1))
}
