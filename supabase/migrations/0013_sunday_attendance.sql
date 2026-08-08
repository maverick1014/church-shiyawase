-- ===========================================================================
-- 主日点名 (Sunday roll call): a sheet, not a pile of manufactured events.
-- ---------------------------------------------------------------------------
-- Every Sunday happens. Nobody needs to create one, and until now the API did
-- it for them: GET /events topped up a window of 主日崇拜 rows so there was
-- something to attach attendance to — first from a hardcoded weekly rule (whose
-- check-then-insert race is what 0005's unique index guards), then from the
-- 循环聚会 rules of 0009/0010 built on the same idea. That machinery existed
-- only to manufacture a row for a date the calendar already knows about.
--
-- So the sheet becomes the data. One row per (hall, Sunday, member) carrying
-- the two ticks that Sunday has:
--   pre_service — 会前祷告
--   service     — 主日崇拜
-- A Sunday with no ticks has no rows, which is exactly right: nothing was
-- recorded, rather than "an event existed and everyone was absent".
--
-- Each hall rolls its own call, including on a week the halls meet together —
-- there is no joint-service concept any more, only the same date appearing on
-- three sheets with three member lists.
--
-- `hall_id` is NOT redundant with the member's own hall: it records where the
-- person was counted **that Sunday**, so moving someone between halls later
-- never rewrites what was already taken.
--
-- `events` stays for the meetings someone genuinely adds by hand (the
-- occasional Wednesday prayer meeting) — a name, a date and a hall.
-- ===========================================================================

create table if not exists sunday_attendance (
  id           uuid primary key default gen_random_uuid(),
  hall_id      uuid not null references halls(id) on delete cascade,
  service_date date not null,
  member_id    uuid not null references members(id) on delete cascade,
  pre_service  boolean not null default false,
  service      boolean not null default false,
  updated_at   timestamptz not null default now(),
  unique (hall_id, service_date, member_id)
);

-- The sheet is always read as "one hall, one month", so that is the index.
create index if not exists sunday_attendance_hall_date_idx
  on sunday_attendance (hall_id, service_date);
-- …and a member's own attendance history, for their profile page.
create index if not exists sunday_attendance_member_idx
  on sunday_attendance (member_id, service_date desc);

create trigger sunday_attendance_set_updated_at
  before update on sunday_attendance
  for each row execute function set_updated_at();

-- A row where neither tick is set carries no information — it is what an
-- untouched cell already means. Keeping them would make "no rows" and "all
-- false" two spellings of the same fact, and the sheet would slowly fill with
-- rows for people who were never there.
alter table sunday_attendance
  add constraint sunday_attendance_not_empty check (pre_service or service);

-- Only Sundays belong on the Sunday sheet. Postgres counts 0 as Sunday.
alter table sunday_attendance
  add constraint sunday_attendance_is_sunday check (extract(dow from service_date) = 0);

-- The auto-created 主日崇拜 rows and the guard that kept them unique are both
-- obsolete: no code creates them any more. Dropping the index does not touch
-- any event that already exists — those stay readable as ordinary meetings.
drop index if exists events_unique_sunday_service;
