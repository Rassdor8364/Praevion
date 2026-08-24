-- =============================================================================
-- 0007_rls — Row Level Security (IMPLEMENTATION_PLAN §14)
--
-- The model in one paragraph:
--
--   * Every user belongs to >= 1 organization. Every user-owned table carries
--     org_id, has RLS enabled, and has four policies keyed on
--     `org_id in (select current_org_ids())`.
--   * Reference / market data (assets, prices, candles, teams, games, articles,
--     the model registry) has RLS enabled and a SELECT policy for
--     `authenticated` — and NO insert, update or delete policy at all.
--   * `service_role` has the BYPASSRLS attribute, so ingestion (which runs
--     server-side with the service key) writes freely while no browser session
--     can write a single row of market data.
--
-- THE ABSENCE OF A POLICY IS THE MECHANISM. With RLS enabled, an operation
-- with no permissive policy matching it is denied — there is nothing to
-- misconfigure, no `USING (false)` to accidentally loosen, and no way for a
-- future "just add a policy for convenience" change to slip past review
-- unnoticed. Read the read-only-table loop below as a deliberate, load-bearing
-- omission rather than as an unfinished section.
--
-- ON `FORCE ROW LEVEL SECURITY`: deliberately NOT used anywhere here, even
-- though it looks like the stricter and therefore better choice. FORCE subjects
-- the table owner to the policies too, and the whole model rests on
-- SECURITY DEFINER helpers that read `org_members` and `organizations` as the
-- owner. With FORCE, `current_org_ids()` would be filtered by the very policy
-- that calls it and Postgres would abort with "infinite recursion detected in
-- policy for relation org_members". Plain ENABLE gives the owner an implicit
-- bypass, which is exactly what those helpers need. Nothing user-facing ever
-- connects as the owner: PostgREST authenticates and then switches to `anon`
-- or `authenticated`, both of which are fully subject to RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Supabase compatibility shims.
--
-- On Supabase, auth.uid() and the anon / authenticated / service_role roles all
-- exist already. On a bare Postgres (CI scratch database, local docker), they do
-- not, and this migration must still apply so that up -> down -> up can be
-- tested. These shims create the missing pieces and nothing else.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    execute 'create schema auth';
  end if;

  if not exists (
    select 1
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    -- Mirrors Supabase's implementation: the user id out of the request JWT
    -- claims, NULL when there is no authenticated session.
    execute $fn$
      create function auth.uid() returns uuid
      language sql stable
      as $inner$
        select nullif(
          current_setting('request.jwt.claim.sub', true),
          ''
        )::uuid
      $inner$
    $fn$;
    raise notice 'Created auth.uid() shim (non-Supabase database).';
  end if;
end
$$;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin noinherit', r);
      raise notice 'Created role % (non-Supabase database).', r;
    end if;
  end loop;
  -- service_role bypasses RLS entirely. This is what makes "no write policy"
  -- a viable design for market data rather than a dead end.
  if not coalesce((select rolbypassrls from pg_roles where rolname = 'service_role'), false) then
    begin
      execute 'alter role service_role bypassrls';
    exception when others then
      raise notice
        'Could not set BYPASSRLS on service_role (%). Supabase sets this already; a local database needs superuser.',
        sqlerrm;
    end;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- Table-level privileges are deliberately broad; ROW level security is what
-- actually restricts access. Granting only SELECT here would make the
-- "omitted policy" mechanism above meaningless, because the GRANT would be
-- doing the work and the policy set would no longer be the single source of
-- truth for who can write what.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant all on all tables in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;

-- -----------------------------------------------------------------------------
-- Helper functions
-- -----------------------------------------------------------------------------

-- The hinge of the whole model. SECURITY DEFINER because org_members itself has
-- RLS enabled, and a policy that queried it as the invoker would recurse.
-- STABLE so the planner evaluates it once per statement rather than per row.
create or replace function current_org_ids() returns setof uuid
language sql
stable
security definer
as $$ select org_id from org_members where user_id = auth.uid() $$;

-- A SECURITY DEFINER function must pin its search_path, or a caller who can
-- create objects in a schema earlier on the path can shadow `org_members` and
-- have this function hand them someone else's tenancy.
alter function current_org_ids() set search_path = public, pg_catalog;

comment on function current_org_ids() is
  'The organisations the current JWT subject belongs to. Referenced by every user-owned RLS policy. SECURITY DEFINER to avoid recursing into org_members RLS.';

create or replace function is_org_admin(target_org_id uuid) returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from org_members
     where org_id = target_org_id
       and user_id = auth.uid()
       and role in ('owner', 'admin')
  )
