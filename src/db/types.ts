/**
 * Hand-written database types.
 *
 * These mirror src/db/migrations/*.up.sql. They are written by hand rather than
 * generated because the schema must be type-checked before a Supabase project
 * exists — `supabase gen types` needs a live database, and the app has to build
 * and typecheck long before one is provisioned.
 *
 * Conventions, matching what PostgREST actually puts on the wire:
 *   uuid, timestamptz, date, inet, text  -> string
 *   numeric, integer, smallint           -> number
 *   jsonb                                -> Json
 *   text[]                               -> string[]
 *   nullable column                      -> `| null` on Row, optional on Insert
 *
 * `numeric` deserves a note: PostgREST serialises it as a JSON number, so it
 * arrives as a JS `number` and loses exactness above 2^53. Every numeric column
 * in this schema is dimensioned to stay well inside that range for display
 * purposes; arithmetic that must be exact (money aggregation) belongs in SQL,
 * not in JavaScript.
 *
 * No `any` appears anywhere in this file, by design.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

// ---------------------------------------------------------------------------
// Enums — each union mirrors a CREATE TYPE ... AS ENUM, in declaration order.
// ---------------------------------------------------------------------------

export type SubscriptionTier = 'free' | 'basic' | 'pro' | 'enterprise'

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'paused'

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

export type ReliabilityClassDb =
  | 'OFFICIAL'
  | 'PRIMARY_SOURCE'
  | 'HIGH_RELIABILITY'
  | 'ESTABLISHED_MEDIA'
  | 'SECONDARY'
  | 'SOCIAL'
  | 'UNVERIFIED'

export type DataModeDb = 'live' | 'partial' | 'demo'

export type IngestionJobStatus = 'running' | 'succeeded' | 'partial' | 'failed'

export type VixeraEventType =
  | 'INITIAL'
  | 'SCHEDULED'
  | 'MANUAL_RECOMPUTE'
  | 'NEW_ARTICLE'
  | 'PRICE_TICK'
  | 'CANDLE_CLOSED'
  | 'LINEUP_CHANGE'
  | 'PLAYER_INJURY'
  | 'GAME_STARTED'
  | 'GAME_FINISHED'
  | 'VOLATILITY_SPIKE'
  | 'PREDICTION_UPDATED'
  | 'MODEL_SIGNAL'

export type EventStatus = 'pending' | 'processing' | 'processed' | 'failed'

export type PredictionDomain = 'sports' | 'crypto' | 'stocks' | 'forex' | 'events'

export type PredictionTimeframe = '15m' | '1h' | '4h' | '24h' | '7d' | '30d' | 'event'

export type RiskLevelDb = 'low' | 'medium' | 'high' | 'extreme'

export type FactorPolarity = 'supporting' | 'opposing'

export type ModelKind = 'statistical' | 'machine_learning' | 'heuristic' | 'ensemble' | 'calibrator'

export type TrainingRunStatus = 'running' | 'succeeded' | 'failed' | 'aborted'

export type GameStatusDb = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled'

export type InjuryStatusDb = 'out' | 'doubtful' | 'questionable' | 'probable' | 'suspended'

export type GameResult = 'W' | 'D' | 'L'

export type RatingSystem = 'elo' | 'glicko2' | 'form_score' | 'team_strength'

export type CandleIntervalDb = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

export type AssetClass = 'crypto' | 'equity' | 'fx' | 'commodity' | 'index'

export type NewsEventStatus = 'active' | 'settled' | 'merged' | 'suppressed'

export type NewsEntityType =
  | 'asset'
  | 'team'
  | 'player'
  | 'company'
  | 'person'
  | 'organization'
  | 'country'
  | 'sector'
  | 'regulator'
  | 'other'

export type AlertStatus = 'active' | 'paused' | 'triggered' | 'archived'

export type SignalStrength = 'weak' | 'moderate' | 'strong' | 'very_strong'

export type SignalDirection = 'bullish' | 'bearish' | 'neutral'

export type NotificationChannel = 'in_app' | 'email' | 'push' | 'webhook'

export type NotificationStatus = 'queued' | 'sent' | 'failed' | 'suppressed'

export type MarketCategoryDb =
  | 'politics'
  | 'economics'
  | 'crypto'
  | 'sports'
  | 'weather'
  | 'entertainment'
  | 'science'
  | 'companies'
  | 'other'

export type MarketStatusDb = 'open' | 'closed' | 'settled' | 'suspended' | 'unknown'

export type LiquidityGradeDb = 'excellent' | 'good' | 'fair' | 'poor' | 'illiquid'

export type ResolutionRiskLevelDb = 'low' | 'medium' | 'high'

// Text columns constrained by CHECK rather than by enum types (0008).
export type MarketLinkMethod = 'manual' | 'embedding' | 'ticker'

export type OpportunityAction = 'opportunity' | 'no_action'

export type TradeSideDb = 'buy' | 'sell' | 'unknown'

export type TraderReliability = 'very_low' | 'low' | 'medium' | 'high' | 'very_high'

export type PaperPositionResult = 'won' | 'lost' | 'void' | 'closed_early'

/**
 * Shape one table entry. `Relationships` is required by postgrest-js's
 * GenericTable; we leave it empty because nothing in this codebase relies on
 * PostgREST's embedded-resource inference — joins are written explicitly in the
 * repositories, where they can be read and reasoned about.
 */
interface TableDef<Row, Insert> {
  Row: Row
  Insert: Insert
  Update: Partial<Insert>
  Relationships: []
}

interface ViewDef<Row> {
  Row: Row
  Relationships: []
}

// ===========================================================================
// 0001_foundation
// ===========================================================================

export type OrganizationRow = {
  id: string
  name: string
  slug: string
  tier: SubscriptionTier
  is_platform: boolean
  settings: Json
  created_at: string
  updated_at: string
}
export type OrganizationInsert = {
  id?: string
  name: string
  slug: string
  tier?: SubscriptionTier
  is_platform?: boolean
  settings?: Json
  created_at?: string
  updated_at?: string
}

export type OrgMemberRow = {
  org_id: string
  user_id: string
  role: OrgRole
  invited_by: string | null
  created_at: string
}
export type OrgMemberInsert = {
  org_id: string
  user_id: string
  role?: OrgRole
  invited_by?: string | null
  created_at?: string
}

export type UserProfileRow = {
  id: string
  user_id: string
  default_org_id: string | null
  display_name: string | null
  avatar_url: string | null
  timezone: string
  locale: string
  preferences: Json
  onboarded_at: string | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}
export type UserProfileInsert = {
  id?: string
  user_id: string
  default_org_id?: string | null
  display_name?: string | null
  avatar_url?: string | null
  timezone?: string
  locale?: string
  preferences?: Json
  onboarded_at?: string | null
  last_seen_at?: string | null
  created_at?: string
  updated_at?: string
}

export type SubscriptionRow = {
  id: string
  org_id: string
  tier: SubscriptionTier
  status: SubscriptionStatus
  billing_provider: string
  external_customer_id: string | null
  external_subscription_id: string | null
  seats: number
  current_period_start: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean
  canceled_at: string | null
  created_at: string
  updated_at: string
}
export type SubscriptionInsert = {
  id?: string
  org_id: string
  tier: SubscriptionTier
  status: SubscriptionStatus
  billing_provider?: string
  external_customer_id?: string | null
  external_subscription_id?: string | null
  seats?: number
  current_period_start?: string | null
  current_period_end?: string | null
  cancel_at_period_end?: boolean
  canceled_at?: string | null
  created_at?: string
  updated_at?: string
}

