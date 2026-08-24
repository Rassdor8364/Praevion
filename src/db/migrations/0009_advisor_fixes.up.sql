-- =============================================================================
-- 0009_advisor_fixes
--
-- Fixes for the Supabase security advisor, run 2026-08-12.
--
-- ERROR fixed here:
--   security_definer_view on public.predictions_public.
--
-- 0007 made the view SECURITY DEFINER for exactly one reason: `model_count`
-- counts rows of prediction_model_outputs, whose SELECT policy is gated to
-- Pro+, and Free/Basic users are still allowed to learn HOW MANY models ran.
-- Every other column of the view is already reachable under the caller's own
-- RLS: predictions_select / prediction_factors_select /
-- prediction_sources_select grant precisely the rows the view's in-body
-- tenancy predicate exposes.
--
-- So the definer surface shrinks from the whole view to one narrow function:
--   * predictions_public becomes SECURITY INVOKER — the querying user's RLS
--     applies, and the in-body tenancy predicate is retained as defence in
--     depth rather than as the only line.
--   * prediction_model_count() is the one remaining SECURITY DEFINER piece —
--     it returns a count and nothing else, refuses to count predictions the
--     caller cannot read, pins its search_path, and is not executable by anon.
--
-- WARNs fixed opportunistically (one-line, zero-risk):
--   function_search_path_mutable on set_updated_at and platform_org_id — the
--   same pin 0007 already applied to the other helper functions.
--
-- WARNs deliberately NOT touched (noted for the record):
--   * anon/authenticated can execute the SECURITY DEFINER helpers
--     (current_org_ids, is_org_admin, current_tier_at_least, rls_auto_enable):
--     authenticated execute is REQUIRED — RLS policies evaluate these with the
--     querying user's privileges — and they leak nothing (they answer only
--     about the caller's own memberships).
--   * extension `vector` in public: moving an in-use extension's schema is a
--     coordinated change (index rebuild + search_path audit), not an advisory
--     hotfix.
--   * auth_rls_initplan on user_profiles / notifications: performance-only;
--     wrap auth.uid() in (select auth.uid()) in a later migration if those
--     tables ever grow hot.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. search_path pins (function_search_path_mutable)
-- -----------------------------------------------------------------------------

alter function set_updated_at() set search_path = public, pg_catalog;
alter function platform_org_id() set search_path = public, pg_catalog;

-- -----------------------------------------------------------------------------
-- 2. The one remaining definer surface: a count, not the rows
-- -----------------------------------------------------------------------------

-- SECURITY DEFINER on purpose and with a guard: prediction_model_outputs is
-- Pro+-gated by RLS, but the COUNT of non-abstaining models is Free-tier
-- information (0007's model_count column). The exists() check means the
-- function answers only about predictions the caller could read anyway, so it
-- is not an oracle over other tenants' data.
create or replace function prediction_model_count(p_prediction_id uuid)
returns bigint
language sql
stable
security definer
as $$
  select count(*)
    from prediction_model_outputs mo
   where mo.prediction_id = p_prediction_id
     and not mo.abstained
     and exists (
       select 1
         from predictions p
        where p.id = p_prediction_id
          and can_read_org_row(p.org_id)
     )
$$;

alter function prediction_model_count(uuid) set search_path = public, pg_catalog;

revoke all on function prediction_model_count(uuid) from public;
revoke all on function prediction_model_count(uuid) from anon;
grant execute on function prediction_model_count(uuid) to authenticated, service_role;

comment on function prediction_model_count(uuid) is
  'Number of non-abstaining models behind a prediction the caller is allowed to read; 0 otherwise. The single SECURITY DEFINER remnant of the old predictions_public definer view: Free/Basic users may learn HOW MANY models ran without the Pro+ right to read what each one said.';

-- -----------------------------------------------------------------------------
-- 3. predictions_public becomes SECURITY INVOKER
-- -----------------------------------------------------------------------------

-- Identical body to 0007 except model_count goes through the helper. The
-- tenancy predicate stays in the body even though the caller's RLS now also
-- applies: belt and braces on the one view that fronts the accuracy record.
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
  -- Count only, via the definer helper. Free/Basic users learn HOW MANY models
  -- ran and whether they agreed; they do not learn what each one said.
  prediction_model_count(p.id) as model_count
from predictions p
where p.org_id = platform_org_id()
   or p.org_id in (select current_org_ids());

-- INVOKER, not DEFINER: the advisor ERROR this migration exists to fix.
alter view predictions_public set (security_invoker = true);

-- security_barrier still stops the planner from pushing a user-supplied,
-- potentially leaky function below the tenancy predicate.
alter view predictions_public set (security_barrier = true);

-- Re-state the grants: create or replace preserves them, but this migration
-- must not depend on that.
grant select on predictions_public to authenticated;
revoke all on predictions_public from anon;

comment on view predictions_public is
  'Tier-safe projection of predictions for Free/Basic surfaces: outcomes, confidence, factors and provenance, but never prediction_model_outputs. SECURITY INVOKER since 0009 — the caller''s RLS applies, the in-body tenancy predicate is defence in depth, and the model-count entitlement lives in prediction_model_count().';
comment on column predictions_public.model_count is
  'Number of non-abstaining models behind the prediction. Abstentions are excluded because an abstaining model contributed nothing — it is not a neutral vote.';
