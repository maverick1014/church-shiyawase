-- ===========================================================================
-- 循环聚会 (recurring events): removed. The calendar is not something the app
-- has to fill in any more.
-- ---------------------------------------------------------------------------
-- 0009/0010 existed for one reason: there was nothing to hang attendance off
-- unless an event row existed for the date, so a schedule manufactured them
-- ahead of time (每周日 10:00 主日崇拜, 每周三 20:00 祷告会) and 0010 added a
-- watermark so a deliberately deleted occurrence would not come straight back.
--
-- 0013 took that reason away for Sundays: the sheet IS the data, its columns
-- come from the calendar, and nothing manufactures a 主日崇拜 row any more.
-- What was left generating was the weeknight half — and the same argument
-- retires it too. 崇拜与祷告会 draws ONE roll-call sheet per month whose
-- columns are that month's Sundays plus the meetings someone genuinely added,
-- each in date order. A rule that pre-creates a row for every Wednesday is
-- then producing columns for meetings that may never happen, on a page whose
-- whole point is that a date needs no record to exist. Adding the occasional
-- prayer meeting by hand — a name and a date — is both less work and less to
-- get wrong than maintaining a schedule that quietly fills the sheet.
--
-- Nothing that was RECORDED is lost. The events those rules generated are
-- ordinary rows in `events` and stay exactly as they are, with their
-- attendance (`event_attendance`) — they only lose the (already nullable)
-- pointer back to the rule that created them. What goes is the schedule
-- itself, which was never attendance, only an instruction to create rows.
--
-- Idempotent (`if exists` throughout), like 0012 and 0014 — re-applying it is
-- a no-op rather than an error.
--
-- APPLY IT WITH (or after) THE CODE THAT STOPPED READING IT: the API no longer
-- serves /api/recurring-events and no longer tops the calendar up on
-- GET /events, so the table and the column are dead weight from that deploy on.
-- ===========================================================================

-- The link from a generated event back to its rule. Dropping the column takes
-- the two indexes 0009 created on it (`events_recurring_id_idx` and the
-- partial unique `events_recurring_slot`) with it — the top-up they made
-- idempotent no longer exists.
alter table events
  drop column if exists recurring_id;

-- …and the schedules themselves. No other table references it (the one FK was
-- the column above), so this needs no cascade.
drop table if exists recurring_events;

-- ---------------------------------------------------------------------------
-- Rollback (manual — Supabase migrations are forward-only here): re-apply
-- 0009 and 0010. The rules themselves are NOT recoverable — they were the
-- data this drops — so a rollback starts from an empty schedule table.
-- ---------------------------------------------------------------------------