export type FeatureFlagRow = {
  id: string
  key: string
  org_id: string | null
  description: string | null
  is_enabled: boolean
  min_tier: SubscriptionTier | null
  rollout_percentage: number
  metadata: Json
  created_at: string
  updated_at: string
}
export type FeatureFlagInsert = {
  id?: string
  key: string
  org_id?: string | null
  description?: string | null
  is_enabled?: boolean
  min_tier?: SubscriptionTier | null
  rollout_percentage?: number
  metadata?: Json
  created_at?: string
  updated_at?: string
}

export type AuditLogRow = {
  id: string
  org_id: string
  actor_user_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  before_state: Json | null
  after_state: Json | null
  ip_address: string | null
  user_agent: string | null
  created_at: string
}
export type AuditLogInsert = {
  id?: string
  org_id: string
  actor_user_id?: string | null
  action: string
  entity_type: string
  entity_id?: string | null
  before_state?: Json | null
  after_state?: Json | null
  ip_address?: string | null
  user_agent?: string | null
  created_at?: string
}

export type DataProviderRow = {
  id: string
  provider_id: string
  display_name: string
  reliability: ReliabilityClassDb
  is_demo: boolean
  capabilities: string[]
  is_enabled: boolean
  requires_key: boolean
  is_configured: boolean
  priority: number
  base_url: string | null
  rate_limit_per_min: number | null
  last_health_check_at: string | null
  is_healthy: boolean | null
  latency_ms: number | null
  health_message: string | null
  created_at: string
  updated_at: string
}
export type DataProviderInsert = {
  id?: string
  provider_id: string
  display_name: string
  reliability: ReliabilityClassDb
  is_demo?: boolean
  capabilities?: string[]
  is_enabled?: boolean
  requires_key?: boolean
  is_configured?: boolean
  priority?: number
  base_url?: string | null
  rate_limit_per_min?: number | null
  last_health_check_at?: string | null
  is_healthy?: boolean | null
  latency_ms?: number | null
  health_message?: string | null
  created_at?: string
  updated_at?: string
}

export type DataIngestionJobRow = {
  id: string
  job_name: string
  provider_id: string | null
  capability: string | null
  status: IngestionJobStatus
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  rows_read: number
  rows_written: number
  rows_skipped: number
  error_count: number
  error_message: string | null
  cursor_state: Json
  run_key: string | null
  created_at: string
}
export type DataIngestionJobInsert = {
  id?: string
  job_name: string
  provider_id?: string | null
  capability?: string | null
  status?: IngestionJobStatus
  started_at?: string
  finished_at?: string | null
  duration_ms?: number | null
  rows_read?: number
  rows_written?: number
  rows_skipped?: number
  error_count?: number
  error_message?: string | null
  cursor_state?: Json
  run_key?: string | null
  created_at?: string
}

export type DataQualitySnapshotRow = {
  id: string
  domain: string
  subject: string | null
  score: number
  components: Json
  stale_capabilities: string[]
  missing_capabilities: string[]
  worst_capability: string | null
  data_mode: DataModeDb
  measured_at: string
  created_at: string
}
export type DataQualitySnapshotInsert = {
  id?: string
  domain: string
  subject?: string | null
  score: number
  components?: Json
  stale_capabilities?: string[]
  missing_capabilities?: string[]
  worst_capability?: string | null
  data_mode: DataModeDb
  measured_at?: string
  created_at?: string
}

export type EventRow = {
  id: string
  event_type: VixeraEventType
  status: EventStatus
  domain: string | null
  subject: string | null
  payload: Json
  dedupe_key: string | null
  occurred_at: string
  processed_at: string | null
  attempts: number
  last_error: string | null
  created_at: string
}
export type EventInsert = {
  id?: string
  event_type: VixeraEventType
  status?: EventStatus
  domain?: string | null
  subject?: string | null
  payload?: Json
  dedupe_key?: string | null
  occurred_at?: string
  processed_at?: string | null
  attempts?: number
  last_error?: string | null
  created_at?: string
}

// ===========================================================================
// 0002_prediction_core
// ===========================================================================

/** Shape of one element of predictions.outcomes / prediction_model_outputs.outcomes. */
export type OutcomeJson = {
  key: string
  label: string
  probability: number
}

/** Shape of one element of predictions.scenarios. */
export type ScenarioJson = {
  key: 'bull' | 'base' | 'bear'
  label: string
  probability: number
  targetLow: number
  targetHigh: number
}

/** Shape of predictions.volatility. */
export type VolatilityJson = {
  expectedMove: number
  regime: 'low' | 'normal' | 'elevated' | 'extreme'
  rangeLow: number
  rangeHigh: number
  confidence: number
}

export type ModelRow = {
  id: string
  model_id: string
  domain: PredictionDomain
  kind: ModelKind
  display_name: string
  description: string | null
  is_enabled: boolean
  created_at: string
  updated_at: string
}
export type ModelInsert = {
  id?: string
  model_id: string
  domain: PredictionDomain
  kind: ModelKind
  display_name: string
  description?: string | null
  is_enabled?: boolean
  created_at?: string
  updated_at?: string
}

export type ModelVersionRow = {
  id: string
  model_uuid: string
  version: string
  config: Json
  is_active: boolean
  promoted_at: string | null
  promoted_by: string | null
  notes: string | null
  created_at: string
}
export type ModelVersionInsert = {
  id?: string
  model_uuid: string
  version: string
  config?: Json
  is_active?: boolean
  promoted_at?: string | null
  promoted_by?: string | null
  notes?: string | null
  created_at?: string
}

export type ModelFeatureRow = {
  id: string
  model_version_id: string
  feature_key: string
  description: string | null
  transform: string | null
  importance: number | null
  is_required: boolean
  created_at: string
}
export type ModelFeatureInsert = {
  id?: string
  model_version_id: string
  feature_key: string
  description?: string | null
  transform?: string | null
  importance?: number | null
  is_required?: boolean
  created_at?: string
}

export type TrainingRunRow = {
  id: string
  model_version_id: string
  status: TrainingRunStatus
  started_at: string
  finished_at: string | null
  dataset_from: string | null
  dataset_to: string | null
  sample_size: number | null
  metrics: Json
  notes: string | null
  created_at: string
}
export type TrainingRunInsert = {
  id?: string
  model_version_id: string
  status?: TrainingRunStatus
  started_at?: string
  finished_at?: string | null
  dataset_from?: string | null
  dataset_to?: string | null
  sample_size?: number | null
  metrics?: Json
  notes?: string | null
  created_at?: string
}

export type PredictionRunRow = {
  id: string
  trigger_type: VixeraEventType
  event_id: string | null
  domain: PredictionDomain
  model_version: string
  started_at: string
  finished_at: string | null
  subject_count: number
  error_count: number
  is_backtest: boolean
  as_of: string | null
  created_at: string
}
export type PredictionRunInsert = {
  id?: string
  trigger_type?: VixeraEventType
  event_id?: string | null
  domain: PredictionDomain
  model_version: string
  started_at?: string
  finished_at?: string | null
  subject_count?: number
  error_count?: number
  is_backtest?: boolean
  as_of?: string | null
  created_at?: string
}

