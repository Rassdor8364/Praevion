-- =============================================================================
-- 0001_foundation (down)
--
-- Reverse order of creation. Tables first (children before parents), then the
-- helper functions, then the enum types. Extensions are deliberately NOT
-- dropped: they may be shared with other schemas in the same database, and
-- dropping pgcrypto out from under an unrelated object is not this migration's
-- business.
-- =============================================================================

drop table if exists events;
drop table if exists data_quality_snapshots;
drop table if exists data_ingestion_jobs;
drop table if exists data_providers;
drop table if exists audit_logs;
drop table if exists feature_flags;
drop table if exists subscriptions;
drop table if exists user_profiles;
drop table if exists org_members;
drop table if exists organizations;

drop function if exists platform_org_id();
drop function if exists set_updated_at();

drop type if exists event_status;
drop type if exists vixera_event_type;
drop type if exists ingestion_job_status;
drop type if exists data_mode;
drop type if exists reliability_class;
drop type if exists org_role;
drop type if exists subscription_status;
drop type if exists subscription_tier;
