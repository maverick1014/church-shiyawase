-- ===========================================================================
-- 循环聚会: remember how far each rule has already been generated.
-- ---------------------------------------------------------------------------
-- Without this the top-up decides purely from "is there an event at this exact
-- timestamp", which has two bugs:
--   1. Deleting a single occurrence (a public holiday, say) only makes it come
--      straight back on the next GET /events — the slot looks unfilled again.
--   2. Editing a rule's weekday/start_time makes every already-generated
--      occurrence in the window stop matching, so the whole window is
--      generated a second time at the new time.
-- Recording the last date a rule produced fixes both: generation only ever
-- looks at dates AFTER it.
--
-- Seeded to today so existing rules don't retroactively backfill.
-- ===========================================================================

alter table recurring_events
  add column generated_through date;

update recurring_events set generated_through = current_date;