export type PredictionRow = {
  id: string
  org_id: string
  prediction_run_id: string | null
  domain: PredictionDomain
  subject: string
  subject_label: string
  timeframe: PredictionTimeframe
  outcomes: OutcomeJson[]
  leading_outcome_key: string
  leading_probability: number
  confidence: number
  data_quality: number
  model_agreement: number
  risk_level: RiskLevelDb
  scenarios: ScenarioJson[] | null
  volatility: VolatilityJson | null
  data_mode: DataModeDb
  generated_at: string
  data_timestamp: string
  model_version: string
  disclaimer: string
  outcome_id: string | null
  created_at: string
}
export type PredictionInsert = {
  id?: string
  org_id: string
  prediction_run_id?: string | null
  domain: PredictionDomain
  subject: string
  subject_label: string
  timeframe: PredictionTimeframe
  outcomes: OutcomeJson[]
  leading_outcome_key: string
  leading_probability: number
  confidence: number
  data_quality: number
  model_agreement: number
  risk_level: RiskLevelDb
  scenarios?: ScenarioJson[] | null
  volatility?: VolatilityJson | null
  data_mode: DataModeDb
  generated_at: string
  data_timestamp: string
  model_version: string
  disclaimer: string
  outcome_id?: string | null
  created_at?: string
}

export type PredictionOutcomeRow = {
  id: string
  prediction_id: string
  actual_key: string
  actual_label: string | null
  predicted_probability: number
  was_correct: boolean
  brier_score: number | null
  log_loss: number | null
  settled_at: string
  settled_by: string
  evidence: Json
  created_at: string
}
export type PredictionOutcomeInsert = {
  id?: string
  prediction_id: string
  actual_key: string
  actual_label?: string | null
  predicted_probability: number
  was_correct: boolean
  brier_score?: number | null
  log_loss?: number | null
  settled_at?: string
  settled_by?: string
  evidence?: Json
  created_at?: string
}

export type PredictionFactorRow = {
  id: string
  prediction_id: string
  factor_id: string
  label: string
  polarity: FactorPolarity
  contribution: number | null
  detail: string | null
  evidence_strength: number
  position: number
  created_at: string
}
export type PredictionFactorInsert = {
  id?: string
  prediction_id: string
  factor_id: string
  label: string
  polarity: FactorPolarity
  contribution?: number | null
  detail?: string | null
  evidence_strength: number
  position?: number
  created_at?: string
}

export type PredictionModelOutputRow = {
  id: string
  prediction_id: string
  model_id: string
  model_version: string
  model_version_id: string | null
  abstained: boolean
  abstain_reason: string | null
  outcomes: OutcomeJson[]
  confidence: number
  weight: number
  feature_contributions: Json
  created_at: string
}
export type PredictionModelOutputInsert = {
  id?: string
  prediction_id: string
  model_id: string
  model_version: string
  model_version_id?: string | null
  abstained?: boolean
  abstain_reason?: string | null
  outcomes: OutcomeJson[]
  confidence: number
  weight: number
  feature_contributions?: Json
  created_at?: string
}

export type PredictionSourceRow = {
  id: string
  prediction_id: string
  provider_id: string
  capability: string
  reliability: ReliabilityClassDb
  fetched_at: string
  data_as_of: string
  is_demo: boolean
  created_at: string
}
export type PredictionSourceInsert = {
  id?: string
  prediction_id: string
  provider_id: string
  capability: string
  reliability: ReliabilityClassDb
  fetched_at: string
  data_as_of: string
  is_demo?: boolean
  created_at?: string
}

export type PredictionHistoryRow = {
  id: string
  org_id: string
  prediction_id: string | null
  domain: PredictionDomain
  subject: string
  timeframe: PredictionTimeframe
  outcome_key: string
  probability: number
  previous_probability: number | null
  confidence: number
  data_quality: number
  event_type: VixeraEventType
  event_id: string | null
  delta: Json
  recorded_at: string
  created_at: string
}
export type PredictionHistoryInsert = {
  id?: string
  org_id: string
  prediction_id?: string | null
  domain: PredictionDomain
  subject: string
  timeframe: PredictionTimeframe
  outcome_key: string
  probability: number
  previous_probability?: number | null
  confidence: number
  data_quality: number
  event_type?: VixeraEventType
  event_id?: string | null
  delta?: Json
  recorded_at?: string
  created_at?: string
}

export type ModelMetricRow = {
  id: string
  model_uuid: string | null
  model_version_id: string | null
  domain: PredictionDomain
  timeframe: PredictionTimeframe | null
  window_start: string
  window_end: string
  sample_size: number
  brier_score: number | null
  brier_skill_score: number | null
  log_loss: number | null
  accuracy: number | null
  calibration_ece: number | null
  calibration_mce: number | null
  computed_at: string
  created_at: string
}
export type ModelMetricInsert = {
  id?: string
  model_uuid?: string | null
  model_version_id?: string | null
  domain: PredictionDomain
  timeframe?: PredictionTimeframe | null
  window_start: string
  window_end: string
  sample_size: number
  brier_score?: number | null
  brier_skill_score?: number | null
  log_loss?: number | null
  accuracy?: number | null
  calibration_ece?: number | null
  calibration_mce?: number | null
  computed_at?: string
  created_at?: string
}

export type CalibrationBinRow = {
  id: string
  model_version_id: string | null
  domain: PredictionDomain
  timeframe: PredictionTimeframe | null
  bin_lower: number
  bin_upper: number
  sample_count: number
  mean_predicted: number
  observed_frequency: number
  computed_at: string
  created_at: string
}
export type CalibrationBinInsert = {
  id?: string
  model_version_id?: string | null
  domain: PredictionDomain
  timeframe?: PredictionTimeframe | null
  bin_lower: number
  bin_upper: number
  sample_count: number
  mean_predicted: number
  observed_frequency: number
  computed_at?: string
  created_at?: string
}

// ===========================================================================
// 0003_sports
// ===========================================================================

export type SportRow = {
  id: string
  key: string
  name: string
  is_enabled: boolean
  created_at: string
}
export type SportInsert = {
  id?: string
  key: string
  name: string
  is_enabled?: boolean
  created_at?: string
}

export type LeagueRow = {
  id: string
  sport_id: string
  provider_id: string
  external_id: string
  name: string
  country: string | null
  tier: number | null
  current_season: string | null
  is_tracked: boolean
  created_at: string
  updated_at: string
}
export type LeagueInsert = {
  id?: string
  sport_id: string
  provider_id: string
  external_id: string
  name: string
  country?: string | null
  tier?: number | null
  current_season?: string | null
  is_tracked?: boolean
  created_at?: string
  updated_at?: string
}

export type SeasonRow = {
  id: string
  league_id: string
  label: string
  start_date: string | null
  end_date: string | null
  is_current: boolean
  created_at: string
}
export type SeasonInsert = {
  id?: string
  league_id: string
  label: string
  start_date?: string | null
  end_date?: string | null
  is_current?: boolean
  created_at?: string
}

export type TeamRow = {
  id: string
  sport_id: string
  league_id: string | null
  provider_id: string
  external_id: string
  name: string
  short_name: string | null
  country: string | null
  crest_url: string | null
  founded: number | null
  created_at: string
  updated_at: string
}
export type TeamInsert = {
  id?: string
  sport_id: string
  league_id?: string | null
  provider_id: string
  external_id: string
  name: string
  short_name?: string | null
  country?: string | null
  crest_url?: string | null
  founded?: number | null
  created_at?: string
  updated_at?: string
}

export type PlayerRow = {
  id: string
  team_id: string | null
  provider_id: string
  external_id: string
  name: string
  position: string | null
  birth_date: string | null
  nationality: string | null
  shirt_number: number | null
  created_at: string
  updated_at: string
}
export type PlayerInsert = {
  id?: string
  team_id?: string | null
  provider_id: string
  external_id: string
  name: string
  position?: string | null
  birth_date?: string | null
  nationality?: string | null
  shirt_number?: number | null
  created_at?: string
  updated_at?: string
}

