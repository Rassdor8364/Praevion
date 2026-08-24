-- =============================================================================
-- 0006_user_surface
--
-- Everything a user owns: watchlists, alerts, signals and notifications
-- (IMPLEMENTATION_PLAN §5, §14).
--
-- Every table here carries `org_id uuid not null references organizations(id)
-- on delete cascade` — including child tables that could have reached org_id
-- through their parent. The denormalisation is deliberate: an RLS policy that
-- needs a join to find the tenant runs that join on every row of every query,
-- and a policy that reads one local column is both faster and much harder to
-- get wrong.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type alert_status as enum ('active', 'paused', 'triggered', 'archived');

create type signal_strength as enum ('weak', 'moderate', 'strong', 'very_strong');

-- Mirrors Direction in src/core/prediction/types.ts.
create type signal_direction as enum ('bullish', 'bearish', 'neutral');

create type notification_channel as enum ('in_app', 'email', 'push', 'webhook');

create type notification_status as enum ('queued', 'sent', 'failed', 'suppressed');

-- -----------------------------------------------------------------------------
-- watchlists
-- -----------------------------------------------------------------------------
create table watchlists (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  created_by  uuid,
  name        text not null check (length(btrim(name)) > 0),
  description text,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, name)
);

create trigger watchlists_set_updated_at
  before update on watchlists
  for each row execute function set_updated_at();

create unique index watchlists_one_default_uidx on watchlists (org_id) where is_default;

-- -----------------------------------------------------------------------------
-- watchlist_items
-- -----------------------------------------------------------------------------
create table watchlist_items (
  id            uuid primary key default gen_random_uuid(),
  watchlist_id  uuid not null references watchlists(id) on delete cascade,
  org_id        uuid not null references organizations(id) on delete cascade,
  domain        prediction_domain not null,
  subject       text not null,
  subject_label text not null,
  position      smallint not null default 0,
  notes         text,
  added_by      uuid,
  created_at    timestamptz not null default now(),
  -- Adding the same subject twice is a no-op, not a duplicate row.
  unique (watchlist_id, domain, subject)
);

create index watchlist_items_org_idx on watchlist_items (org_id);
create index watchlist_items_subject_idx on watchlist_items (domain, subject);

comment on column watchlist_items.org_id is
  'Denormalised from the parent watchlist so the RLS policy is a column comparison rather than a subquery. Kept consistent by the repository layer, which always writes both together.';

-- -----------------------------------------------------------------------------
-- alerts
-- -----------------------------------------------------------------------------
create table alerts (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  created_by       uuid,
  name             text not null check (length(btrim(name)) > 0),
  domain           prediction_domain not null,
  subject          text not null,
  timeframe        prediction_timeframe,
  -- Machine-evaluable condition, validated by zod before it is ever written:
  -- { "type": "probability_above", "outcomeKey": "up", "threshold": 0.68 }
  condition        jsonb not null check (jsonb_typeof(condition) = 'object'),
  status           alert_status not null default 'active',
  channels         notification_channel[] not null default '{in_app}',
  cooldown_seconds integer not null default 3600 check (cooldown_seconds >= 0),
  last_triggered_at timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger alerts_set_updated_at
  before update on alerts
  for each row execute function set_updated_at();

create index alerts_org_idx on alerts (org_id);

-- The alert evaluator runs on EVERY new prediction, so its lookup index must be
-- narrow: only active alerts for the subject that just moved.
create index alerts_evaluation_idx on alerts (domain, subject, timeframe)
  where status = 'active';

comment on column alerts.cooldown_seconds is
  'Minimum gap between notifications for one alert. A probability oscillating around a threshold must not generate a notification per tick.';

-- -----------------------------------------------------------------------------
-- alert_triggers
-- -----------------------------------------------------------------------------
create table alert_triggers (
  id            uuid primary key default gen_random_uuid(),
  alert_id      uuid not null references alerts(id) on delete cascade,
  org_id        uuid not null references organizations(id) on delete cascade,
  prediction_id uuid references predictions(id) on delete set null,
  triggered_at  timestamptz not null default now(),
  -- Snapshot of the values that satisfied the condition, so the trigger is
  -- explicable even after the underlying prediction has been superseded.
  payload       jsonb not null default '{}'::jsonb,
  notified_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index alert_triggers_alert_idx on alert_triggers (alert_id, triggered_at desc);
create index alert_triggers_org_idx on alert_triggers (org_id, triggered_at desc);

-- One trigger per alert per prediction: re-evaluating the same prediction (a
-- retry, a replayed event) cannot double-notify.
create unique index alert_triggers_idempotency_uidx
  on alert_triggers (alert_id, prediction_id)
  where prediction_id is not null;

-- -----------------------------------------------------------------------------
-- signals
-- -----------------------------------------------------------------------------
create table signals (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  prediction_id uuid references predictions(id) on delete set null,
  domain        prediction_domain not null,
  subject       text not null,
  subject_label text not null,
  timeframe     prediction_timeframe not null,
  direction     signal_direction not null,
  strength      signal_strength not null,
  score         numeric(5, 2) not null check (score >= 0 and score <= 100),
  confidence    numeric(7, 6) not null check (confidence >= 0 and confidence <= 1),
  rationale     text,
  data_mode     data_mode not null,
  model_version text not null,
  generated_at  timestamptz not null,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (domain, subject, timeframe, model_version, generated_at)
);

create index signals_org_generated_idx on signals (org_id, generated_at desc);
create index signals_live_idx on signals (domain, score desc, generated_at desc)
  where data_mode = 'live';

comment on table signals is
  'Derived, ranked read of the prediction stream. Signals are analytical observations, never instructions: no bet slips, no bookmaker links, no "lock" language anywhere in this table or its UI (§18-R5).';
comment on column signals.org_id is
  'Platform-generated signals belong to platform_org_id() and are readable by every authenticated user; an org may also own private signals.';

-- -----------------------------------------------------------------------------
-- signal_evidence
-- -----------------------------------------------------------------------------
create table signal_evidence (
  id             uuid primary key default gen_random_uuid(),
  signal_id      uuid not null references signals(id) on delete cascade,
  org_id         uuid not null references organizations(id) on delete cascade,
  kind           text not null,
  label          text not null,
  detail         text,
  weight         numeric(9, 6),
  reference_type text,
  reference_id   text,
  created_at     timestamptz not null default now(),
  unique (signal_id, kind, label)
);

create index signal_evidence_signal_idx on signal_evidence (signal_id);

comment on table signal_evidence is
  'The computed reasons behind a signal, with a pointer back to the row that supplied each one. A signal with no evidence rows is a bug: nothing is allowed to assert a conclusion it cannot cite.';

-- -----------------------------------------------------------------------------
-- notifications
-- -----------------------------------------------------------------------------
create table notifications (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  user_id           uuid not null,
  channel           notification_channel not null default 'in_app',
  status            notification_status not null default 'queued',
  title             text not null,
  body              text,
  payload           jsonb not null default '{}'::jsonb,
  alert_trigger_id  uuid references alert_triggers(id) on delete set null,
  related_type      text,
  related_id        text,
  sent_at           timestamptz,
  read_at           timestamptz,
  error_message     text,
  dedupe_key        text,
  created_at        timestamptz not null default now()
);

-- The unread badge is read on every page load; keep its index tiny.
create index notifications_unread_idx on notifications (org_id, user_id, created_at desc)
  where read_at is null;
create index notifications_user_idx on notifications (user_id, created_at desc);

-- At-least-once delivery producers, exactly-once user experience.
create unique index notifications_dedupe_uidx on notifications (user_id, dedupe_key)
  where dedupe_key is not null;
