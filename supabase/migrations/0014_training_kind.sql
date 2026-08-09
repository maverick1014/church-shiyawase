-- ===========================================================================
-- 培训&活动 (Trainings & Activities): one column that says which shape a row is.
-- ---------------------------------------------------------------------------
-- `/trainings` used to be the course catalog only. Everything that is neither
-- a Sunday nor a prayer meeting now lives there too — a brothers' hike, a
-- sisters' baking afternoon — because those are exactly what enrolment plus a
-- roll call already are.
--
-- A course and an activity are the SAME record in every other respect: they
-- both take sign-ups (`training_enrollments`) and both get ticked off
-- (`training_attendance` through `training_sessions`). The only real
-- difference is their shape:
--
--   course   — several sessions on several dates, ticked session by session.
--   activity — ONE occasion on one date: people sign up, you tick who came.
--
-- So this migration adds exactly one column, a stored discriminator, and
-- nothing else. Two rejected alternatives, for the record:
--
--  * "an activity is just a course with total_sessions = 1" — nothing to add,
--    but a one-session course is a real thing (a single workshop), so the page
--    would change shape behind the user's back the moment a course was
--    trimmed to one session, and back again when a second was added.
--  * "reuse `category`" — that column is a free-text DISPLAY tag the church
--    types its own values into (门徒 / 栽培 / 事奉). Keying behaviour off it
--    would mean renaming a tag silently rewires the page.
--
-- An activity's single occasion is NOT a new table: it is the one
-- `training_sessions` row the API creates with it, which is what gives the
-- attendance sheet its single column to tick. The occasion's DATE is the
-- training's own `starts_on` / `ends_on` (they are set to the same day), so
-- there is no second place a date can be edited.
--
-- Idempotent (`if not exists` / `drop constraint if exists`), like 0004 and
-- 0012 — re-applying it is a no-op rather than an error.
--
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED: /api/trainings
-- reads and writes `kind`, and the catalog page filters on it.
-- ===========================================================================

-- 'course' (the default) keeps every existing row exactly what it already was,
-- so applying this changes nothing visible until someone adds an activity.
alter table trainings
  add column if not exists kind text not null default 'course';

-- The two shapes the app ships. Kept as a CHECK rather than a Postgres enum for
-- the same reason `church_modules.module` is free text: the authoritative list
-- is the code (`TrainingKind` in packages/shared), and a check constraint is
-- one line to widen if a third shape ever appears.
alter table trainings
  drop constraint if exists trainings_kind_check;
alter table trainings
  add constraint trainings_kind_check check (kind in ('course', 'activity'));

-- ---------------------------------------------------------------------------
-- Rollback (manual — Supabase migrations are forward-only here):
--   alter table trainings drop constraint if exists trainings_kind_check;
--   alter table trainings drop column if exists kind;
-- ---------------------------------------------------------------------------