export type GameRow = {
  id: string
  league_id: string
  season_id: string | null
  provider_id: string
  external_id: string
  kickoff: string
  status: GameStatusDb
  home_team_id: string
  away_team_id: string
  home_score: number | null
  away_score: number | null
  matchday: number | null
  venue: string | null
  attendance: number | null
  finished_at: string | null
  created_at: string
  updated_at: string
}
export type GameInsert = {
  id?: string
  league_id: string
  season_id?: string | null
  provider_id: string
  external_id: string
  kickoff: string
  status?: GameStatusDb
  home_team_id: string
  away_team_id: string
  home_score?: number | null
  away_score?: number | null
  matchday?: number | null
  venue?: string | null
  attendance?: number | null
  finished_at?: string | null
  created_at?: string
  updated_at?: string
}

export type TeamSeasonStatsRow = {
  id: string
  team_id: string
  season_id: string
  played: number
  won: number
  drawn: number
  lost: number
  goals_for: number
  goals_against: number
  points: number
  table_position: number | null
  xg_for: number | null
  xg_against: number | null
  updated_at: string
  created_at: string
}
export type TeamSeasonStatsInsert = {
  id?: string
  team_id: string
  season_id: string
  played?: number
  won?: number
  drawn?: number
  lost?: number
  goals_for?: number
  goals_against?: number
  points?: number
  table_position?: number | null
  xg_for?: number | null
  xg_against?: number | null
  updated_at?: string
  created_at?: string
}

export type TeamGameStatsRow = {
  id: string
  game_id: string
  team_id: string
  is_home: boolean
  scored: number
  conceded: number
  result: GameResult
  shots: number | null
  shots_on_target: number | null
  possession: number | null
  xg_for: number | null
  xg_against: number | null
  extra: Json
  created_at: string
}
export type TeamGameStatsInsert = {
  id?: string
  game_id: string
  team_id: string
  is_home: boolean
  scored: number
  conceded: number
  result: GameResult
  shots?: number | null
  shots_on_target?: number | null
  possession?: number | null
  xg_for?: number | null
  xg_against?: number | null
  extra?: Json
  created_at?: string
}

export type PlayerGameStatsRow = {
  id: string
  game_id: string
  player_id: string
  team_id: string
  minutes: number | null
  started: boolean | null
  goals: number | null
  assists: number | null
  shots: number | null
  rating: number | null
  extra: Json
  created_at: string
}
export type PlayerGameStatsInsert = {
  id?: string
  game_id: string
  player_id: string
  team_id: string
  minutes?: number | null
  started?: boolean | null
  goals?: number | null
  assists?: number | null
  shots?: number | null
  rating?: number | null
  extra?: Json
  created_at?: string
}

export type InjuryRow = {
  id: string
  player_id: string
  team_id: string
  status: InjuryStatusDb
  reason: string | null
  reported_at: string
  expected_return: string | null
  provider_id: string
  is_active: boolean
  created_at: string
}
export type InjuryInsert = {
  id?: string
  player_id: string
  team_id: string
  status: InjuryStatusDb
  reason?: string | null
  reported_at: string
  expected_return?: string | null
  provider_id: string
  is_active?: boolean
  created_at?: string
}

/** One element of lineups.players — mirrors LineupPlayer in providers/types.ts. */
export type LineupPlayerJson = {
  playerId: string
  playerName: string
  position: string | null
  isStarter: boolean
}

export type LineupRow = {
  id: string
  game_id: string
  team_id: string
  confirmed: boolean
  formation: string | null
  players: LineupPlayerJson[]
  fetched_at: string
  created_at: string
}
export type LineupInsert = {
  id?: string
  game_id: string
  team_id: string
  confirmed?: boolean
  formation?: string | null
  players?: LineupPlayerJson[]
  fetched_at?: string
  created_at?: string
}

export type H2hCacheRow = {
  id: string
  team_a_id: string
  team_b_id: string
  sample_size: number
  payload: Json
  computed_at: string
  expires_at: string
  created_at: string
}
export type H2hCacheInsert = {
  id?: string
  team_a_id: string
  team_b_id: string
  sample_size?: number
  payload?: Json
  computed_at?: string
  expires_at: string
  created_at?: string
}

export type TeamRatingRow = {
  id: string
  team_id: string
  system: RatingSystem
  as_of: string
  rating: number
  rating_deviation: number | null
  components: Json
  game_id: string | null
  model_version: string
  created_at: string
}
export type TeamRatingInsert = {
  id?: string
  team_id: string
  system: RatingSystem
  as_of: string
  rating: number
  rating_deviation?: number | null
  components?: Json
  game_id?: string | null
  model_version: string
  created_at?: string
}

// ===========================================================================
// 0004_crypto
// ===========================================================================

export type AssetRow = {
  id: string
  asset_class: AssetClass
  symbol: string
  name: string
  is_tracked: boolean
  created_at: string
  updated_at: string
}
export type AssetInsert = {
  id?: string
  asset_class: AssetClass
  symbol: string
  name: string
  is_tracked?: boolean
  created_at?: string
  updated_at?: string
}

export type CryptoAssetRow = {
  id: string
  asset_id: string
  coingecko_id: string | null
  binance_symbol: string | null
  contract_addresses: Json
  circulating_supply: number | null
  max_supply: number | null
  market_cap_rank: number | null
  genesis_date: string | null
  created_at: string
  updated_at: string
}
export type CryptoAssetInsert = {
  id?: string
  asset_id: string
  coingecko_id?: string | null
  binance_symbol?: string | null
  contract_addresses?: Json
  circulating_supply?: number | null
  max_supply?: number | null
  market_cap_rank?: number | null
  genesis_date?: string | null
  created_at?: string
  updated_at?: string
}

export type CryptoPriceRow = {
  id: string
  asset_id: string
  ts: string
  price: number
  volume_24h: number | null
  quote_volume_24h: number | null
  change_24h_pct: number | null
  high_24h: number | null
  low_24h: number | null
  market_cap: number | null
  source_provider_id: string
  created_at: string
}
export type CryptoPriceInsert = {
  id?: string
  asset_id: string
  ts: string
  price: number
  volume_24h?: number | null
  quote_volume_24h?: number | null
  change_24h_pct?: number | null
  high_24h?: number | null
  low_24h?: number | null
  market_cap?: number | null
  source_provider_id: string
  created_at?: string
}

export type CryptoCandleRow = {
  asset_id: string
  interval: CandleIntervalDb
  open_time: string
  close_time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  quote_volume: number | null
  trades: number | null
  taker_buy_volume: number | null
  is_closed: boolean
  source_provider_id: string
  created_at: string
}
export type CryptoCandleInsert = {
  asset_id: string
  interval: CandleIntervalDb
  open_time: string
  close_time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  quote_volume?: number | null
  trades?: number | null
  taker_buy_volume?: number | null
  is_closed?: boolean
  source_provider_id: string
  created_at?: string
}

export type CryptoIndicatorRow = {
  id: string
  asset_id: string
  interval: CandleIntervalDb
  ts: string
  indicator_key: string
  value: number | null
  normalized: number | null
  params: Json
  computed_at: string
  created_at: string
}
export type CryptoIndicatorInsert = {
  id?: string
  asset_id: string
  interval: CandleIntervalDb
  ts: string
  indicator_key: string
  value?: number | null
  normalized?: number | null
  params?: Json
  computed_at?: string
  created_at?: string
}

/** One element of crypto_orderbook_snapshots.bids / .asks. */
export type OrderBookLevelJson = {
  price: number
  quantity: number
}

