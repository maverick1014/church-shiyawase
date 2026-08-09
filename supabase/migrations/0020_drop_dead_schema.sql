-- ===========================================================================
-- The columns and tables nothing ever read
-- ---------------------------------------------------------------------------
-- APPLY THIS **AFTER** THE CODE THAT STOPS TOUCHING THEM IS DEPLOYED — the
-- opposite order from an additive migration, and deliberately so. The live
-- build still embeds `households` in MEMBER_SELECT, still inserts
-- `group_meetings.note`, and still writes `training_attendance.notes`;
-- dropping any of those under it would fail the whole request, not just the
-- field. Additive first, removals last.
--
-- Everything below was checked against the code, not guessed: no page renders
-- it, no form collects it, no query selects it — or it is written and never
-- read back by anything.
--
-- WHY BOTHER
--
-- A column nobody fills is not free. It shows up in every `select *`, in every
-- generated type, in the shape a reviewer has to hold in their head, and — the
-- expensive one — a FIELD nobody can fill reads on screen as "the church has
-- not got round to this yet" rather than as absent. Schema that outlives its
-- feature is the residue this migration is here to clear.
--
-- Anything genuinely in use was left alone: `members.notes` (the 备注 field on
-- the member form), `training_enrollments.progress` + `completed_at` (the
-- training record on a member's page), `discipleship_progress.entry_date` and
-- `.notes` (the mentor form and the day dialog), `halls.sort_order`,
-- `church.short_name`, `training_sessions.scheduled_at` / `.location`, and
-- `events.event_type`.
-- ===========================================================================

-- --- 奉献 ------------------------------------------------------------------
-- The feature was removed; the table stayed behind holding nothing. No route
-- serves `/donations`, no page exists, no nav entry points at one, and the
-- table has 0 rows. The account switch that opted into a donation summary
-- nobody sends goes with it.
drop table if exists donations;
drop type if exists donation_method;

-- --- households ------------------------------------------------------------
-- Seeded by 0001 and never given a way in: no page creates a household, no
-- form assigns one, and the member detail page rendered the name read-only —
-- so that field has read "—" for every member since the day it shipped.
-- 0 households, 0 members carrying one. Replaced by 服侍岗位 (0019), which is
-- a thing the church actually tracks.
alter table members drop column if exists household_id;
drop table if exists households;

-- --- notifications that were never sent ------------------------------------
-- Three switches on 账户详情 that stored a preference nothing acts on: the
-- codebase has no mailer and no push of any kind. A switch that promises a
-- reminder and delivers none is worse than no switch. They come back with the
-- sending half, not before it.
alter table app_users drop column if exists notify_discipleship;
alter table app_users drop column if exists notify_donation;
alter table app_users drop column if exists notify_weekly;

-- --- two-factor ------------------------------------------------------------
-- A boolean no screen has ever rendered and no login path has ever consulted.
-- Real 2FA needs a secret, a verification step and recovery codes; this column
-- is not a head start on any of that.
alter table app_users drop column if exists two_factor;

-- --- a meeting is a title, a date and a congregation ------------------------
-- The 聚会 form asks for exactly those three. `description`, `location` and
-- `ends_at` have been nullable spectators since the first migration — never
-- collected, never displayed, and not in the sheet's own column payload.
alter table events drop column if exists description;
alter table events drop column if exists location;
alter table events drop column if exists ends_at;

-- --- attendance is a tick, not a record card -------------------------------
-- Every roll call in this app stores one fact — present, or no row at all.
-- These are the leftovers of a richer shape nothing ever wrote: the timestamps
-- are defaulted and never read, and the notes are written as NULL by the
-- handler and read by nobody.
alter table event_attendance drop column if exists checked_in_at;
alter table event_attendance drop column if exists notes;
alter table training_attendance drop column if exists checked_at;
alter table training_attendance drop column if exists notes;
alter table training_enrollments drop column if exists notes;
alter table training_sessions drop column if exists notes;
alter table group_meetings drop column if exists note;

-- ---------------------------------------------------------------------------
-- Rollback: the shapes can be recreated; the data cannot, because there was
-- none — every column dropped here was NULL or default in every row.
-- ---------------------------------------------------------------------------
