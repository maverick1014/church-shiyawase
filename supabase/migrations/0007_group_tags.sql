-- ===========================================================================
-- Groups: free-form custom tags (e.g. 年轻人/职青/老年人/晚上/早上) for
-- filtering and segmentation. Additive only.
-- ===========================================================================
alter table groups
  add column tags text[] not null default '{}';