export type CryptoOrderbookSnapshotRow = {
  id: string
  asset_id: string
  ts: string
  venue: string
  bids: OrderBookLevelJson[]
  asks: OrderBookLevelJson[]
  mid_price: number | null
  spread_bps: number | null
  bid_depth_quote: number | null
  ask_depth_quote: number | null
  imbalance: number | null
  source_provider_id: string
  created_at: string
}
export type CryptoOrderbookSnapshotInsert = {
  id?: string
  asset_id: string
  ts: string
  venue: string
  bids: OrderBookLevelJson[]
  asks: OrderBookLevelJson[]
  mid_price?: number | null
  spread_bps?: number | null
  bid_depth_quote?: number | null
  ask_depth_quote?: number | null
  imbalance?: number | null
  source_provider_id: string
  created_at?: string
}

export type CryptoOnchainMetricRow = {
  id: string
  asset_id: string
  ts: string
  metric_key: string
  value: number
  unit: string | null
  source_provider_id: string
  created_at: string
}
export type CryptoOnchainMetricInsert = {
  id?: string
  asset_id: string
  ts: string
  metric_key: string
  value: number
  unit?: string | null
  source_provider_id: string
  created_at?: string
}

export type CryptoDerivativeRow = {
  id: string
  asset_id: string
  venue: string
  ts: string
  funding_rate: number | null
  next_funding_time: string | null
  open_interest: number | null
  open_interest_value: number | null
  long_short_ratio: number | null
  liquidations_long_usd: number | null
  liquidations_short_usd: number | null
  source_provider_id: string
  created_at: string
}
export type CryptoDerivativeInsert = {
  id?: string
  asset_id: string
  venue: string
  ts: string
  funding_rate?: number | null
  next_funding_time?: string | null
  open_interest?: number | null
  open_interest_value?: number | null
  long_short_ratio?: number | null
  liquidations_long_usd?: number | null
  liquidations_short_usd?: number | null
  source_provider_id: string
  created_at?: string
}

// ===========================================================================
// 0005_news
// ===========================================================================

export type NewsSourceRow = {
  id: string
  provider_id: string
  external_id: string
  name: string
  homepage_url: string | null
  feed_url: string | null
  reliability: ReliabilityClassDb
  country: string | null
  language: string
  is_enabled: boolean
  created_at: string
  updated_at: string
}
export type NewsSourceInsert = {
  id?: string
  provider_id: string
  external_id: string
  name: string
  homepage_url?: string | null
  feed_url?: string | null
  reliability?: ReliabilityClassDb
  country?: string | null
  language?: string
  is_enabled?: boolean
  created_at?: string
  updated_at?: string
}

export type NewsArticleRow = {
  id: string
  source_id: string
  external_id: string
  url: string
  url_hash: string
  title: string
  author: string | null
  published_at: string
  fetched_at: string
  summary: string | null
  body: string | null
  category: string | null
  image_url: string | null
  language: string
  simhash: number | null
  created_at: string
  /** Generated column — never write it. */
  search_tsv: string | null
  /**
   * Only present when pgvector is installed (see 0001/0005). PostgREST returns
   * it as a string like '[0.1,0.2,...]'; parse at the repository boundary.
   */
  embedding?: string | null
}
export type NewsArticleInsert = {
  id?: string
  source_id: string
  external_id: string
  url: string
  url_hash: string
  title: string
  author?: string | null
  published_at: string
  fetched_at?: string
  summary?: string | null
  body?: string | null
  category?: string | null
  image_url?: string | null
  language?: string
  simhash?: number | null
  created_at?: string
  embedding?: string | null
}

export type NewsEventRow = {
  id: string
  cluster_key: string
  title: string
  summary: string | null
  category: string | null
  status: NewsEventStatus
  merged_into_id: string | null
  first_seen_at: string
  last_seen_at: string
  article_count: number
  independent_source_count: number
  highest_reliability: ReliabilityClassDb | null
  importance: number | null
  is_breaking: boolean
  velocity: number | null
  created_at: string
  updated_at: string
  centroid?: string | null
}
export type NewsEventInsert = {
  id?: string
  cluster_key: string
  title: string
  summary?: string | null
  category?: string | null
  status?: NewsEventStatus
  merged_into_id?: string | null
  first_seen_at: string
  last_seen_at: string
  article_count?: number
  independent_source_count?: number
  highest_reliability?: ReliabilityClassDb | null
  importance?: number | null
  is_breaking?: boolean
  velocity?: number | null
  created_at?: string
  updated_at?: string
  centroid?: string | null
}

export type NewsEventArticleRow = {
  event_id: string
  article_id: string
  similarity: number | null
  is_seed: boolean
  added_at: string
  created_at: string
}
export type NewsEventArticleInsert = {
  event_id: string
  article_id: string
  similarity?: number | null
  is_seed?: boolean
  added_at?: string
  created_at?: string
}

export type NewsEntityRow = {
  id: string
  entity_key: string
  entity_type: NewsEntityType
  display_name: string
  aliases: string[]
  asset_id: string | null
  team_id: string | null
  importance: number | null
  created_at: string
  updated_at: string
}
export type NewsEntityInsert = {
  id?: string
  entity_key: string
  entity_type: NewsEntityType
  display_name: string
  aliases?: string[]
  asset_id?: string | null
  team_id?: string | null
  importance?: number | null
  created_at?: string
  updated_at?: string
}

export type NewsArticleEntityRow = {
  article_id: string
  entity_id: string
  relevance: number
  mention_count: number
  is_primary: boolean
  created_at: string
}
export type NewsArticleEntityInsert = {
  article_id: string
  entity_id: string
  relevance?: number
  mention_count?: number
  is_primary?: boolean
  created_at?: string
}

export type NewsEntitySentimentRow = {
  id: string
  entity_id: string
  article_id: string | null
  event_id: string | null
  sentiment: number
  magnitude: number
  rationale: string | null
  model_version: string
  computed_at: string
  created_at: string
}
export type NewsEntitySentimentInsert = {
  id?: string
  entity_id: string
  article_id?: string | null
  event_id?: string | null
  sentiment: number
  magnitude?: number
  rationale?: string | null
  model_version: string
  computed_at?: string
  created_at?: string
}

export type EntityGraphNodeRow = {
  id: string
  entity_id: string
  weight: number
  degree: number
  metadata: Json
  updated_at: string
  created_at: string
}
export type EntityGraphNodeInsert = {
  id?: string
  entity_id: string
  weight?: number
  degree?: number
  metadata?: Json
  updated_at?: string
  created_at?: string
}

export type EntityGraphEdgeRow = {
  source_node_id: string
  target_node_id: string
  relation: string
  weight: number
  evidence_count: number
  first_seen_at: string
  last_seen_at: string
  created_at: string
}
export type EntityGraphEdgeInsert = {
  source_node_id: string
  target_node_id: string
  relation: string
  weight?: number
  evidence_count?: number
  first_seen_at?: string
  last_seen_at?: string
  created_at?: string
}

// ===========================================================================
// 0006_user_surface
// ===========================================================================

export type WatchlistRow = {
  id: string
  org_id: string
  created_by: string | null
  name: string
  description: string | null
  is_default: boolean
  created_at: string
  updated_at: string
}
export type WatchlistInsert = {
  id?: string
  org_id: string
  created_by?: string | null
  name: string
  description?: string | null
  is_default?: boolean
  created_at?: string
  updated_at?: string
}

