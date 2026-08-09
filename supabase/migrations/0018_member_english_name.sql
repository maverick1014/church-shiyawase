-- ===========================================================================
-- A person is a Chinese name AND an English name — and that pair is who they are
-- ---------------------------------------------------------------------------
-- `members.full_name` has always been the CHINESE name: it is what the church
-- types, what every list is sorted by, and what the public sign-up form matches
-- on. Beside it sat `chinese_name`, a nullable second name the UI has been
-- labelling "昵称 / 别名" — so the column called `chinese_name` was the one
-- thing on the row that was never the Chinese name. It is renamed to
-- `english_name`, which is what the church actually keeps there and what the
-- form now asks for. Renaming rather than adding-and-deprecating, because
-- there is no other reader: the API selects it by name in one file and the two
-- forms write it. Leaving a lying name in place is the more expensive mistake.
--
-- The rename is the small half. The point of this migration is the UNIQUE
-- INDEX below: from here on a member is identified by the PAIR of names, not
-- by either one alone.
--
--   * Case- and whitespace-insensitive (`lower(btrim(…))`), because "john tan"
--     typed at 11pm and "John Tan " pasted from a spreadsheet are one person,
--     and a duplicate that differs only in capitalisation is exactly the kind
--     nobody spots.
--   * "No English name" is its own value (`coalesce(english_name, '')`) rather
--     than NULL. A plain unique index would treat NULLs as all-distinct and let
--     an unlimited number of 张伟-with-no-English-name rows in, which is the
--     case this is here to refuse.
--
-- What that REFUSES, deliberately: a second 张伟 with no English name. Two
-- people who genuinely share a Chinese name must now be told apart by their
-- English names before either can be saved. That is the trade this buys — with
-- the pair unique, an import (or a re-import) can say "this is the same person,
-- update them" instead of quietly inserting a second copy, and the roll-call
-- sheets stop growing twins that each hold half of somebody's attendance.
-- The API turns the violation into a 409 naming the two names, so a user sees
-- "somebody is already filed under this pair" rather than a Postgres error.
--
-- Verified before writing this: `select full_name, chinese_name, count(*) from
-- members group by 1,2 having count(*) > 1` returns no rows on the live
-- database, so the index builds without anything to clean up first.
--
-- Idempotent (a guarded `do` block for the rename, `if not exists` for the
-- index), like 0012, 0016 and 0017 — re-applying it is a no-op rather than an
-- error.
--
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED: the API selects
-- `english_name` by name (member lists, every roll-call sheet, the account
-- table) and both member forms write it.
-- ===========================================================================

-- The rename itself. Guarded on both sides so a second run — or a database
-- that already has `english_name` — does nothing instead of failing.
do $$
begin
  if exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'members'
           and column_name = 'chinese_name')
     and not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'members'
           and column_name = 'english_name')
  then
    alter table members rename column chinese_name to english_name;
  end if;
end $$;

-- The identity of a person: the two names together, compared the way a human
-- reads them (trimmed, case-insensitive) and with "no English name" counting as
-- a value of its own rather than as "unknown, therefore distinct".
create unique index if not exists members_name_pair_key
  on members (lower(btrim(full_name)), lower(btrim(coalesce(english_name, ''))));

-- ---------------------------------------------------------------------------
-- Rollback (manual — Supabase migrations are forward-only here):
--   drop index if exists members_name_pair_key;
--   alter table members rename column english_name to chinese_name;
-- Dropping the index loses no data; it only allows duplicate pairs back in.
-- ---------------------------------------------------------------------------
