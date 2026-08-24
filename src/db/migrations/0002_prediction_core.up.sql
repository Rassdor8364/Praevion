-- =============================================================================
-- 0002_prediction_core
--
-- The model registry and the persisted form of VixeraPrediction
-- (src/core/prediction/types.ts). One shape for every domain — that is what
-- lets the Command Center, the alert evaluator, the AI Analyst's tools and the
-- performance dashboard each be written once instead of once per domain.
--
-- PREDICTIONS ARE APPEND-ONLY. A prediction row is never rewritten after the
-- fact; settlement writes a separate prediction_outcomes row and links to it.
-- The accuracy record is only meaningful if failed predictions survive intact.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums (created before first use)
-- -----------------------------------------------------------------------------

-- Mirrors Domain in src/core/prediction/types.ts.
create type prediction_domain as enum ('sports', 'crypto', 'stocks', 'forex', 'events');

-- Mirrors Timeframe. Timeframes are never mixed: each is an independent
-- prediction with its own feature window, weights, calibration curve and
-- accuracy record (§10).
create type prediction_timeframe as enum ('15m', '1h', '4h', '24h', '7d', '30d', 'event');

-- Mirrors RiskLevel.
create type risk_level as enum ('low', 'medium', 'high', 'extreme');

-- VixeraPrediction splits factors into supportingFactors / opposingFactors.
-- Storing polarity as a column keeps a single child table and lets the UI
-- reassemble both lists with one indexed read.
create type factor_polarity as enum ('supporting', 'opposing');

create type model_kind as enum ('statistical', 'machine_learning', 'heuristic', 'ensemble', 'calibrator');

create type training_run_status as enum ('running', 'succeeded', 'failed', 'aborted');

