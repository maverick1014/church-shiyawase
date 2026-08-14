-- 小组活动记录 (0030): the same record for a LIFE group that 0029 gave a 幸福小组.
--
-- Church feedback, in as many words: 然后 for the life group there also want to
-- have this feature. A life group's roll call answers who came on which Sunday;
-- nothing answered what the group actually DID — the hike, the dinner, the
-- photos — which is the half a leader wants back at the end of a year.
--
-- A SECOND table rather than one shared one with two nullable owners. The two
-- kinds of group are separate tables with separate permission gates, and a
-- shared table would have to carry a pair of nullable FKs plus a check
-- constraint to say "exactly one of these", which buys nothing here: the app
-- never reads both at once and never moves a record from one kind of group to
-- the other. Each table keeps a real, NOT NULL, cascading FK to its own owner,
-- which is what actually protects the data. The route handler and the page ARE
-- shared (rule G4) — the duplication stops at the schema, where it earns
-- something.
create table if not exists group_activities (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references groups(id) on delete cascade,
  happened_on date not null,
  title       text,
  notes       text,
  -- Same call as `happiness_activities.photo_urls` (0029), and as
  -- `members.serving_roles` / `groups.tags` before it: the app only ever reads
  -- and writes the whole list, so a join table would buy ordering nobody asks
  -- for at the cost of a second round trip. NOT NULL DEFAULT '{}' so "no
  -- photos" and "nobody has said" are the same fact.
  photo_urls  text[] not null default '{}',
  created_at  timestamptz not null default now()
);

-- Every read is "this group's activities, newest first".
create index if not exists group_activities_group_idx
  on group_activities (group_id, happened_on desc);

-- The photos live in the SAME public bucket 0029 created (`photos`), under a
-- different path prefix — one bucket per KIND of image, not one per feature,
-- which is why `avatars` / `branding` / `payments` / `photos` is still the
-- whole list. 0029 already creates it; this is here so a database that somehow
-- has 0030 without 0029 still works.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Rollback (manual — Supabase migrations are forward-only here):
--   drop table if exists group_activities;
-- The bucket is shared with 0029 and is deliberately NOT dropped here.
