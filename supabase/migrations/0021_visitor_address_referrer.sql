-- ===========================================================================
-- 访客, an address, and who brought them
-- ---------------------------------------------------------------------------
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED — the member API
-- selects these columns by name, and a Worker asking for one that does not
-- exist fails the whole read.
--
-- ---------------------------------------------------------------------------
-- 1. THE ENUM WAS TWO VALUES SHORT, AND HAS BEEN SINCE 执事/同工 SHIPPED
-- ---------------------------------------------------------------------------
-- `church_role` on the live database held exactly `pastor` and `member`, while
-- the app has been offering 执事 (deacon) and 同工 (co_worker) in the member
-- form and colouring badges for them all along. Saving a member as either one
-- did not "not work well" — it failed outright, because Postgres refuses a
-- value the type does not have. The migration that was meant to add them never
-- reached this database (it was one of the ones that could not be applied at
-- the time), and nothing since then noticed: the code enum and the database
-- enum are two lists that no test compares.
--
-- So this adds the two that were missing as well as the new one.
--
-- 访客 (visitor) is the new one: somebody who has come but is not a member of
-- the church. It is a CHURCH role rather than a status, because "visitor" is
-- what they are to the church, not whether their record is active — a visitor
-- who stops coming is an inactive visitor, and both facts are worth keeping.
--
-- Placed in reading order (牧师 → 执事 → 同工 → 成员 → 访客) with BEFORE/AFTER
-- so `order by church_role` sorts the way a person would list them.
-- ===========================================================================

alter type church_role add value if not exists 'deacon' after 'pastor';
alter type church_role add value if not exists 'co_worker' after 'deacon';
alter type church_role add value if not exists 'visitor' after 'member';

-- ---------------------------------------------------------------------------
-- 2. AN ADDRESS
-- ---------------------------------------------------------------------------
-- One free-text column, not a set of structured lines. A church visits people
-- and posts things to them; what it needs is what you would write on an
-- envelope, and every attempt to model a Malaysian address as street / unit /
-- postcode / state ends up with half the rows working around the shape.
-- ---------------------------------------------------------------------------

alter table members add column if not exists address text;

comment on column members.address is
  'Free text, as you would write it on an envelope. Deliberately not structured.';

-- ---------------------------------------------------------------------------
-- 3. WHO BROUGHT THEM
-- ---------------------------------------------------------------------------
-- Nullable and null by default, because "nobody referred them" is the ordinary
-- case and must not need a placeholder row to say so — the form's default is
-- 无推荐人 and that is simply NULL.
--
-- `on delete set null`: deleting the member who invited someone must not delete
-- the person they invited, and must not fail either. The referral is a fact
-- about how somebody arrived; losing the name is acceptable, losing the person
-- is not.
--
-- No constraint stops a chain (A referred B referred C) or a cycle — a church
-- record is not a tree and enforcing one would only refuse honest data. Self-
-- reference IS refused, since it says nothing.
-- ---------------------------------------------------------------------------

alter table members add column if not exists referred_by uuid
  references members(id) on delete set null;

alter table members drop constraint if exists members_referred_by_not_self;
alter table members add constraint members_referred_by_not_self
  check (referred_by is null or referred_by <> id);

create index if not exists members_referred_by_idx on members(referred_by);

comment on column members.referred_by is
  '推荐人 — the member who brought this person. NULL = 无推荐人, the ordinary case.';

-- ---------------------------------------------------------------------------
-- Rollback
--   drop index if exists members_referred_by_idx;
--   alter table members drop constraint if exists members_referred_by_not_self;
--   alter table members drop column if exists referred_by;
--   alter table members drop column if exists address;
--   -- enum values cannot be removed without recreating the type; leaving the
--   -- three in place is harmless.
-- ---------------------------------------------------------------------------
