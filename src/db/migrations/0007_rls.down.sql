-- =============================================================================
-- 0007_rls (down)
--
-- Reversing RLS means: drop the view, drop every policy, turn RLS off on every
-- table that had it turned on, drop the helper functions, and give back the
-- grants. The policies are dropped by iterating pg_policies rather than by
-- naming eighty of them, because a hand-maintained list is exactly the kind of
-- thing that drifts from the up migration and leaves a stray policy behind.
--
-- The auth.uid() shim and the anon/authenticated/service_role roles are NOT
-- dropped: on Supabase they were never ours to create, and on a scratch
-- database leaving them costs nothing.
-- =============================================================================

drop view if exists predictions_public;

do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;

  for p in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and c.relrowsecurity
  loop
    execute format('alter table public.%I disable row level security', p.relname);
  end loop;
end
$$;

drop function if exists can_read_org_row(uuid);
drop function if exists current_tier_at_least(subscription_tier);
drop function if exists is_org_admin(uuid);
drop function if exists current_org_ids();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke select, insert, update, delete on all tables in schema public from authenticated';
    execute 'alter default privileges in schema public revoke select, insert, update, delete on tables from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke select on all tables in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on all tables in schema public from service_role';
    execute 'alter default privileges in schema public revoke all on tables from service_role';
  end if;
end
$$;