-- -----------------------------------------------------------------------------
-- models
-- -----------------------------------------------------------------------------
create table models (
  id           uuid primary key default gen_random_uuid(),
  model_id     text not null unique,
  domain       prediction_domain not null,
  kind         model_kind not null,
  display_name text not null,
  description  text,
  is_enabled   boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger models_set_updated_at
  before update on models
  for each row execute function set_updated_at();

comment on table models is
  'One row per model in the ensemble (e.g. crypto.momentum, sports.dixon_coles). The registry is data, not code, so a model can be disabled without a deploy.';
comment on column models.model_id is
  'Stable dotted key used by the engines and echoed into prediction_model_outputs.model_id.';

-- -----------------------------------------------------------------------------
-- model_versions
-- -----------------------------------------------------------------------------
create table model_versions (
  id            uuid primary key default gen_random_uuid(),
  model_uuid    uuid not null references models(id) on delete cascade,
  version       text not null,
  config        jsonb not null default '{}'::jsonb,
  is_active     boolean not null default false,
  promoted_at   timestamptz,
  promoted_by   uuid,
  notes         text,
  created_at    timestamptz not null default now(),
  unique (model_uuid, version)
);

-- Exactly one active version per model; promotion is an atomic swap.
create unique index model_versions_one_active_uidx
  on model_versions (model_uuid)
  where is_active;

comment on table model_versions is
  'Immutable version of a model together with the exact config that produced it. Changing a weight in engines/*/config produces a NEW version rather than mutating an old one, so historical predictions remain attributable.';

-- -----------------------------------------------------------------------------
-- model_features
-- -----------------------------------------------------------------------------
create table model_features (
  id               uuid primary key default gen_random_uuid(),
  model_version_id uuid not null references model_versions(id) on delete cascade,
  feature_key      text not null,
  description      text,
  transform        text,
  importance       numeric(8, 6),
  is_required      boolean not null default false,
  created_at       timestamptz not null default now(),
  unique (model_version_id, feature_key)
);

comment on column model_features.is_required is
  'When a required feature is missing the model ABSTAINS. Abstention removes the model from the pool; it is not a neutral 50% vote (§8.2).';

-- -----------------------------------------------------------------------------
-- training_runs
-- -----------------------------------------------------------------------------
create table training_runs (
  id               uuid primary key default gen_random_uuid(),
  model_version_id uuid not null references model_versions(id) on delete cascade,
  status           training_run_status not null default 'running',
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  dataset_from     timestamptz,
  dataset_to       timestamptz,
  sample_size      integer,
  metrics          jsonb not null default '{}'::jsonb,
  notes            text,
  created_at       timestamptz not null default now(),
  constraint training_runs_window_order check (
    dataset_to is null or dataset_from is null or dataset_to >= dataset_from
  )
);

comment on column training_runs.dataset_to is
  'Upper bound of the training window. The backtest leakage guard asserts every feature timestamp is strictly below the prediction timestamp; this column is what makes that assertion auditable after the fact.';

-- -----------------------------------------------------------------------------
-- prediction_runs
-- -----------------------------------------------------------------------------
create table prediction_runs (
  id            uuid primary key default gen_random_uuid(),
  trigger_type  vixera_event_type not null default 'SCHEDULED',
  event_id      uuid references events(id) on delete set null,
  domain        prediction_domain not null,
  model_version text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  subject_count integer not null default 0,
  error_count   integer not null default 0,
  is_backtest   boolean not null default false,
  as_of         timestamptz,
  created_at    timestamptz not null default now()
);

create index prediction_runs_domain_started_idx on prediction_runs (domain, started_at desc);

comment on column prediction_runs.as_of is
  'Point-in-time instant the run was replayed at. NULL for live runs. A backtest run MUST set this and MUST set is_backtest, because backtested output may never be mixed into the live accuracy record (§18-R6).';

-- -----------------------------------------------------------------------------
-- predictions  — the persisted VixeraPrediction
-- -----------------------------------------------------------------------------
create table predictions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  prediction_run_id  uuid references prediction_runs(id) on delete set null,

  domain             prediction_domain not null,
  subject            text not null,
  subject_label      text not null,
  timeframe          prediction_timeframe not null,

  -- The full outcome distribution, exactly as produced:
  -- [{ "key": "home", "label": "Arsenal", "probability": 0.412 }, ...]
  -- Kept as jsonb because it is always read and written as a whole and its
  -- cardinality varies by domain (2 for up/down, 3 for 1X2, N for correct
  -- score). The leading outcome is denormalised out for indexing.
  outcomes           jsonb not null check (jsonb_typeof(outcomes) = 'array' and jsonb_array_length(outcomes) > 0),
  leading_outcome_key   text not null,
  leading_probability   numeric(7, 6) not null check (leading_probability >= 0 and leading_probability <= 1),

  confidence         numeric(7, 6) not null check (confidence >= 0 and confidence <= 1),
  data_quality       numeric(5, 2) not null check (data_quality >= 0 and data_quality <= 100),
  model_agreement    numeric(7, 6) not null check (model_agreement >= 0 and model_agreement <= 1),
  risk_level         risk_level not null,

  -- Quantile bands of the forecast return distribution, not three hand-written
  -- numbers. NULL when the domain has no scenario concept.
  scenarios          jsonb check (scenarios is null or jsonb_typeof(scenarios) = 'array'),
  -- { expectedMove, regime, rangeLow, rangeHigh, confidence } or NULL.
  volatility         jsonb check (volatility is null or jsonb_typeof(volatility) = 'object'),

  data_mode          data_mode not null,
  generated_at       timestamptz not null,
  data_timestamp     timestamptz not null,
  model_version      text not null,
  disclaimer         text not null,

  -- Settlement link, added as a constraint below (predictions and
  -- prediction_outcomes reference each other).
  outcome_id         uuid,

  created_at         timestamptz not null default now(),

  constraint predictions_data_before_generation
    check (data_timestamp <= generated_at)
);

comment on table predictions is
  'APPEND-ONLY. One row per (subject, timeframe, generation). Rows are never updated to reflect what actually happened — settlement writes prediction_outcomes and sets outcome_id, leaving every original probability byte-for-byte intact. Deleting or amending a wrong prediction would make the published accuracy record a lie.';
comment on column predictions.data_timestamp is
  'The OLDEST contributing input timestamp, not the newest. A prediction is exactly as fresh as its stalest ingredient; taking the newest would let one live tick disguise an hour-old order book.';
