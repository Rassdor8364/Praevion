-- =============================================================================
-- 0002_prediction_core (down)
-- =============================================================================

drop table if exists calibration_bins;
drop table if exists model_metrics;
drop table if exists prediction_history;
drop table if exists prediction_sources;
drop table if exists prediction_model_outputs;
drop table if exists prediction_factors;

-- predictions <-> prediction_outcomes reference each other; break the cycle
-- explicitly rather than relying on CASCADE, which would silently take
-- unrelated dependents with it.
alter table if exists predictions drop constraint if exists predictions_outcome_id_fkey;
drop table if exists prediction_outcomes;
drop table if exists predictions;

drop table if exists prediction_runs;
drop table if exists training_runs;
drop table if exists model_features;
drop table if exists model_versions;
drop table if exists models;

drop type if exists training_run_status;
drop type if exists model_kind;
drop type if exists factor_polarity;
drop type if exists risk_level;
drop type if exists prediction_timeframe;
drop type if exists prediction_domain;
