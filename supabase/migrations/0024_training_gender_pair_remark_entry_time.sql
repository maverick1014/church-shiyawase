-- ===========================================================================
-- A gender restriction on a training/activity, a general remark on a pair,
-- and a time alongside a mentor's daily entry date
-- ---------------------------------------------------------------------------
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED — same rule as
-- every other additive migration in this app.
--
-- ---------------------------------------------------------------------------
-- 1. SOME ACTIVITIES ARE FOR ONE GENDER
-- ---------------------------------------------------------------------------
-- A sisters' baking afternoon, a brothers' hike — 培训&活动 already covers both
-- shapes (course and activity), and some of them are set for one gender only.
-- Reuses the same `gender_type` members already use (`male`/`female`/`other`)
-- rather than inventing a second enum for the same concept. NULL = open to
-- everyone, the ordinary case for most trainings.
-- ---------------------------------------------------------------------------

alter table trainings add column if not exists gender gender_type;

comment on column trainings.gender is
  'NULL = open to any gender. Set = this training/activity is restricted to that gender; enforced at sign-up.';

-- ---------------------------------------------------------------------------
-- 2. A GENERAL REMARK ON A PAIR
-- ---------------------------------------------------------------------------
-- Separate from a single day's notes (discipleship_progress.notes, which is
-- that day's own remark) — this is a note about the PAIR itself: how they
-- were matched, a caution, anything a pastor wants to leave for whoever
-- reads the pair next. Free text, nullable, blank by default.
-- ---------------------------------------------------------------------------

alter table discipleship_pairs add column if not exists remark text;

comment on column discipleship_pairs.remark is
  'A general note about the PAIR itself, distinct from a single day''s notes.';

-- ---------------------------------------------------------------------------
-- 3. A TIME ALONGSIDE A DAY'S ENTRY DATE
-- ---------------------------------------------------------------------------
-- `discipleship_progress.entry_date` already exists and stays a plain date;
-- this adds the time of day as its own nullable column rather than widening
-- entry_date to a timestamp, matching how this app already keeps a date and
-- a time as two columns elsewhere (e.g. groups.meeting_time,
-- trainings' own session start_time) instead of one combined timestamp.
-- ---------------------------------------------------------------------------

alter table discipleship_progress add column if not exists entry_time time;

comment on column discipleship_progress.entry_time is
  'Time of day alongside entry_date. Nullable — a day marked without a time is still a valid entry.';

-- ---------------------------------------------------------------------------
-- Rollback
--   alter table discipleship_progress drop column if exists entry_time;
--   alter table discipleship_pairs drop column if exists remark;
--   alter table trainings drop column if exists gender;
-- ---------------------------------------------------------------------------