comment on column predictions.data_mode is
  'Propagated from the provider registry, never inferred. There is no code path producing live without a live provider having actually answered (§19.1).';
comment on column predictions.leading_probability is
  'Denormalised max(outcomes[].probability) so list screens and alert evaluation can sort/filter without unnesting jsonb.';
comment on column predictions.org_id is
  'Platform-generated predictions are owned by platform_org_id() and readable by every authenticated user; org-specific predictions are private to their org (see 0007).';

-- Ingestion / generation idempotency: re-running the same prediction job for the
-- same subject at the same instant with the same model version is a no-op
-- rather than a duplicate row.
create unique index predictions_natural_uidx
  on predictions (domain, subject, timeframe, model_version, generated_at);

-- Primary read path: "latest predictions for this subject".
create index predictions_domain_subject_generated_idx
  on predictions (domain, subject, generated_at desc);

create index predictions_org_generated_idx on predictions (org_id, generated_at desc);
create index predictions_run_idx on predictions (prediction_run_id);

-- The settlement job (every 10 minutes) scans ONLY unsettled rows. Without the
-- partial predicate this index grows without bound while the working set stays
-- tiny; with it, the index is proportional to the number of open predictions.
create index predictions_unsettled_idx
  on predictions (generated_at)
  where outcome_id is null;

comment on index predictions_unsettled_idx is
  'Partial index driving the outcome-settlement cron. Settled rows leave the index entirely, so its size tracks open predictions rather than total history.';

-- -----------------------------------------------------------------------------
-- prediction_outcomes  — what actually happened
-- -----------------------------------------------------------------------------
create table prediction_outcomes (
  id             uuid primary key default gen_random_uuid(),
  prediction_id  uuid not null references predictions(id) on delete cascade,
  actual_key     text not null,
  actual_label   text,
  -- Probability the model had assigned to the key that actually occurred.
  predicted_probability numeric(7, 6) not null
    check (predicted_probability >= 0 and predicted_probability <= 1),
  was_correct    boolean not null,
  brier_score    numeric(9, 8) check (brier_score >= 0 and brier_score <= 2),
  log_loss       numeric(12, 8) check (log_loss >= 0),
  settled_at     timestamptz not null default now(),
  settled_by     text not null default 'settlement_job',
  evidence       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  unique (prediction_id)
);

comment on table prediction_outcomes is
  'The resolved truth for a prediction. Written once, by the settlement job. The one-to-one unique constraint on prediction_id makes re-running settlement idempotent.';
comment on column prediction_outcomes.brier_score is
  'Multiclass Brier score for this single prediction, bounded [0,2]. Aggregates live in model_metrics.';

-- Close the circular reference now that both tables exist.
alter table predictions
  add constraint predictions_outcome_id_fkey
  foreign key (outcome_id) references prediction_outcomes(id) on delete set null;

-- -----------------------------------------------------------------------------
-- prediction_factors  — normalised PredictionFactor[]
-- -----------------------------------------------------------------------------
create table prediction_factors (
  id                uuid primary key default gen_random_uuid(),
  prediction_id     uuid not null references predictions(id) on delete cascade,
  factor_id         text not null,
  label             text not null,
  polarity          factor_polarity not null,
  -- Signed contribution in probability points toward the leading outcome
  -- (+0.12 = +12pp). NULL when the model genuinely cannot attribute one — the
  -- UI then shows the factor without a number rather than inventing a
  -- plausible-looking percentage (§8.4).
  contribution      numeric(9, 6) check (contribution is null or (contribution >= -1 and contribution <= 1)),
  detail            text,
  evidence_strength numeric(7, 6) not null
                      check (evidence_strength >= 0 and evidence_strength <= 1),
  position          smallint not null default 0,
  created_at        timestamptz not null default now(),
  unique (prediction_id, polarity, factor_id)
);

create index prediction_factors_prediction_idx
  on prediction_factors (prediction_id, polarity, position);

comment on column prediction_factors.contribution is
  'NULL means "not attributable", NOT zero. Zero is a measured non-contribution; NULL is the absence of a measurement, and the UI renders them differently.';

