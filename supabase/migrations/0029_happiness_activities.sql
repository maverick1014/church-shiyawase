-- 幸福小组活动记录 (0029): what a group actually DID, on a date, with photos.
--
-- The weekly roll call (0022) answers "who came in week 5". It cannot answer
-- "what did we do" — and a 幸福小组 leader's own record of the term is exactly
-- that: an evening, a few photos, a line about how it went. Church feedback
-- asked for it in those words: 创作新日期然后自由的添加照片和备注，来记录.
--
-- Deliberately NOT hung off `happiness_attendance`'s week number. An activity
-- is dated (`happened_on`), because that is how the leader remembers it and
-- how the photos are filed; a week number is the roll call's own idea, and a
-- group that met twice in a week, or gathered outside the term, would have
-- nowhere to put the second record.
create table if not exists happiness_activities (
  id          uuid primary key default gen_random_uuid(),
  -- Deleting a group takes its activities with it, exactly as it takes its
  -- roster and its attendance: the records are ABOUT that group and mean
  -- nothing without it.
  group_id    uuid not null references happiness_groups(id) on delete cascade,
  happened_on date not null,
  title       text,
  notes       text,
  -- One column rather than a photos table, the same call `members.serving_roles`
  -- and `groups.tags` already make: the app only ever reads the whole list and
  -- writes the whole list back, so a join table would buy ordering nobody asks
  -- for at the cost of a second round trip on every read. NOT NULL DEFAULT
  -- '{}' so "no photos" and "nobody has said" are the same fact and no reader
  -- needs `?? []` to mean anything.
  photo_urls  text[] not null default '{}',
  created_at  timestamptz not null default now()
);

-- Every read is "this group's activities, newest first".
create index if not exists happiness_activities_group_idx
  on happiness_activities (group_id, happened_on desc);

-- Public bucket for the photos on those records, the fourth of exactly the same
-- kind as `avatars` (0004), `branding` (0012) and `payments` (0016): public
-- because the browser renders them straight from the URL, and the object path
-- carries the group id, the activity id and a timestamp so two uploads in the
-- same second cannot collide.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Rollback (manual — Supabase migrations are forward-only here):
--   drop table if exists happiness_activities;
--   delete from storage.buckets where id = 'photos';
-- Note the objects themselves are NOT removed by dropping the table; clear the
-- bucket first if the photos are meant to go too.
