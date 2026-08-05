-- ===========================================================================
-- Multi-hall (多堂会) support: 中文堂 / 英文堂 / 马来文堂.
-- ---------------------------------------------------------------------------
-- One shared database — a hall is a scope column, not a separate deployment.
--   members / groups : hall_id REQUIRED (a person and a life group belong to
--                      exactly one hall; no cross-hall membership).
--   trainings/events : hall_id NULLABLE — null means "open to every hall"
--                      (a combined service, or a course anyone may join).
--   app_users        : hall_id NULLABLE — null means full (all-hall) access;
--                      a value scopes that staff account to a single hall.
-- Existing data predates the split and is all Chinese-hall, so everything is
-- backfilled to 中文堂 before the NOT NULL constraints go on. Existing accounts
-- stay null = full access.
-- ===========================================================================

create table halls (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int  not null default 0,
  -- Whether GET /events auto-creates this hall's upcoming 主日崇拜. Only the
  -- Chinese hall is live today; flip this on when another hall starts meeting
  -- so we don't invent services for halls that aren't running yet.
  auto_sunday_service boolean not null default false,
  created_at timestamptz not null default now()
);

insert into halls (name, sort_order, auto_sunday_service) values
  ('中文堂', 1, true),
  ('英文堂', 2, false),
  ('马来文堂', 3, false);

alter table members   add column hall_id uuid references halls(id) on delete restrict;
alter table groups    add column hall_id uuid references halls(id) on delete restrict;
alter table trainings add column hall_id uuid references halls(id) on delete restrict;
alter table events    add column hall_id uuid references halls(id) on delete restrict;
alter table app_users add column hall_id uuid references halls(id) on delete restrict;

-- Backfill: every pre-existing record belongs to the Chinese hall.
update members   set hall_id = (select id from halls where name = '中文堂') where hall_id is null;
update groups    set hall_id = (select id from halls where name = '中文堂') where hall_id is null;
update trainings set hall_id = (select id from halls where name = '中文堂') where hall_id is null;
update events    set hall_id = (select id from halls where name = '中文堂') where hall_id is null;

-- Members and groups must always carry a hall (trainings/events/app_users stay
-- nullable on purpose — see the header).
alter table members alter column hall_id set not null;
alter table groups  alter column hall_id set not null;

create index members_hall_id_idx   on members (hall_id);
create index groups_hall_id_idx    on groups (hall_id);
create index trainings_hall_id_idx on trainings (hall_id);
create index events_hall_id_idx    on events (hall_id);

-- Discipleship pairs carry no hall of their own — a pair's hall is its
-- mentor's. Surface it on the summary view so the pastor overview can be
-- scoped without a second round-trip.
create or replace view discipleship_pair_summary as
  SELECT p.id AS pair_id,
    p.program_id,
    prog.total_days,
    p.mentor_id,
    mentor.full_name AS mentor_name,
    p.trainee_id,
    trainee.full_name AS trainee_name,
    p.status,
    count(dp.*) FILTER (WHERE dp.completed) AS days_completed,
    round(100.0 * count(dp.*) FILTER (WHERE dp.completed)::numeric / NULLIF(prog.total_days, 0)::numeric) AS percent_complete,
    -- appended last: `create or replace view` only allows adding columns at
    -- the end, and a pair's hall is its mentor's hall.
    mentor.hall_id AS hall_id
   FROM discipleship_pairs p
     JOIN discipleship_programs prog ON prog.id = p.program_id
     JOIN members mentor ON mentor.id = p.mentor_id
     JOIN members trainee ON trainee.id = p.trainee_id
     LEFT JOIN discipleship_progress dp ON dp.pair_id = p.id
  GROUP BY p.id, prog.total_days, mentor.full_name, mentor.hall_id, trainee.full_name;

-- The Sunday-service de-dup guard from 0005 keyed on starts_at alone, which
-- would now reject a second hall holding its own service at the same hour
-- (中文堂 10:00 and 英文堂 10:00 are different events). Re-key it per hall.
-- `nulls not distinct` keeps the guard working for all-hall (null) services.
drop index if exists events_unique_sunday_service;
create unique index events_unique_sunday_service
  on events (starts_at, hall_id) nulls not distinct
  where event_type = 'service';
