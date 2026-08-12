-- Which name a congregation reads people by (0028).
--
-- A member is TWO names (0018) — the Chinese one and the English one — and
-- until now every list drew BOTH, stacked. The church's own feedback is that
-- this is noise: a congregation reads its people by one name, and which name
-- that is depends on the congregation. 中文堂 reads 张伟; 英文堂 and 马来文堂
-- read David.
--
-- So it is the HALL's property, not the member's and not the viewer's: 张伟
-- filed in 中文堂 reads 张伟 on every screen in the app, including a screen
-- somebody in 英文堂 is looking at. A person looks the same everywhere, which
-- is the whole reason `<MemberName />` is one component.
--
-- It is a stored code rather than a match on the hall's NAME (rule G8: never
-- key behaviour off a translated label). A church that renames 英文堂 to
-- "English Service" must not silently start reading it in Chinese, and a
-- fourth congregation added later says which name it reads by rather than
-- hoping its name contains the right word.
--
-- Only two values are needed and only two are allowed: 马来文堂 reads the
-- English name too — there is no separate Malay name column, and inventing a
-- third value that behaves identically to 'english' would be a value nobody
-- can act on.
alter table halls
  add column if not exists name_display text not null default 'chinese';

alter table halls
  drop constraint if exists halls_name_display_check;
alter table halls
  add constraint halls_name_display_check
  check (name_display in ('chinese', 'english'));

-- The seeded three (0008). Anything a church adds later starts at the default
-- and is changed deliberately.
update halls set name_display = 'english' where name in ('英文堂', '马来文堂');
update halls set name_display = 'chinese' where name = '中文堂';
