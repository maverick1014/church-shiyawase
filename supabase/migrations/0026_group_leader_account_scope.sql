-- ===========================================================================
-- Which group a group_leader account is scoped to
-- ---------------------------------------------------------------------------
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED.
--
-- `app_users` already carries `hall_id` (migration 0008) as a STORED column
-- rather than derived from the linked member at request time — this follows
-- that same precedent rather than inventing a second pattern: the account
-- carries its own scope, kept in sync by the application code that grants
-- and revokes it (whenever a member's 小组长 seat changes), the same way nothing
-- keeps `hall_id` in sync except the code that writes it.
--
-- Meaningful only for `account_role = 'group_leader'`; null for everyone
-- else, same convention as `hall_id` null meaning "not scoped to one".
-- `on delete set null`: deleting the GROUP must not delete the leader's
-- account — it just stops being scoped to anything until reassigned.
-- ===========================================================================

alter table app_users add column if not exists group_id uuid references groups(id) on delete set null;

comment on column app_users.group_id is
  'Which group a group_leader account is scoped to. NULL for every other role. Kept in sync by the server whenever a member''s 小组长 seat changes — not user-editable.';

-- ---------------------------------------------------------------------------
-- Rollback
--   alter table app_users drop column if exists group_id;
-- ---------------------------------------------------------------------------
