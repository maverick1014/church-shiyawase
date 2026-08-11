-- ===========================================================================
-- 幸福小组's own roster role — independent of church_role / group_position
-- ---------------------------------------------------------------------------
-- A roster member's role WITHIN this happiness group (e.g. 组长/组员) has
-- nothing to do with their church-wide role (church_role) or their life
-- group's own position (group_position) — those are two different
-- memberships, and the roster used to borrow one of them, which read wrong.
-- Free text, like serving_roles/notes elsewhere: this church's own words for
-- it, not an enum nobody asked for. Nullable — "not set" is the ordinary case
-- for a fresh roster row.
-- ===========================================================================
alter table happiness_group_members add column if not exists role text;

comment on column happiness_group_members.role is
  '幸福小组内的角色（如组长/组员），与教会身份、小组职位无关，仅在本小组内生效。';

-- ---------------------------------------------------------------------------
-- Rollback
--   alter table happiness_group_members drop column if exists role;
-- ---------------------------------------------------------------------------