-- -----------------------------------------------------------------------------
-- prediction_model_outputs  — normalised ModelOutput[]  (Pro+ only, see 0007)
-- -----------------------------------------------------------------------------
create table prediction_model_outputs (
  id                     uuid primary key default gen_random_uuid(),
  prediction_id          uuid not null references predictions(id) on delete cascade,
  model_id               text not null,
  model_version          text not null,
  model_version_id       uuid references model_versions(id) on delete set null,
  abstained              boolean not null default false,
  abstain_reason         text,
  outcomes               jsonb not null check (jsonb_typeof(outcomes) = 'array'),
  confidence             numeric(7, 6) not null check (confidence >= 0 and confidence <= 1),
  weight                 numeric(9, 6) not null check (weight >= 0),
  feature_contributions  jsonb not null default '[]'::jsonb
                           check (jsonb_typeof(feature_contributions) = 'array'),
  created_at             timestamptz not null default now(),
  unique (prediction_id, model_id, model_version),
  -- An abstaining model must say why, and must not smuggle in a weight.
  constraint prediction_model_outputs_abstain_shape check (
    (not abstained and abstain_reason is null)
    or (abstained and abstain_reason is not null and weight = 0)
  )
);

create index prediction_model_outputs_prediction_idx
  on prediction_model_outputs (prediction_id);
create index prediction_model_outputs_model_idx
  on prediction_model_outputs (model_id, model_version);

comment on table prediction_model_outputs is
  'Per-model raw output behind an ensemble prediction. Gated to Pro+ by the predictions_public security-definer view in 0007 rather than by hiding it in the client.';
comment on column prediction_model_outputs.weight is
  'Meta-combiner weight derived from the model historical Brier skill score in model_metrics, never hand-tuned.';

-- -----------------------------------------------------------------------------
-- prediction_sources  — normalised SourceRef[]  (provenance)
-- -----------------------------------------------------------------------------
create table prediction_sources (
  id            uuid primary key default gen_random_uuid(),
  prediction_id uuid not null references predictions(id) on delete cascade,
  provider_id   text not null,
  capability    text not null,
  reliability   reliability_class not null,
  fetched_at    timestamptz not null,
  data_as_of    timestamptz not null,
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (prediction_id, provider_id, capability)
);

create index prediction_sources_prediction_idx on prediction_sources (prediction_id);

comment on table prediction_sources is
  'Per-dataset provenance for a prediction. This is the audit trail that makes data_mode falsifiable: if any row here has is_demo, the prediction cannot legitimately be data_mode = live.';

