-- =============================================================================
-- 0009_advisor_fixes (down)
--
-- Restore the 0007 state: the SECURITY DEFINER predictions_public view with
-- the inline model_count subquery, no prediction_model_count helper, and the
-- two search_path pins removed.
-- =============================================================================

-- The view must be replaced before the helper can be dropped (it references it).
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
  (select count(*) from prediction_model_outputs mo where mo.prediction_id = p.id
     and not mo.abstained) as model_count
from predictions p
where p.org_id = platform_org_id()
   or p.org_id in (select current_org_ids());

alter view predictions_public set (security_barrier = true);

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

drop function if exists prediction_model_count(uuid);

alter function set_updated_at() reset search_path;
alter function platform_org_id() reset search_path;
