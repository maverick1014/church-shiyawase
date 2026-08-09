-- ===========================================================================
-- households — the trailing edge of a feature that was never built
-- ---------------------------------------------------------------------------
-- APPLY THIS **AFTER** THE CODE THAT STOPS SELECTING IT IS DEPLOYED — the
-- opposite order from every other migration here, and deliberately so. The
-- currently-live `MEMBER_SELECT` embeds `household:households(id,name)`, so
-- dropping the table while that build is serving would fail every member read
-- in the app, not just the field. Additive migrations go first; a removal goes
-- last.
--
-- `households` was seeded by 0001 and never given a way in: no page creates a
-- household, no form assigns one, and the member detail page rendered the name
-- read-only — so the field has shown "—" for every member since the day it
-- shipped. On the live database when this was written: 0 households, 0 members
-- carrying one. It is not a feature waiting to be finished; it is a table that
-- never held anything, and a field nobody can fill is worse than no field —
-- it reads as "the church has not filled this in yet" rather than as absent.
--
-- If households come back, they come back as a real feature with a page of
-- their own (rule G1), not as a stub that predates it.
--
-- The column goes first so the table has no dependants left
-- (`members_household_id_fkey` is its only one).
-- ===========================================================================

alter table members drop column if exists household_id;
drop table if exists households;

-- ---------------------------------------------------------------------------
-- Rollback: the shape can be recreated, the data cannot — there was none.
--   create table households (
--     id uuid primary key default gen_random_uuid(),
--     name text not null,
--     created_at timestamptz not null default now()
--   );
--   alter table members add column household_id uuid references households(id);
-- ---------------------------------------------------------------------------
