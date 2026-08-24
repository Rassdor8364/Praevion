-- =============================================================================
-- 0001_foundation
--
-- Organisations, membership, entitlements, provider registry, ingestion
-- bookkeeping and the Postgres-backed event bus (IMPLEMENTATION_PLAN §5, §13).
--
-- Everything org-scoped from day one. Retrofitting multi-tenancy onto a schema
-- that assumed a single tenant is a rewrite; carrying `org_id` from the first
-- migration costs one column.
-- =============================================================================

-- gen_random_uuid() lives in pgcrypto on Postgres < 13 and is built in from 13
-- onward. Creating the extension is harmless on newer servers and required on
-- older ones, so we always ask for it.
create extension if not exists "pgcrypto";

-- pgvector is used for news embeddings (0005) and incremental event clustering.
-- It is NOT available on every Supabase plan / self-hosted Postgres, and a
-- missing extension must not make the whole schema unbootable. We therefore try
-- to enable it and downgrade the failure to a NOTICE: 0005 checks
-- `pg_extension` at runtime and simply omits the embedding columns when the
-- extension is absent. The system degrades to lexical dedup (url_hash +
-- simhash) instead of dying.
do $$
begin
  execute 'create extension if not exists "vector"';
exception
  when others then
    raise notice
      'pgvector unavailable (%). Embedding columns will be skipped; news clustering falls back to lexical similarity.',
      sqlerrm;
end
$$;

-- -----------------------------------------------------------------------------
-- Enum types. Created before any table that uses them.
-- -----------------------------------------------------------------------------

-- Tier ordering is meaningful: entitlement checks compare positions.
create type subscription_tier as enum ('free', 'basic', 'pro', 'enterprise');

create type subscription_status as enum (
  'trialing', 'active', 'past_due', 'canceled', 'incomplete', 'paused'
);

create type org_role as enum ('owner', 'admin', 'member', 'viewer');

-- Mirrors ReliabilityClass in src/core/prediction/types.ts, most trusted first.
create type reliability_class as enum (
  'OFFICIAL',
  'PRIMARY_SOURCE',
  'HIGH_RELIABILITY',
  'ESTABLISHED_MEDIA',
  'SECONDARY',
  'SOCIAL',
  'UNVERIFIED'
);

-- Mirrors DataMode. This value ORIGINATES at the provider registry and is
-- propagated; it is never inferred from the shape of the data (§19.1).
create type data_mode as enum ('live', 'partial', 'demo');

create type ingestion_job_status as enum ('running', 'succeeded', 'partial', 'failed');

-- The event-bus vocabulary from §13. Also used by prediction_history to record
-- what caused a probability to move ("What Changed?").
create type vixera_event_type as enum (
  'INITIAL',
  'SCHEDULED',
  'MANUAL_RECOMPUTE',
  'NEW_ARTICLE',
  'PRICE_TICK',
  'CANDLE_CLOSED',
  'LINEUP_CHANGE',
  'PLAYER_INJURY',
  'GAME_STARTED',
  'GAME_FINISHED',
  'VOLATILITY_SPIKE',
  'PREDICTION_UPDATED',
  'MODEL_SIGNAL'
);

create type event_status as enum ('pending', 'processing', 'processed', 'failed');

-- -----------------------------------------------------------------------------
-- Shared trigger function for updated_at bookkeeping.
-- -----------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

comment on function set_updated_at() is
  'Generic BEFORE UPDATE trigger keeping updated_at honest. Application code must never set updated_at itself.';

-- -----------------------------------------------------------------------------
-- organizations
-- -----------------------------------------------------------------------------
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  tier        subscription_tier not null default 'free',
  is_platform boolean not null default false,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger organizations_set_updated_at
  before update on organizations
  for each row execute function set_updated_at();

comment on table organizations is
  'Tenant root. Every user-owned row in the database hangs off exactly one organization.';
comment on column organizations.is_platform is
  'True for the single synthetic organisation that owns platform-generated predictions and signals. It has no members, so RLS write policies can never match it and only service_role can write to its rows.';
comment on column organizations.tier is
  'Denormalised from the active subscription so entitlement checks are a single-row read on the hot path.';

-- The platform organisation. Predictions produced by the scheduled engines are
-- owned by this org and made readable to every authenticated user (see 0007),
-- while org-specific ad-hoc predictions stay private to their org. The uuid is
-- fixed so application code and tests can reference it as a constant.
insert into organizations (id, name, slug, tier, is_platform)
values (
  '00000000-0000-0000-0000-000000000001',
  'Vixera Platform',
  'vixera-platform',
  'enterprise',
  true
);

create or replace function platform_org_id() returns uuid
language sql
immutable
as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;

comment on function platform_org_id() is
  'The well-known organisation id owning platform-wide predictions/signals. Referenced by RLS policies so that global analytics are readable by all authenticated users without being writable by any of them.';