-- -----------------------------------------------------------------------------
-- prediction_history  — the probability time-series
-- -----------------------------------------------------------------------------
create table prediction_history (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  prediction_id       uuid references predictions(id) on delete set null,

  -- Denormalised subject key so the series survives even if an individual
  -- prediction row is archived, and so the chart is one index scan.
  domain              prediction_domain not null,
  subject             text not null,
  timeframe           prediction_timeframe not null,
  outcome_key         text not null,

  probability         numeric(7, 6) not null check (probability >= 0 and probability <= 1),
  previous_probability numeric(7, 6)
                        check (previous_probability is null or (previous_probability >= 0 and previous_probability <= 1)),
  confidence          numeric(7, 6) not null check (confidence >= 0 and confidence <= 1),
  data_quality        numeric(5, 2) not null check (data_quality >= 0 and data_quality <= 100),

  -- What moved the number. 'INITIAL' for the first point of a series.
  event_type          vixera_event_type not null default 'SCHEDULED',
  event_id            uuid references events(id) on delete set null,
  -- Structured description of the change, e.g.
  -- { "factor": "lineup", "detail": "Saka out", "deltaPp": -3.1, "before": {...}, "after": {...} }
  delta               jsonb not null default '{}'::jsonb,

  recorded_at         timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

-- The "prediction probability over time" chart.
create index prediction_history_series_idx
  on prediction_history (domain, subject, timeframe, outcome_key, recorded_at desc);

-- The "What Changed?" panel: the last N non-scheduled movements for a subject.
create index prediction_history_events_idx
  on prediction_history (domain, subject, recorded_at desc)
  where event_type not in ('SCHEDULED', 'INITIAL');

create index prediction_history_prediction_idx on prediction_history (prediction_id);

-- Idempotency: replaying the event that produced a snapshot must not duplicate
-- the point on the chart.
--
-- Deliberately a TOTAL unique index rather than a partial one with
-- `where prediction_id is not null`. The two are equivalent in behaviour
-- (NULLs are distinct in a unique index, so rows with a NULL prediction_id
-- never conflict either way), but PostgREST's `on_conflict` can only name
-- columns — it cannot supply the index predicate that Postgres requires to
-- infer a PARTIAL index — so an upsert against a partial index fails with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
-- The repository upserts against this index, so it has to be inferable.
create unique index prediction_history_point_uidx
  on prediction_history (prediction_id, outcome_key, recorded_at);

comment on table prediction_history is
  'Probability time-series per (subject, timeframe, outcome). Feeds both the probability-over-time chart and the What Changed? panel. Append-only, like predictions.';
comment on column prediction_history.delta is
  'Structured, machine-computed description of why the probability moved. The LLM may phrase this into a sentence; it may never author the numbers inside it (§12).';

-- -----------------------------------------------------------------------------
-- model_metrics  — rolling skill scores
-- -----------------------------------------------------------------------------
create table model_metrics (
  id                 uuid primary key default gen_random_uuid(),
  model_uuid         uuid references models(id) on delete cascade,
  model_version_id   uuid references model_versions(id) on delete cascade,
  domain             prediction_domain not null,
  timeframe          prediction_timeframe,
  window_start       timestamptz not null,
  window_end         timestamptz not null,
  sample_size        integer not null check (sample_size >= 0),
  brier_score        numeric(9, 8),
  brier_skill_score  numeric(9, 6),
  log_loss           numeric(12, 8),
  accuracy           numeric(7, 6) check (accuracy is null or (accuracy >= 0 and accuracy <= 1)),
  calibration_ece    numeric(7, 6),
  calibration_mce    numeric(7, 6),
  computed_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  constraint model_metrics_window_order check (window_end > window_start)
);

-- Recomputing the hourly metrics job overwrites rather than accumulates.
create unique index model_metrics_window_uidx
  on model_metrics (
    coalesce(model_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
    domain,
    coalesce(timeframe, 'event'::prediction_timeframe),
    window_start,
    window_end
  );

comment on table model_metrics is
  'Rolling Brier / log-loss / calibration per model version, timeframe and window. Doubles as the source of the meta-combiner weights — weights come from measured skill, not from taste.';
comment on column model_metrics.model_version_id is
  'NULL means "the ensemble as a whole" rather than an individual model.';

-- -----------------------------------------------------------------------------
-- calibration_bins  — the reliability diagram, persisted
-- -----------------------------------------------------------------------------
create table calibration_bins (
  id                  uuid primary key default gen_random_uuid(),
  model_version_id    uuid references model_versions(id) on delete cascade,
  domain              prediction_domain not null,
  timeframe           prediction_timeframe,
  bin_lower           numeric(7, 6) not null check (bin_lower >= 0 and bin_lower <= 1),
  bin_upper           numeric(7, 6) not null check (bin_upper >= 0 and bin_upper <= 1),
  sample_count        integer not null check (sample_count >= 0),
  mean_predicted      numeric(7, 6) not null check (mean_predicted >= 0 and mean_predicted <= 1),
  observed_frequency  numeric(7, 6) not null check (observed_frequency >= 0 and observed_frequency <= 1),
  computed_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  constraint calibration_bins_bounds check (bin_upper > bin_lower)
);

create unique index calibration_bins_uidx
  on calibration_bins (
    coalesce(model_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
    domain,
    coalesce(timeframe, 'event'::prediction_timeframe),
    computed_at,
    bin_lower
  );

comment on table calibration_bins is
  'Persisted reliability diagram: a system that says 70% should be right about 70% of the time, and this table is what makes that claim auditable on the public performance page.';