$$;

alter function is_org_admin(uuid) set search_path = public, pg_catalog;

-- Tier gating for raw model output. Enum comparison works because
-- subscription_tier is declared in ascending order of entitlement.
create or replace function current_tier_at_least(min_tier subscription_tier) returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1
      from org_members m
      join organizations o on o.id = m.org_id
     where m.user_id = auth.uid()
       and o.tier >= min_tier
  )
$$;

alter function current_tier_at_least(subscription_tier) set search_path = public, pg_catalog;

comment on function current_tier_at_least(subscription_tier) is
  'True when any organisation the user belongs to is at or above the given tier. Used to gate prediction_model_outputs to Pro+ in the database rather than in the client.';

-- Visibility rule for predictions and signals: your own org, plus the platform
-- org that owns everything the scheduled engines generate.
create or replace function can_read_org_row(row_org_id uuid) returns boolean
language sql
stable
as $$
  select row_org_id = platform_org_id() or row_org_id in (select current_org_ids())
$$;

alter function can_read_org_row(uuid) set search_path = public, pg_catalog;

grant execute on function current_org_ids() to authenticated;
grant execute on function is_org_admin(uuid) to authenticated;
grant execute on function current_tier_at_least(subscription_tier) to authenticated;
grant execute on function can_read_org_row(uuid) to authenticated;
grant execute on function platform_org_id() to authenticated, anon;

-- =============================================================================
-- PART 1 — Reference / market data.
--
-- RLS on, SELECT for authenticated, and nothing else. Writes are impossible for
-- every role except service_role.
-- =============================================================================
do $$
declare
  t text;
  read_only_tables text[] := array[
    -- foundation
    'data_providers', 'data_ingestion_jobs', 'data_quality_snapshots', 'events',
    -- model registry (public so the performance page can show what ran)
    'models', 'model_versions', 'model_features', 'training_runs',
    'prediction_runs', 'model_metrics', 'calibration_bins',
    -- sports
    'sports', 'leagues', 'seasons', 'teams', 'players', 'games',
    'team_season_stats', 'team_game_stats', 'player_game_stats',
    'injuries', 'lineups', 'h2h_cache', 'team_ratings',
    -- crypto
    'assets', 'crypto_assets', 'crypto_prices', 'crypto_candles',
    'crypto_indicators', 'crypto_orderbook_snapshots', 'crypto_onchain_metrics',
    'crypto_derivatives',
    -- news
    'news_sources', 'news_articles', 'news_events', 'news_event_articles',
    'news_entities', 'news_article_entities', 'news_entity_sentiment',
    'entity_graph_nodes', 'entity_graph_edges'
  ];
begin
  foreach t in array read_only_tables loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for select to authenticated using (true)',
      t || '_read_authenticated', t
    );
    -- NO insert / update / delete policy. See the header comment: the omission
    -- is the access control.
  end loop;
end
$$;

comment on policy data_providers_read_authenticated on data_providers is
  'Read-only to signed-in users. There is deliberately no write policy on this table or any other market/reference table — only service_role, which bypasses RLS, may write.';

-- Enabling RLS on a partitioned table applies to every partition, including
-- ones created later by the partition-maintenance job. Stated explicitly
-- because it is the kind of thing a reviewer will want to check.
comment on policy crypto_candles_read_authenticated on crypto_candles is
  'Inherited by every existing and future monthly partition of crypto_candles.';

-- =============================================================================
-- PART 2 — User-owned data.
-- =============================================================================

-- --- organizations -----------------------------------------------------------
alter table organizations enable row level security;

create policy organizations_select on organizations
  for select to authenticated
  using (id in (select current_org_ids()) or is_platform);

