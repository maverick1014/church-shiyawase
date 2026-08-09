-- ===========================================================================
-- 服侍岗位 on a member
-- ---------------------------------------------------------------------------
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED. The member API
-- selects `serving_roles` by name; a Worker asking for a column that does not
-- exist yet fails the whole read, not just that field.
--
-- Which ministries a person serves in — 敬拜, 司琴, 招待, 音响, 投影, 儿童主日
-- 学 — is one of the first questions asked about a member, and the app had
-- nowhere to put it.
--
-- It is a `text[]` rather than one text column because a person serves in more
-- than one (敬拜 AND 音响 is the normal case, not the exception), and free text
-- rather than an enum for the same reason `trainings.pic` is: every church
-- invents a ministry nobody modelled, and an enum turns that into a migration.
-- This is exactly the shape `groups.tags` already has, so the UI reuses
-- `TagsInput` and its autocomplete-from-existing-values instead of inventing a
-- second way to enter a list of short strings.
--
-- Empty array, never null: "serves nowhere" and "nobody has said" are the same
-- fact here, and making one of them NULL only produces `?? []` at every reader.
--
-- Additive and idempotent — safe to apply while the current build is live.
-- ===========================================================================

alter table members add column if not exists serving_roles text[] not null default '{}';

comment on column members.serving_roles is
  '服侍岗位 — the ministries this member serves in (敬拜 / 司琴 / 招待 …). Free text, same shape as groups.tags. Empty array = not serving / not recorded.';

-- ---------------------------------------------------------------------------
-- Rollback
--   alter table members drop column if exists serving_roles;
-- ---------------------------------------------------------------------------
