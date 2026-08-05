-- ===========================================================================
-- 循环聚会 (recurring events): replace the hardcoded "every Sunday 10:00 主日
-- 崇拜" rule with configurable schedules managed from the UI.
-- ---------------------------------------------------------------------------
-- Generation stays lazy (GET /events tops up the window) — no cron needed: the
-- schedule is always current for anyone actually looking at it. See 0010 for
-- the watermark that stops a deleted occurrence from being re-created.
--
-- Deleting a rule NEVER deletes the events it already produced (they carry
-- attendance records) — `on delete set null` just unlinks them, and the rule
-- simply stops generating new ones.
-- ===========================================================================

create table recurring_events (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  event_type     event_type not null default 'service',
  weekday        weekday not null,
  start_time     time not null,
  location       text,
  -- null = 全堂 / 联合聚会, same meaning as events.hall_id.
  hall_id        uuid references halls(id) on delete restrict,
  -- How far ahead to keep the calendar filled. 35 ≈ one month plus a buffer,
  -- so next month's schedule is always visible.
  lookahead_days int  not null default 35 check (lookahead_days between 1 and 365),
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

alter table events
  add column recurring_id uuid references recurring_events(id) on delete set null;

create index events_recurring_id_idx on events (recurring_id);

-- One generated event per rule per timestamp — makes the top-up idempotent and
-- turns a concurrent double-insert into a rejected row instead of a duplicate.
create unique index events_recurring_slot
  on events (recurring_id, starts_at)
  where recurring_id is not null;

-- Carry over the rule that used to live in the route handler as constants
-- (SUNDAY_SERVICE_TIME / SUNDAY_SERVICE_LOCATION), one per hall that had
-- auto_sunday_service switched on — today just 中文堂.
insert into recurring_events (title, event_type, weekday, start_time, location, hall_id)
select '主日崇拜', 'service', 'sunday', '10:00:00', '大堂', h.id
from halls h
where h.auto_sunday_service;

-- halls.auto_sunday_service is now redundant: whether a hall auto-creates
-- services is expressed by having a recurring rule for it.
alter table halls drop column auto_sunday_service;