-- -----------------------------------------------------------------------------
-- org_members  (join table -> composite PK, no surrogate id)
-- -----------------------------------------------------------------------------
create table org_members (
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null,
  role       org_role not null default 'member',
  invited_by uuid,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index org_members_user_id_idx on org_members (user_id);

comment on table org_members is
  'Membership edge. This table is the sole input to current_org_ids() and is therefore the hinge of the entire RLS model — keep it small and keep the user_id index.';

-- -----------------------------------------------------------------------------
-- user_profiles
-- -----------------------------------------------------------------------------
create table user_profiles (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique,
  default_org_id    uuid references organizations(id) on delete set null,
  display_name      text,
  avatar_url        text,
  timezone          text not null default 'UTC',
  locale            text not null default 'en',
  preferences       jsonb not null default '{}'::jsonb,
  onboarded_at      timestamptz,
  last_seen_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger user_profiles_set_updated_at
  before update on user_profiles
  for each row execute function set_updated_at();

-- The auth schema only exists on Supabase. Migrations must also apply cleanly to
-- a bare Postgres scratch database (CI runs up -> down -> up), so the foreign
-- key to auth.users is added conditionally rather than declared inline.
do $$
begin
  if exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'auth' and c.relname = 'users'
  ) then
    alter table user_profiles
      add constraint user_profiles_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  else
    raise notice 'auth.users not found — user_profiles.user_id left unconstrained (non-Supabase database).';
  end if;
end
$$;

comment on column user_profiles.user_id is
  'Supabase auth.users id. Constrained by FK only when the auth schema exists, so the schema still applies to a plain Postgres CI database.';

-- -----------------------------------------------------------------------------
-- subscriptions
-- -----------------------------------------------------------------------------
create table subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organizations(id) on delete cascade,
  tier                     subscription_tier not null,
  status                   subscription_status not null,
  billing_provider         text not null default 'stripe',
  external_customer_id     text,
  external_subscription_id text,
  seats                    integer not null default 1 check (seats > 0),
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean not null default false,
  canceled_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint subscriptions_period_order check (
    current_period_end is null
    or current_period_start is null
    or current_period_end >= current_period_start
  )
);

create trigger subscriptions_set_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();

-- Idempotent webhook ingestion: replaying a Stripe event must update, not
-- duplicate.
create unique index subscriptions_external_uidx
  on subscriptions (billing_provider, external_subscription_id)
  where external_subscription_id is not null;

-- At most one live subscription per organisation.
create unique index subscriptions_one_active_per_org_uidx
  on subscriptions (org_id)
  where status in ('trialing', 'active', 'past_due');

create index subscriptions_org_id_idx on subscriptions (org_id);

comment on table subscriptions is
  'Billing state mirrored from the payment provider. organizations.tier is the read-time cache of the active row here.';

-- -----------------------------------------------------------------------------
-- feature_flags
-- -----------------------------------------------------------------------------
create table feature_flags (
  id                  uuid primary key default gen_random_uuid(),
  key                 text not null check (key ~ '^[a-z0-9][a-z0-9._-]*$'),
  org_id              uuid references organizations(id) on delete cascade,
  description         text,
  is_enabled          boolean not null default false,
  min_tier            subscription_tier,
  rollout_percentage  smallint not null default 100
                        check (rollout_percentage between 0 and 100),
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger feature_flags_set_updated_at
  before update on feature_flags
  for each row execute function set_updated_at();

-- A NULL org_id is the global default; a row with an org_id overrides it. NULLs
-- are distinct in a plain UNIQUE constraint, which would allow duplicate global
-- rows, so the uniqueness is expressed over a coalesced key instead.
create unique index feature_flags_key_org_uidx
  on feature_flags (key, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid));

comment on column feature_flags.org_id is
  'NULL = global default. A non-null row is a per-organisation override of the global row with the same key.';

-- -----------------------------------------------------------------------------
-- audit_logs
-- -----------------------------------------------------------------------------
create table audit_logs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  actor_user_id uuid,
  action        text not null,
  entity_type   text not null,
  entity_id     text,
  before_state  jsonb,
  after_state   jsonb,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index audit_logs_org_created_idx on audit_logs (org_id, created_at desc);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);

comment on table audit_logs is
  'Append-only. Auth events, tier changes, alert mutations and every model-version promotion (§14). Nothing in the application ever updates or deletes a row here.';