create policy organizations_update on organizations
  for update to authenticated
  using (is_org_admin(id))
  with check (is_org_admin(id));

-- No INSERT or DELETE policy: creating and destroying a tenant is a
-- service_role operation performed by the sign-up / account-closure flow, which
-- also has to write the first org_members row atomically.

-- --- org_members -------------------------------------------------------------
alter table org_members enable row level security;

create policy org_members_select on org_members
  for select to authenticated
  using (org_id in (select current_org_ids()));

create policy org_members_insert on org_members
  for insert to authenticated
  with check (is_org_admin(org_id));

create policy org_members_update on org_members
  for update to authenticated
  using (is_org_admin(org_id))
  with check (is_org_admin(org_id));

create policy org_members_delete on org_members
  for delete to authenticated
  using (is_org_admin(org_id));

-- --- user_profiles -----------------------------------------------------------
alter table user_profiles enable row level security;

create policy user_profiles_select on user_profiles
  for select to authenticated
  using (
    user_id = auth.uid()
    or default_org_id in (select current_org_ids())
  );

create policy user_profiles_insert on user_profiles
  for insert to authenticated
  with check (user_id = auth.uid());

create policy user_profiles_update on user_profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy user_profiles_delete on user_profiles
  for delete to authenticated
  using (user_id = auth.uid());

-- --- subscriptions -----------------------------------------------------------
-- Readable by the org, writable by nobody: billing state is written by the
-- payment-provider webhook handler running as service_role. A client that could
-- update this table could grant itself Enterprise.
alter table subscriptions enable row level security;

create policy subscriptions_select on subscriptions
  for select to authenticated
  using (org_id in (select current_org_ids()));

-- --- feature_flags -----------------------------------------------------------
alter table feature_flags enable row level security;

create policy feature_flags_select on feature_flags
  for select to authenticated
  using (org_id is null or org_id in (select current_org_ids()));

-- --- audit_logs --------------------------------------------------------------
-- Append-only from the application's point of view: SELECT and INSERT only, no
-- UPDATE or DELETE policy for anyone. An audit log a tenant can edit is not one.
alter table audit_logs enable row level security;

create policy audit_logs_select on audit_logs
  for select to authenticated
  using (org_id in (select current_org_ids()));

create policy audit_logs_insert on audit_logs
  for insert to authenticated
  with check (org_id in (select current_org_ids()));

-- --- predictions -------------------------------------------------------------
alter table predictions enable row level security;

create policy predictions_select on predictions
  for select to authenticated
  using (can_read_org_row(org_id));

-- An org may generate its own ad-hoc predictions (Enterprise custom subjects);
-- it can never write into the platform org's stream, because current_org_ids()
-- cannot contain platform_org_id() — that organisation has no members.
create policy predictions_insert on predictions
  for insert to authenticated
  with check (org_id in (select current_org_ids()));

create policy predictions_update on predictions
  for update to authenticated
  using (org_id in (select current_org_ids()))
  with check (org_id in (select current_org_ids()));

create policy predictions_delete on predictions
  for delete to authenticated
  using (org_id in (select current_org_ids()));

comment on policy predictions_select on predictions is
  'Platform-generated predictions (org_id = platform_org_id()) are readable by every authenticated user; org-owned predictions only by that org.';

-- --- prediction_outcomes / factors / model_outputs / sources -----------------
-- These children have no org_id of their own; visibility is inherited from the
-- parent prediction. The subquery is indexed (predictions.id is the PK) and the
-- alternative — denormalising org_id onto four more tables — would create four
-- more places for it to go stale.
alter table prediction_outcomes enable row level security;

create policy prediction_outcomes_select on prediction_outcomes
  for select to authenticated
  using (exists (
    select 1 from predictions p
     where p.id = prediction_outcomes.prediction_id
       and can_read_org_row(p.org_id)
  ));

alter table prediction_factors enable row level security;

create policy prediction_factors_select on prediction_factors
  for select to authenticated
  using (exists (
    select 1 from predictions p
     where p.id = prediction_factors.prediction_id
       and can_read_org_row(p.org_id)
  ));