export type WatchlistItemRow = {
  id: string
  watchlist_id: string
  org_id: string
  domain: PredictionDomain
  subject: string
  subject_label: string
  position: number
  notes: string | null
  added_by: string | null
  created_at: string
}
export type WatchlistItemInsert = {
  id?: string
  watchlist_id: string
  org_id: string
  domain: PredictionDomain
  subject: string
  subject_label: string
  position?: number
  notes?: string | null
  added_by?: string | null
  created_at?: string
}

export type AlertRow = {
  id: string
  org_id: string
  created_by: string | null
  name: string
  domain: PredictionDomain
  subject: string
  timeframe: PredictionTimeframe | null
  condition: Json
  status: AlertStatus
  channels: NotificationChannel[]
  cooldown_seconds: number
  last_triggered_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}
export type AlertInsert = {
  id?: string
  org_id: string
  created_by?: string | null
  name: string
  domain: PredictionDomain
  subject: string
  timeframe?: PredictionTimeframe | null
  condition: Json
  status?: AlertStatus
  channels?: NotificationChannel[]
  cooldown_seconds?: number
  last_triggered_at?: string | null
  expires_at?: string | null
  created_at?: string
  updated_at?: string
}

export type AlertTriggerRow = {
  id: string
  alert_id: string
  org_id: string
  prediction_id: string | null
  triggered_at: string
  payload: Json
  notified_at: string | null
  created_at: string
}
export type AlertTriggerInsert = {
  id?: string
  alert_id: string
  org_id: string
  prediction_id?: string | null
  triggered_at?: string
  payload?: Json
  notified_at?: string | null
  created_at?: string
}

export type SignalRow = {
  id: string
  org_id: string
  prediction_id: string | null
  domain: PredictionDomain
  subject: string
  subject_label: string
  timeframe: PredictionTimeframe
  direction: SignalDirection
  strength: SignalStrength
  score: number
  confidence: number
  rationale: string | null
  data_mode: DataModeDb
  model_version: string
  generated_at: string
  expires_at: string | null
  created_at: string
}
export type SignalInsert = {
  id?: string
  org_id: string
  prediction_id?: string | null
  domain: PredictionDomain
  subject: string
  subject_label: string
  timeframe: PredictionTimeframe
  direction: SignalDirection
  strength: SignalStrength
  score: number
  confidence: number
  rationale?: string | null
  data_mode: DataModeDb
  model_version: string
  generated_at: string
  expires_at?: string | null
  created_at?: string
}

export type SignalEvidenceRow = {
  id: string
  signal_id: string
  org_id: string
  kind: string
  label: string
  detail: string | null
  weight: number | null
  reference_type: string | null
  reference_id: string | null
  created_at: string
}
export type SignalEvidenceInsert = {
  id?: string
  signal_id: string
  org_id: string
  kind: string
  label: string
  detail?: string | null
  weight?: number | null
  reference_type?: string | null
  reference_id?: string | null
  created_at?: string
}

export type NotificationRow = {
  id: string
  org_id: string
  user_id: string
  channel: NotificationChannel
  status: NotificationStatus
  title: string
  body: string | null
  payload: Json
  alert_trigger_id: string | null
  related_type: string | null
  related_id: string | null
  sent_at: string | null
  read_at: string | null
  error_message: string | null
  dedupe_key: string | null
  created_at: string
}
export type NotificationInsert = {
  id?: string
  org_id: string
  user_id: string
  channel?: NotificationChannel
  status?: NotificationStatus
  title: string
  body?: string | null
  payload?: Json
  alert_trigger_id?: string | null
  related_type?: string | null
  related_id?: string | null
  sent_at?: string | null
  read_at?: string | null
  error_message?: string | null
  dedupe_key?: string | null
  created_at?: string
}

// ===========================================================================
// 0008_prediction_markets
// ===========================================================================

export type PredictionMarketProviderRow = {
  id: string
  provider_id: string
  display_name: string
  reliability: ReliabilityClassDb
  is_demo: boolean
  is_enabled: boolean
  created_at: string
  updated_at: string
}
export type PredictionMarketProviderInsert = {
  id?: string
  provider_id: string
  display_name: string
  reliability: ReliabilityClassDb
  is_demo?: boolean
  is_enabled?: boolean
  created_at?: string
  updated_at?: string
}

export type PredictionMarketRow = {
  id: string
  provider: string
  external_id: string
  ticker: string | null
  title: string
  description: string | null
  category: MarketCategoryDb
  status: MarketStatusDb
  volume: number
  volume_24h: number | null
  liquidity: number | null
  open_interest: number | null
  spread: number | null
  close_time: string | null
  resolution_time: string | null
  resolution_rules: string | null
  url: string | null
  updated_at: string
  created_at: string
}
export type PredictionMarketInsert = {
  id?: string
  provider: string
  external_id: string
  ticker?: string | null
  title: string
  description?: string | null
  category: MarketCategoryDb
  status?: MarketStatusDb
  volume?: number
  volume_24h?: number | null
  liquidity?: number | null
  open_interest?: number | null
  spread?: number | null
  close_time?: string | null
  resolution_time?: string | null
  resolution_rules?: string | null
  url?: string | null
  updated_at?: string
  created_at?: string
}

export type PredictionMarketOutcomeRow = {
  id: string
  market_id: string
  external_outcome_id: string
  name: string
  market_probability: number
  bid: number | null
  ask: number | null
  created_at: string
  updated_at: string
}
export type PredictionMarketOutcomeInsert = {
  id?: string
  market_id: string
  external_outcome_id: string
  name: string
  market_probability: number
  bid?: number | null
  ask?: number | null
  created_at?: string
  updated_at?: string
}

export type PredictionMarketPriceRow = {
  id: string
  market_id: string
  outcome_id: string
  probability: number
  bid: number | null
  ask: number | null
  volume: number | null
  ts: string
  created_at: string
}
export type PredictionMarketPriceInsert = {
  id?: string
  market_id: string
  outcome_id: string
  probability: number
  bid?: number | null
  ask?: number | null
  volume?: number | null
  ts: string
  created_at?: string
}

/** One element of prediction_market_orderbooks.bids / .asks — mirrors MarketOrderBookLevel. */
export type MarketOrderBookLevelJson = {
  price: number
  size: number
}

export type PredictionMarketOrderbookRow = {
  id: string
  market_id: string
  outcome_id: string
  bids: MarketOrderBookLevelJson[]
  asks: MarketOrderBookLevelJson[]
  ts: string
  created_at: string
}
export type PredictionMarketOrderbookInsert = {
  id?: string
  market_id: string
  outcome_id: string
  bids: MarketOrderBookLevelJson[]
  asks: MarketOrderBookLevelJson[]
  ts: string
  created_at?: string
}

export type MarketLinkRow = {
  id: string
  event_key: string
  market_id: string
  confidence: number
  method: MarketLinkMethod
  created_at: string
}
export type MarketLinkInsert = {
  id?: string
  event_key: string
  market_id: string
  confidence: number
  method: MarketLinkMethod
  created_at?: string
}

/** Shape of opportunities.liquidity_detail — the non-column part of LiquidityAssessment. */
export type LiquidityDetailJson = {
  spreadPp: number | null
  depthScore: number | null
  volumeScore: number
  notes: string[]
}

