-- ===========================================================================
-- A BEST never carries a life group
-- ---------------------------------------------------------------------------
-- SEPARATE from 0031 on purpose: Postgres refuses to USE an enum value in the
-- same transaction that added it, so a constraint naming 'best' cannot live in
-- the migration that creates it. Run 0031 first, then this.
--
-- A BEST belongs to a 幸福小组, not to a 小组 — that is the whole shape of the
-- thing: they are being reached through the happiness group, and a life group
-- is what somebody joins after they belong. Enforced in the DATABASE and not
-- only in the form, for the same reason every other real rule here is: the
-- form is one of several ways a row is written (the import and the API are the
-- others), and a rule that lives in one of them is not a rule.
--
-- Which 幸福小组 they belong to is `happiness_group_members`, and that is
-- deliberately NOT made mandatory here: a BEST is often written down the
-- moment they are met, before anyone has decided which group they sit in, and
-- a constraint that refuses that would push the church into inventing a
-- placeholder group.
alter table members
  drop constraint if exists members_best_has_no_life_group;
alter table members
  add constraint members_best_has_no_life_group
  check (church_role <> 'best' or group_id is null);

-- ---------------------------------------------------------------------------
-- Rollback (manual — Supabase migrations are forward-only here):
--   alter table members drop constraint if exists members_best_has_no_life_group;
-- The enum value itself cannot be removed once added; nothing depends on that.