alter table prediction_sources enable row level security;

create policy prediction_sources_select on prediction_sources
  for select to authenticated
  using (exists (
    select 1 from predictions p
     where p.id = prediction_sources.prediction_id
       and can_read_org_row(p.org_id)
  ));

alter table prediction_model_outputs enable row level security;

-- Raw per-model output is a Pro+ entitlement, enforced here rather than by
-- omitting a field in the client. A Free-tier session issuing the query by hand
-- gets zero rows, not a 200 with the data and a hidden div.
create policy prediction_model_outputs_select on prediction_model_outputs
  for select to authenticated
  using (
    current_tier_at_least('pro')
    and exists (
      select 1 from predictions p
       where p.id = prediction_model_outputs.prediction_id
         and can_read_org_row(p.org_id)
    )
  );

-- --- prediction_history ------------------------------------------------------
alter table prediction_history enable row level security;

create policy prediction_history_select on prediction_history
  for select to authenticated
  using (can_read_org_row(org_id));

create policy prediction_history_insert on prediction_history
  for insert to authenticated
  with check (org_id in (select current_org_ids()));

-- No UPDATE or DELETE policy: the probability time-series is append-only, and
-- rewriting history is precisely the failure mode this product exists to avoid.

-- --- watchlists / watchlist_items -------------------------------------------
alter table watchlists enable row level security;

create policy watchlists_select on watchlists
  for select to authenticated using (org_id in (select current_org_ids()));
create policy watchlists_insert on watchlists
  for insert to authenticated with check (org_id in (select current_org_ids()));
create policy watchlists_update on watchlists
  for update to authenticated
  using (org_id in (select current_org_ids()))
  with check (org_id in (select current_org_ids()));
create policy watchlists_delete on watchlists
  for delete to authenticated using (org_id in (select current_org_ids()));

alter table watchlist_items enable row level security;

create policy watchlist_items_select on watchlist_items
  for select to authenticated using (org_id in (select current_org_ids()));
create policy watchlist_items_insert on watchlist_items
  for insert to authenticated with check (org_id in (select current_org_ids()));
create policy watchlist_items_update on watchlist_items
  for update to authenticated
  using (org_id in (select current_org_ids()))
  with check (org_id in (select current_org_ids()));
create policy watchlist_items_delete on watchlist_items
  for delete to authenticated using (org_id in (select current_org_ids()));

-- --- alerts / alert_triggers -------------------------------------------------
alter table alerts enable row level security;

create policy alerts_select on alerts
  for select to authenticated using (org_id in (select current_org_ids()));
create policy alerts_insert on alerts
  for insert to authenticated with check (org_id in (select current_org_ids()));
create policy alerts_update on alerts
  for update to authenticated
  using (org_id in (select current_org_ids()))
  with check (org_id in (select current_org_ids()));
create policy alerts_delete on alerts
  for delete to authenticated using (org_id in (select current_org_ids()));

alter table alert_triggers enable row level security;

-- Triggers are written by the evaluator (service_role). Users read them and may
-- clear their own org's history.
create policy alert_triggers_select on alert_triggers
  for select to authenticated using (org_id in (select current_org_ids()));
create policy alert_triggers_delete on alert_triggers
  for delete to authenticated using (org_id in (select current_org_ids()));

-- --- signals / signal_evidence ----------------------------------------------
alter table signals enable row level security;

create policy signals_select on signals
  for select to authenticated using (can_read_org_row(org_id));
create policy signals_insert on signals
  for insert to authenticated with check (org_id in (select current_org_ids()));
create policy signals_update on signals
  for update to authenticated
  using (org_id in (select current_org_ids()))
  with check (org_id in (select current_org_ids()));
create policy signals_delete on signals
  for delete to authenticated using (org_id in (select current_org_ids()));

alter table signal_evidence enable row level security;

create policy signal_evidence_select on signal_evidence
  for select to authenticated using (can_read_org_row(org_id));
create policy signal_evidence_insert on signal_evidence
  for insert to authenticated with check (org_id in (select current_org_ids()));
create policy signal_evidence_delete on signal_evidence
  for delete to authenticated using (org_id in (select current_org_ids()));