export type OpportunityRow = {
  id: string
  market_id: string
  outcome_id: string
  vixera_probability: number
  market_probability: number
  edge_pp: number
  expected_value: number | null
  confidence: number
  data_quality: number
  model_agreement: number
  liquidity_score: number
  liquidity_grade: LiquidityGradeDb
  liquidity_detail: Json
  resolution_risk: ResolutionRiskLevelDb
  resolution_risk_reasons: Json
  news_risk: number
  hours_to_resolution: number | null
  opportunity_score: number
  action: OpportunityAction
  no_action_reasons: Json
  score_breakdown: Json
  prediction_id: string | null
  data_mode: DataModeDb
  generated_at: string
  created_at: string
}
export type OpportunityInsert = {
  id?: string
  market_id: string
  outcome_id: string
  vixera_probability: number
  market_probability: number
  edge_pp: number
  expected_value?: number | null
  confidence: number
  data_quality: number
  model_agreement: number
  liquidity_score: number
  liquidity_grade: LiquidityGradeDb
  liquidity_detail?: Json
  resolution_risk: ResolutionRiskLevelDb
  resolution_risk_reasons?: Json
  news_risk: number
  hours_to_resolution?: number | null
  opportunity_score: number
  action: OpportunityAction
  no_action_reasons?: Json
  score_breakdown?: Json
  prediction_id?: string | null
  data_mode: DataModeDb
  generated_at: string
  created_at?: string
}

export type TraderRow = {
  id: string
  source: string
  external_id: string
  display_name: string | null
  first_seen: string
  created_at: string
  updated_at: string
}
export type TraderInsert = {
  id?: string
  source: string
  external_id: string
  display_name?: string | null
  first_seen?: string
  created_at?: string
  updated_at?: string
}

export type TraderAccountRow = {
  id: string
  trader_id: string
  venue: string
  external_account_id: string
  label: string | null
  is_primary: boolean
  first_seen: string
  created_at: string
}
export type TraderAccountInsert = {
  id?: string
  trader_id: string
  venue: string
  external_account_id: string
  label?: string | null
  is_primary?: boolean
  first_seen?: string
  created_at?: string
}

export type TraderTradeRow = {
  id: string
  trader_id: string
  external_trade_id: string
  market_id: string | null
  external_market_id: string | null
  outcome_id: string | null
  external_outcome_id: string | null
  side: TradeSideDb
  price: number
  size: number
  ts: string
  created_at: string
}
export type TraderTradeInsert = {
  id?: string
  trader_id: string
  external_trade_id: string
  market_id?: string | null
  external_market_id?: string | null
  outcome_id?: string | null
  external_outcome_id?: string | null
  side?: TradeSideDb
  price: number
  size: number
  ts: string
  created_at?: string
}

export type TraderPositionRow = {
  id: string
  trader_id: string
  market_id: string | null
  external_market_id: string
  outcome_id: string | null
  external_outcome_id: string
  avg_entry_probability: number | null
  size: number
  unrealized_pnl: number | null
  as_of: string
  created_at: string
}
export type TraderPositionInsert = {
  id?: string
  trader_id: string
  market_id?: string | null
  external_market_id: string
  outcome_id?: string | null
  external_outcome_id: string
  avg_entry_probability?: number | null
  size: number
  unrealized_pnl?: number | null
  as_of: string
  created_at?: string
}

export type TraderMetricRow = {
  id: string
  trader_id: string
  window: string
  trades_count: number
  win_rate: number | null
  profit_factor: number | null
  expectancy: number | null
  sharpe: number | null
  sortino: number | null
  max_drawdown: number | null
  consistency: number | null
  reliability: TraderReliability
  computed_at: string
  created_at: string
}
export type TraderMetricInsert = {
  id?: string
  trader_id: string
  window: string
  trades_count: number
  win_rate?: number | null
  profit_factor?: number | null
  expectancy?: number | null
  sharpe?: number | null
  sortino?: number | null
  max_drawdown?: number | null
  consistency?: number | null
  reliability: TraderReliability
  computed_at?: string
  created_at?: string
}

export type TraderSpecializationRow = {
  id: string
  trader_id: string
  category: MarketCategoryDb
  accuracy: number | null
  sample_size: number
  computed_at: string
  created_at: string
}
export type TraderSpecializationInsert = {
  id?: string
  trader_id: string
  category: MarketCategoryDb
  accuracy?: number | null
  sample_size?: number
  computed_at?: string
  created_at?: string
}

export type PaperPortfolioRow = {
  id: string
  org_id: string
  created_by: string | null
  name: string
  description: string | null
  starting_balance: number
  currency: string
  created_at: string
  updated_at: string
}
export type PaperPortfolioInsert = {
  id?: string
  org_id: string
  created_by?: string | null
  name: string
  description?: string | null
  starting_balance?: number
  currency?: string
  created_at?: string
  updated_at?: string
}

export type PaperPositionRow = {
  id: string
  portfolio_id: string
  org_id: string
  market_id: string | null
  outcome_id: string | null
  outcome_name: string
  entry_probability: number
  size: number
  opened_at: string
  closed_at: string | null
  exit_probability: number | null
  result: PaperPositionResult | null
  pnl: number | null
  created_at: string
}
export type PaperPositionInsert = {
  id?: string
  portfolio_id: string
  org_id: string
  market_id?: string | null
  outcome_id?: string | null
  outcome_name: string
  entry_probability: number
  size: number
  opened_at?: string
  closed_at?: string | null
  exit_probability?: number | null
  result?: PaperPositionResult | null
  pnl?: number | null
  created_at?: string
}

// ===========================================================================
// 0007_rls — predictions_public view
// ===========================================================================

/** Element of predictions_public.factors. */
export type PublicFactorJson = {
  id: string
  label: string
  polarity: FactorPolarity
  contribution: number | null
  detail: string | null
  evidenceStrength: number
}

/** Element of predictions_public.sources. */
export type PublicSourceJson = {
  providerId: string
  capability: string
  reliability: ReliabilityClassDb
  fetchedAt: string
  dataAsOf: string
  isDemo: boolean
}

/**
 * Tier-safe projection of a prediction. Deliberately has no model_outputs
 * field: raw per-model probabilities are a Pro+ entitlement and are not
 * reachable through this view at all.
 */
export type PredictionsPublicRow = {
  id: string
  domain: PredictionDomain
  subject: string
  subject_label: string
  timeframe: PredictionTimeframe
  outcomes: OutcomeJson[]
  leading_outcome_key: string
  leading_probability: number
  confidence: number
  data_quality: number
  model_agreement: number
  risk_level: RiskLevelDb
  scenarios: ScenarioJson[] | null
  volatility: VolatilityJson | null
  data_mode: DataModeDb
  generated_at: string
  data_timestamp: string
  model_version: string
  disclaimer: string
  outcome_id: string | null
  created_at: string
  factors: PublicFactorJson[]
  sources: PublicSourceJson[]
  model_count: number
}

// ===========================================================================
// The Database interface consumed by @supabase/supabase-js
// ===========================================================================

