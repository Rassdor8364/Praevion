/**
 * Repository barrel.
 *
 * The only sanctioned path from the orchestrator to the database. Nothing above
 * `db/` constructs a Supabase query directly — that rule is what keeps the
 * append-only guarantee on predictions enforceable by reading one directory
 * instead of the whole codebase.
 */

export {
  savePrediction,
  getLatestPrediction,
  listPredictions,
  recordPredictionHistory,
  settleOutcome,
  getUnsettled,
  type PredictionFilters,
  type PredictionHistoryPoint,
  type RepositoryOptions,
  type SavePredictionOptions,
} from './predictions'

export {
  upsertMarket,
  recordPrices,
  listMarkets,
  getMarket,
  saveOpportunity,
  listOpportunities,
  linkMarkets,
  getDislocations,
  type MarketFilters,
  type MarketPricePoint,
  type OpportunityFilters,
  type UpsertMarketResult,
} from './markets'
