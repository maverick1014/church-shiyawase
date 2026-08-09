-- ===========================================================================
-- 幸福小组 — an add-on module, three levels deep
-- ---------------------------------------------------------------------------
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED.
--
-- Additive only: four new tables, nothing existing is touched. Safe to apply
-- while the current build is live — it simply never asks for them.
--
-- THE SHAPE, AND WHY IT IS NOT JUST `groups`
--
--   期 (term)  →  幸福小组 (group)  →  名单 + 每周点名
--
-- A life group is open-ended: it exists until it doesn't, and its roll call is
-- a calendar. A 幸福小组 is the opposite — it runs for a fixed number of weeks
-- as part of a numbered TERM (第11期), the whole term starts and finishes
-- together, and the church compares this term against the last one. That is a
-- different entity with a different lifetime, and modelling it as a life group
-- with extra columns would mean every life-group query carrying a "but not the
-- 幸福 ones" clause forever.
--
-- The roll call is BY WEEK NUMBER, not by date. Week 3 is week 3 whichever
-- Tuesday it fell on, groups within a term are compared week against week, and
-- a group that postpones a week does not slide out of alignment with the term
-- it belongs to. This is the one place in the app where an occasion is not a
-- date — and it is deliberate.
-- ===========================================================================

-- --- 期 --------------------------------------------------------------------
-- Church-wide, not per-congregation: 第11期 is one thing the whole church is
-- doing, and its groups carry the congregation. Several terms may overlap —
-- an old one finishing while the next begins is normal, so nothing here
-- enforces "one at a time".
--
-- `weeks` lives HERE rather than on each group: everything in a term runs the
-- same length, which is what makes a term comparable across its groups and
-- what makes "week 5" mean one thing on a report.
create table if not exists happiness_terms (
  id uuid primary key default gen_random_uuid(),
  term_no integer not null,
  name text,
  weeks integer not null default 8 check (weeks between 1 and 52),
  starts_on date,
  ends_on date,
  created_at timestamptz not null default now(),
  constraint happiness_terms_no_unique unique (term_no)
);

comment on table happiness_terms is
  '幸福小组的一期 — 第11期. Church-wide; `weeks` applies to every group in it.';

-- --- 幸福小组 ---------------------------------------------------------------
-- Deleting a term takes its groups with it: a group has no meaning outside the
-- term it ran in, and leaving orphans would put groups on screen that belong to
-- nothing. The term list is small and deleting one is a deliberate, confirmed
-- act (rule G3), so the cascade is the honest behaviour rather than a trap.
--
-- `hall_id` is NOT NULL, exactly like `groups`: a 幸福小组 meets somewhere and
-- belongs to a congregation, and the hall gate reads it (rule G2).
--
-- `leader_id` is 组长 — nullable while a term is being set up, and set null
-- rather than cascading if that member is deleted: losing the leader's name
-- must not delete the group and everyone's attendance with it.
create table if not exists happiness_groups (
  id uuid primary key default gen_random_uuid(),
  term_id uuid not null references happiness_terms(id) on delete cascade,
  name text not null,
  hall_id uuid not null references halls(id),
  leader_id uuid references members(id) on delete set null,
  meeting_day weekday,
  meeting_time time,
  location text,
  created_at timestamptz not null default now()
);

create index if not exists happiness_groups_term_idx on happiness_groups(term_id);
create index if not exists happiness_groups_hall_idx on happiness_groups(hall_id);

comment on table happiness_groups is
  'One 幸福小组 inside a term. Its hall is its own (the gate reads it); its length comes from the term.';

-- --- 名单 -------------------------------------------------------------------
-- Who is in this group, members and 福友 alike. A 福友 is an ordinary
-- `members` row carrying the 访客 church role (0021) — the same person, so when
-- they come to faith nothing has to be re-typed and their history follows them.
-- That is why this is a join table and not a second list of names.
--
-- One row per person per group; `on delete cascade` on both sides, because a
-- roster entry is meaningless without either end of it.
create table if not exists happiness_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references happiness_groups(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint happiness_group_members_unique unique (group_id, member_id)
);

create index if not exists happiness_group_members_group_idx
  on happiness_group_members(group_id);

-- --- 每周点名 ---------------------------------------------------------------
-- The same rule every roll call in this app follows: a row means present, and
-- unticking DELETES rather than storing a false. "Nobody marked week 4" and
-- "everybody was absent in week 4" are different facts, and only the absence of
-- rows can tell them apart.
--
-- `week_number` is checked against 1..52 here; the API additionally refuses a
-- week beyond the TERM's own `weeks`, because that bound lives on the term and
-- a check constraint cannot reach it.
create table if not exists happiness_attendance (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references happiness_groups(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  week_number integer not null check (week_number between 1 and 52),
  created_at timestamptz not null default now(),
  constraint happiness_attendance_unique unique (group_id, member_id, week_number)
);

create index if not exists happiness_attendance_group_idx
  on happiness_attendance(group_id);

-- ---------------------------------------------------------------------------
-- The module switch. `church_modules` records what this church runs; the
-- registry in `packages/shared` says which nav entry and which API prefixes
-- each module owns. Seeded ON for the church that asked for it — a church that
-- does not run 幸福小组 turns it off in 教会设置 and the whole section, nav
-- entry and API included, stops existing for them (404, not 403).
-- ---------------------------------------------------------------------------
insert into church_modules (church_id, module, enabled)
select id, 'happiness', true from church
on conflict (church_id, module) do nothing;

-- ---------------------------------------------------------------------------
-- Rollback
--   delete from church_modules where module = 'happiness';
--   drop table if exists happiness_attendance;
--   drop table if exists happiness_group_members;
--   drop table if exists happiness_groups;
--   drop table if exists happiness_terms;
-- ---------------------------------------------------------------------------