-- -----------------------------------------------------------------------------
-- data_providers  (reference data — service_role writes only)
-- -----------------------------------------------------------------------------
create table data_providers (
  id                   uuid primary key default gen_random_uuid(),
  provider_id          text not null unique,
  display_name         text not null,
  reliability          reliability_class not null,
  is_demo              boolean not null default false,
  capabilities         text[] not null default '{}',
  is_enabled           boolean not null default true,
  requires_key         boolean not null default false,
  is_configured        boolean not null default false,
  priority             smallint not null default 100,
  base_url             text,
  rate_limit_per_min   integer,
  last_health_check_at timestamptz,
  is_healthy           boolean,
  latency_ms           integer,
  health_message       text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger data_providers_set_updated_at
  before update on data_providers
  for each row execute function set_updated_at();

create index data_providers_priority_idx on data_providers (priority);

comment on table data_providers is
  'Mirror of the in-process provider registry, persisted so the UI can render provider health and so an operator can disable a misbehaving vendor without a deploy.';
comment on column data_providers.priority is
  'Ordered fallback chain position, lower first. Two providers for the same capability must not share a priority in practice, but the schema permits it and the registry breaks ties deterministically by provider_id.';
comment on column data_providers.is_demo is
  'True for the demo module tree. Any prediction whose provenance touches a demo provider is stamped data_mode = demo and excluded from every accuracy statistic (§19.3).';

-- -----------------------------------------------------------------------------
-- data_ingestion_jobs
-- -----------------------------------------------------------------------------
create table data_ingestion_jobs (
  id            uuid primary key default gen_random_uuid(),
  job_name      text not null,
  provider_id   uuid references data_providers(id) on delete set null,
  capability    text,
  status        ingestion_job_status not null default 'running',
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  duration_ms   integer,
  rows_read     integer not null default 0,
  rows_written  integer not null default 0,
  rows_skipped  integer not null default 0,
  error_count   integer not null default 0,
  error_message text,
  cursor_state  jsonb not null default '{}'::jsonb,
  run_key       text,
  created_at    timestamptz not null default now(),
  constraint data_ingestion_jobs_finish_order check (
    finished_at is null or finished_at >= started_at
  )
);

create index data_ingestion_jobs_name_started_idx
  on data_ingestion_jobs (job_name, started_at desc);

-- Freshness indicators on screen read "the newest successful run per
-- capability"; this index makes that a single index scan.
create index data_ingestion_jobs_capability_finished_idx
  on data_ingestion_jobs (capability, finished_at desc)
  where status = 'succeeded';

-- Stuck-job detector scans only what is still running.
create index data_ingestion_jobs_running_idx
  on data_ingestion_jobs (started_at)
  where finished_at is null;

-- Every ingestion job must be safely re-runnable. `run_key` is the natural key
-- of a scheduled invocation (e.g. 'candles:BTCUSDT:1h:2026-08-12T14:00Z'); the
-- unique index turns an accidental double-fire of Vercel Cron into a no-op.
create unique index data_ingestion_jobs_run_key_uidx
  on data_ingestion_jobs (job_name, run_key)
  where run_key is not null;

comment on table data_ingestion_jobs is
  'Start/end/rows/errors for every ingestion run (§13). This table — not a guess — is the data source for the freshness indicators shown in the UI.';
comment on column data_ingestion_jobs.cursor_state is
  'Provider pagination/watermark state, so a re-run resumes rather than refetching from the beginning.';

-- -----------------------------------------------------------------------------
-- data_quality_snapshots
-- -----------------------------------------------------------------------------
create table data_quality_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  domain                text not null,
  subject               text,
  score                 numeric(5, 2) not null check (score >= 0 and score <= 100),
  components            jsonb not null default '{}'::jsonb,
  stale_capabilities    text[] not null default '{}',
  missing_capabilities  text[] not null default '{}',
  worst_capability      text,
  data_mode             data_mode not null,
  measured_at           timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

create index data_quality_snapshots_domain_measured_idx
  on data_quality_snapshots (domain, subject, measured_at desc);

comment on table data_quality_snapshots is
  'Time-series of the Vixera Data Quality Score (src/core/quality/data-quality.ts). Persisted so a degraded prediction can be explained after the fact instead of only at the moment it was generated.';

-- -----------------------------------------------------------------------------
-- events  (Postgres event bus, §13)
-- -----------------------------------------------------------------------------
create table events (
  id            uuid primary key default gen_random_uuid(),
  event_type    vixera_event_type not null,
  status        event_status not null default 'pending',
  domain        text,
  subject       text,
  payload       jsonb not null default '{}'::jsonb,
  dedupe_key    text,
  occurred_at   timestamptz not null default now(),
  processed_at  timestamptz,
  attempts      smallint not null default 0,
  last_error    text,
  created_at    timestamptz not null default now()
);

-- The worker claims work with `... where status = 'pending' order by occurred_at
-- for update skip locked`; a partial index keeps that scan proportional to the
-- backlog rather than to the history.
create index events_pending_idx on events (occurred_at) where status = 'pending';
create index events_subject_idx on events (domain, subject, occurred_at desc);

-- Producers are at-least-once (a cron may fire twice, a websocket may replay).
-- The dedupe key makes the consumer's view exactly-once.
create unique index events_dedupe_uidx on events (event_type, dedupe_key)
  where dedupe_key is not null;

comment on table events is
  'Phase-1 event bus: this table plus LISTEN/NOTIFY, zero new infrastructure. Swappable for a real queue behind core/events/bus.ts. Drives the cascade PLAYER_INJURY -> recompute strength -> recompute probability -> prediction_history -> alerts -> SSE.';
