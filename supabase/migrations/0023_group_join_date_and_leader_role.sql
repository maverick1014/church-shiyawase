-- ===========================================================================
-- A life-group join date, and a role for an auto-provisioned group leader
-- ---------------------------------------------------------------------------
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED — same rule as
-- every other additive migration in this app: the Worker selects columns by
-- name, and a name it does not find fails the whole read.
--
-- ---------------------------------------------------------------------------
-- 1. WHEN SOMEBODY WENT INTO A LIFE GROUP
-- ---------------------------------------------------------------------------
-- `members.joined_at` already exists and is already nullable — it is the date
-- somebody joined the CHURCH, and plenty of existing members were never asked
-- for one, so it stays optional and a blank one is simply excluded from any
-- report built on it (never defaulted, never required).
--
-- Which life group somebody is in is a separate fact (`members.group_id`),
-- and so is WHEN they went into it — a person can join the church years
-- before they join a group, or the other way round for someone invited
-- straight into a small group. One member, one group at a time (the existing
-- model), so this is a single nullable date column, not a history table:
-- moving somebody to a different group naturally overwrites when they joined
-- THAT one, which is exactly the fact the form is asking for.
-- ---------------------------------------------------------------------------

alter table members add column if not exists group_joined_at date;

comment on column members.group_joined_at is
  '加入小组日期 — when this member joined their CURRENT group. Nullable and excluded from reports when blank, same as joined_at.';

-- ---------------------------------------------------------------------------
-- 2. A ROLE FOR A GROUP LEADER'S AUTO-PROVISIONED ACCOUNT
-- ---------------------------------------------------------------------------
-- Placed between coworker and readonly in privilege order: a group leader's
-- account can do real writes (their own group's roster and roll call) but far
-- less than a coworker's church-wide reach, and more than a read-only view.
-- The application code that grants/scopes this role lands separately; this
-- migration only makes the value legal to store.
-- ---------------------------------------------------------------------------

alter type account_role add value if not exists 'group_leader' after 'coworker';

-- ---------------------------------------------------------------------------
-- Rollback
--   alter table members drop column if exists group_joined_at;
--   -- enum values cannot be removed without recreating the type; leaving
--   -- group_leader in place is harmless if unused.
-- ---------------------------------------------------------------------------