export type Database = {
  public: {
    Tables: {
      // 0001_foundation
      organizations: TableDef<OrganizationRow, OrganizationInsert>
      org_members: TableDef<OrgMemberRow, OrgMemberInsert>
      user_profiles: TableDef<UserProfileRow, UserProfileInsert>
      subscriptions: TableDef<SubscriptionRow, SubscriptionInsert>
      feature_flags: TableDef<FeatureFlagRow, FeatureFlagInsert>
      audit_logs: TableDef<AuditLogRow, AuditLogInsert>
      data_providers: TableDef<DataProviderRow, DataProviderInsert>
      data_ingestion_jobs: TableDef<DataIngestionJobRow, DataIngestionJobInsert>
      data_quality_snapshots: TableDef<DataQualitySnapshotRow, DataQualitySnapshotInsert>
      events: TableDef<EventRow, EventInsert>
      // 0002_prediction_core
      models: TableDef<ModelRow, ModelInsert>
      model_versions: TableDef<ModelVersionRow, ModelVersionInsert>
      model_features: TableDef<ModelFeatureRow, ModelFeatureInsert>
      training_runs: TableDef<TrainingRunRow, TrainingRunInsert>
      prediction_runs: TableDef<PredictionRunRow, PredictionRunInsert>
      predictions: TableDef<PredictionRow, PredictionInsert>
      prediction_outcomes: TableDef<PredictionOutcomeRow, PredictionOutcomeInsert>
      prediction_factors: TableDef<PredictionFactorRow, PredictionFactorInsert>
      prediction_model_outputs: TableDef<PredictionModelOutputRow, PredictionModelOutputInsert>
      prediction_sources: TableDef<PredictionSourceRow, PredictionSourceInsert>
      prediction_history: TableDef<PredictionHistoryRow, PredictionHistoryInsert>
      model_metrics: TableDef<ModelMetricRow, ModelMetricInsert>
      calibration_bins: TableDef<CalibrationBinRow, CalibrationBinInsert>
      // 0003_sports
      sports: TableDef<SportRow, SportInsert>
      leagues: TableDef<LeagueRow, LeagueInsert>
      seasons: TableDef<SeasonRow, SeasonInsert>
      teams: TableDef<TeamRow, TeamInsert>
      players: TableDef<PlayerRow, PlayerInsert>
      games: TableDef<GameRow, GameInsert>
      team_season_stats: TableDef<TeamSeasonStatsRow, TeamSeasonStatsInsert>
      team_game_stats: TableDef<TeamGameStatsRow, TeamGameStatsInsert>
      player_game_stats: TableDef<PlayerGameStatsRow, PlayerGameStatsInsert>
      injuries: TableDef<InjuryRow, InjuryInsert>
      lineups: TableDef<LineupRow, LineupInsert>
      h2h_cache: TableDef<H2hCacheRow, H2hCacheInsert>
      team_ratings: TableDef<TeamRatingRow, TeamRatingInsert>
      // 0004_crypto
      assets: TableDef<AssetRow, AssetInsert>
      crypto_assets: TableDef<CryptoAssetRow, CryptoAssetInsert>
      crypto_prices: TableDef<CryptoPriceRow, CryptoPriceInsert>
      crypto_candles: TableDef<CryptoCandleRow, CryptoCandleInsert>
      crypto_indicators: TableDef<CryptoIndicatorRow, CryptoIndicatorInsert>
      crypto_orderbook_snapshots: TableDef<CryptoOrderbookSnapshotRow, CryptoOrderbookSnapshotInsert>
      crypto_onchain_metrics: TableDef<CryptoOnchainMetricRow, CryptoOnchainMetricInsert>
      crypto_derivatives: TableDef<CryptoDerivativeRow, CryptoDerivativeInsert>
      // 0005_news
      news_sources: TableDef<NewsSourceRow, NewsSourceInsert>
      news_articles: TableDef<NewsArticleRow, NewsArticleInsert>
      news_events: TableDef<NewsEventRow, NewsEventInsert>
      news_event_articles: TableDef<NewsEventArticleRow, NewsEventArticleInsert>
      news_entities: TableDef<NewsEntityRow, NewsEntityInsert>
      news_article_entities: TableDef<NewsArticleEntityRow, NewsArticleEntityInsert>
      news_entity_sentiment: TableDef<NewsEntitySentimentRow, NewsEntitySentimentInsert>
      entity_graph_nodes: TableDef<EntityGraphNodeRow, EntityGraphNodeInsert>
      entity_graph_edges: TableDef<EntityGraphEdgeRow, EntityGraphEdgeInsert>
      // 0006_user_surface
      watchlists: TableDef<WatchlistRow, WatchlistInsert>
      watchlist_items: TableDef<WatchlistItemRow, WatchlistItemInsert>
      alerts: TableDef<AlertRow, AlertInsert>
      alert_triggers: TableDef<AlertTriggerRow, AlertTriggerInsert>
      signals: TableDef<SignalRow, SignalInsert>
      signal_evidence: TableDef<SignalEvidenceRow, SignalEvidenceInsert>
      notifications: TableDef<NotificationRow, NotificationInsert>
      // 0008_prediction_markets
      prediction_market_providers: TableDef<
        PredictionMarketProviderRow,
        PredictionMarketProviderInsert
      >
      prediction_markets: TableDef<PredictionMarketRow, PredictionMarketInsert>
      prediction_market_outcomes: TableDef<
        PredictionMarketOutcomeRow,
        PredictionMarketOutcomeInsert
      >
      prediction_market_prices: TableDef<PredictionMarketPriceRow, PredictionMarketPriceInsert>
      prediction_market_orderbooks: TableDef<
        PredictionMarketOrderbookRow,
        PredictionMarketOrderbookInsert
      >
      market_links: TableDef<MarketLinkRow, MarketLinkInsert>
      opportunities: TableDef<OpportunityRow, OpportunityInsert>
      traders: TableDef<TraderRow, TraderInsert>
      trader_accounts: TableDef<TraderAccountRow, TraderAccountInsert>
      trader_trades: TableDef<TraderTradeRow, TraderTradeInsert>
      trader_positions: TableDef<TraderPositionRow, TraderPositionInsert>
      trader_metrics: TableDef<TraderMetricRow, TraderMetricInsert>
      trader_specializations: TableDef<TraderSpecializationRow, TraderSpecializationInsert>
      paper_portfolios: TableDef<PaperPortfolioRow, PaperPortfolioInsert>
      paper_positions: TableDef<PaperPositionRow, PaperPositionInsert>
    }
    Views: {
      predictions_public: ViewDef<PredictionsPublicRow>
    }
    Functions: {
      current_org_ids: { Args: Record<string, never>; Returns: string[] }
      platform_org_id: { Args: Record<string, never>; Returns: string }
      is_org_admin: { Args: { target_org_id: string }; Returns: boolean }
      current_tier_at_least: { Args: { min_tier: SubscriptionTier }; Returns: boolean }
      can_read_org_row: { Args: { row_org_id: string }; Returns: boolean }
    }
    Enums: {
      subscription_tier: SubscriptionTier
      subscription_status: SubscriptionStatus
      org_role: OrgRole
      reliability_class: ReliabilityClassDb
      data_mode: DataModeDb
      ingestion_job_status: IngestionJobStatus
      vixera_event_type: VixeraEventType
      event_status: EventStatus
      prediction_domain: PredictionDomain
      prediction_timeframe: PredictionTimeframe
      risk_level: RiskLevelDb
      factor_polarity: FactorPolarity
      model_kind: ModelKind
      training_run_status: TrainingRunStatus
      game_status: GameStatusDb
      injury_status: InjuryStatusDb
      game_result: GameResult
      rating_system: RatingSystem
      candle_interval: CandleIntervalDb
      asset_class: AssetClass
      news_event_status: NewsEventStatus
      news_entity_type: NewsEntityType
      alert_status: AlertStatus
      signal_strength: SignalStrength
      signal_direction: SignalDirection
      notification_channel: NotificationChannel
      notification_status: NotificationStatus
      market_category: MarketCategoryDb
      market_status: MarketStatusDb
      liquidity_grade: LiquidityGradeDb
      resolution_risk_level: ResolutionRiskLevelDb
    }
    CompositeTypes: Record<string, never>
  }
}

/** Convenience aliases mirroring the generated-types ergonomics. */
export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row']

export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert']

export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update']

export type Enums<T extends keyof Database['public']['Enums']> = Database['public']['Enums'][T]

/** The fixed uuid of the organisation that owns platform-generated rows. */
export const PLATFORM_ORG_ID = '00000000-0000-0000-0000-000000000001'