-- --- notifications -----------------------------------------------------------
alter table notifications enable row level security;

-- A notification is addressed to a person, so org membership alone is not
-- enough: you must also be the addressee.
create policy notifications_select on notifications
  for select to authenticated
  using (user_id = auth.uid() and org_id in (select current_org_ids()));

-- Update exists only so the client can mark something read; the WITH CHECK
-- keeps the row addressed to the same person it was addressed to.
create policy notifications_update on notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy notifications_delete on notifications
  for delete to authenticated
  using (user_id = auth.uid());

-- =============================================================================
-- PART 3 — predictions_public
--
-- A SECURITY DEFINER view: it runs with the privileges of its owner, so it is
-- NOT filtered by the RLS policies of the underlying tables. That is exactly
-- why the org-visibility predicate is written into the view body — the view is
-- responsible for its own tenancy, and getting that wrong here would be a data
-- leak rather than an error message.
--
-- What it exposes: the prediction, its outcome distribution, its confidence,
-- its factors and its provenance. What it does NOT expose:
-- prediction_model_outputs — the per-model probabilities, weights and feature
-- contributions that are a Pro+ entitlement. Free and Basic surfaces read this
-- view and cannot see raw model output even if they ask for it by name.
-- =============================================================================
create or replace view predictions_public as
select
  p.id,
  p.domain,
  p.subject,
  p.subject_label,
  p.timeframe,
  p.outcomes,
  p.leading_outcome_key,
  p.leading_probability,
  p.confidence,
  p.data_quality,
  p.model_agreement,
  p.risk_level,
  p.scenarios,
  p.volatility,
  p.data_mode,
  p.generated_at,
  p.data_timestamp,
  p.model_version,
  p.disclaimer,
  p.outcome_id,
  p.created_at,
  -- Factor lists are explanation, not raw model internals, so they stay.
  coalesce(
    (
      select jsonb_agg(
               jsonb_build_object(
                 'id', f.factor_id,
                 'label', f.label,
                 'polarity', f.polarity,
                 'contribution', f.contribution,
                 'detail', f.detail,
                 'evidenceStrength', f.evidence_strength
               )
               order by f.polarity, f.position
             )
        from prediction_factors f
       where f.prediction_id = p.id
    ),
    '[]'::jsonb
  ) as factors,
  coalesce(
    (
      select jsonb_agg(
               jsonb_build_object(
                 'providerId', s.provider_id,
                 'capability', s.capability,
                 'reliability', s.reliability,
                 'fetchedAt', s.fetched_at,
                 'dataAsOf', s.data_as_of,
                 'isDemo', s.is_demo
               )
               order by s.provider_id, s.capability
             )
        from prediction_sources s
       where s.prediction_id = p.id
    ),
    '[]'::jsonb
  ) as sources,
  -- Count only. Free/Basic users learn HOW MANY models ran and whether they
  -- agreed; they do not learn what each one said.
  (select count(*) from prediction_model_outputs mo where mo.prediction_id = p.id
     and not mo.abstained) as model_count
from predictions p
where p.org_id = platform_org_id()
   or p.org_id in (select current_org_ids());

-- security_barrier stops the planner from pushing a user-supplied, potentially
-- leaky function below the tenancy predicate above.
alter view predictions_public set (security_barrier = true);

-- Be explicit that this view is definer-run, on servers that support the option
-- (PG 15+). Explicit beats inherited-by-default for something this sensitive.
do $$
begin
  if current_setting('server_version_num')::int >= 150000 then
    execute 'alter view predictions_public set (security_invoker = false)';
  end if;
end
$$;

grant select on predictions_public to authenticated;
revoke all on predictions_public from anon;

comment on view predictions_public is
  'Tier-safe projection of predictions for Free/Basic surfaces: outcomes, confidence, factors and provenance, but never prediction_model_outputs. SECURITY DEFINER, so the org-visibility predicate lives inside the view body.';
comment on column predictions_public.model_count is
  'Number of non-abstaining models behind the prediction. Abstentions are excluded because an abstaining model contributed nothing — it is not a neutral vote.';
