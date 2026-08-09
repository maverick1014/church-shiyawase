-- ===========================================================================
-- 培训&活动: a PIC you can ring, a place and a time for an activity, and 报名费
-- ---------------------------------------------------------------------------
-- Four changes to the same catalog, all of them asked for by the church after
-- living with it for a while.
--
-- 1. 类别 (category) GOES. It was a free-text display tag with three seeded
--    values (门徒 / 栽培 / 事奉) that only ever made sense for a course. Once
--    /trainings also held a brothers' hike, every row had to carry a word that
--    described none of it, and nobody filtered on it. Removing the column is
--    the honest fix — an activity-flavoured vocabulary would just be two
--    wrong lists instead of one.
--
-- 2. `trainer_id` BECOMES `pic` + `pic_contact`, both plain text. The person
--    running a course is often NOT a member: an outside speaker, a trainer
--    from another church, a camp organiser. A uuid into `members` could not
--    name them at all, so the field sat empty and the real answer lived in a
--    WhatsApp group. What people actually need from that field is a name and
--    a NUMBER — "who do I ring about this?" — which is why the contact is a
--    column of its own rather than a line in the description.
--    Existing links are not lost: the member's own name is copied into `pic`
--    before the column goes.
--
-- 3. An ACTIVITY gets a `start_time` and a `location`. It already had a date
--    (`starts_on` / `ends_on`, the same day twice). A hike with no time and no
--    meeting point is not something anybody can turn up to. They live HERE, on
--    the training row, and NOT on the activity's single `training_sessions`
--    row: that row is plumbing the API creates so the roll call has one column
--    to tick, and putting the time on it would give the same occasion two
--    places to be edited from — exactly what 0014 avoided for the date.
--    `time` (not `timestamptz`): the church is in one place, so a 09:00 hike
--    is 09:00 on every screen. A bare wall-clock reading needs no zone
--    conversion and so cannot be rendered an hour out (rule G6a).
--
-- 4. 报名费 (`fee`) and how to pay it. A paid course needs three things the
--    catalog could not say: how much, where to send the money, and proof that
--    it was sent.
--      fee                  — null / 0 means free, and everything below is
--                             hidden. Money is `numeric`, never a float.
--      payment_instructions — free text: a bank account, a TnG number, "pay
--                             the treasurer on the day". ONE column rather
--                             than one per method, because a church will
--                             invent a method nobody modelled — and the
--                             church types it once per course, not per payer.
--      payment_qr_url       — an optional uploaded QR image (DuitNow / TnG),
--                             which is how most people actually pay here.
--      training_enrollments.payment_slip_url
--                           — the receipt the person uploaded with their
--                             sign-up. The admin opens it and only then
--                             approves, which is the whole point: approval is
--                             a human checking that the money arrived.
--
-- Both URLs point at objects in the `payments` storage bucket, uploaded
-- through the service-role route handler exactly like a member's avatar
-- (0004) and the church logo (0012). A slip's object name carries a random
-- uuid rather than anything guessable, since the bucket is public.
--
-- Idempotent (`if not exists` / `if exists` / `on conflict do nothing`), like
-- 0004, 0012 and 0014 — re-applying it is a no-op rather than an error.
--
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED: /api/trainings
-- selects `*` from this table, writes `pic` / `fee` / `payment_*`, and the
-- public sign-up form refuses an enrolment with no slip on a paid course.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. 类别 — gone.
-- ---------------------------------------------------------------------------
alter table trainings
  drop column if exists category;

-- ---------------------------------------------------------------------------
-- 2. PIC (负责人) — a name and a way to reach them, both free text.
-- ---------------------------------------------------------------------------
alter table trainings
  add column if not exists pic text;
alter table trainings
  add column if not exists pic_contact text;

-- Carry the old member link forward as a NAME before dropping it, so a course
-- that named its trainer still names them afterwards. Guarded by the column's
-- existence (and wrapped in dynamic SQL, which is not parsed until it runs) so
-- a second application of this migration is a no-op instead of an error.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'trainings'
       and column_name = 'trainer_id'
  ) then
    execute $backfill$
      update trainings t
         set pic = m.full_name
        from members m
       where m.id = t.trainer_id
         and coalesce(t.pic, '') = ''
    $backfill$;
  end if;
end
$$;

alter table trainings
  drop column if exists trainer_id;

-- ---------------------------------------------------------------------------
-- 3. An activity's time and place — one occasion, one row, one place to edit.
-- ---------------------------------------------------------------------------
alter table trainings
  add column if not exists start_time time;
alter table trainings
  add column if not exists location text;

-- ---------------------------------------------------------------------------
-- 4. 报名费 and how it is paid.
-- ---------------------------------------------------------------------------
alter table trainings
  add column if not exists fee numeric(10, 2);
alter table trainings
  add column if not exists payment_instructions text;
alter table trainings
  add column if not exists payment_qr_url text;

-- A negative fee is not a discount, it is a typo. `drop … if exists` first, so
-- re-applying this replaces the constraint rather than failing on its name.
alter table trainings
  drop constraint if exists trainings_fee_check;
alter table trainings
  add constraint trainings_fee_check check (fee is null or fee >= 0);

alter table training_enrollments
  add column if not exists payment_slip_url text;

-- Public bucket for both halves of a payment: the church's QR image (qr/…) and
-- the receipts people upload with their sign-up (slips/…). Public because the
-- browser renders them straight from the URL, exactly like `avatars` (0004)
-- and `branding` (0012); the slip's object name is a random uuid so the URL is
-- not guessable from the training id.
insert into storage.buckets (id, name, public)
values ('payments', 'payments', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Rollback (manual — Supabase migrations are forward-only here):
--   alter table training_enrollments drop column if exists payment_slip_url;
--   alter table trainings drop constraint if exists trainings_fee_check;
--   alter table trainings
--     drop column if exists payment_qr_url,
--     drop column if exists payment_instructions,
--     drop column if exists fee,
--     drop column if exists location,
--     drop column if exists start_time,
--     drop column if exists pic_contact,
--     drop column if exists pic;
--   alter table trainings add column if not exists category text;
--   alter table trainings
--     add column if not exists trainer_id uuid references members(id) on delete set null;
-- The dropped DATA is not recoverable — 类别 and the trainer link are what this
-- migration removes — and a re-added `trainer_id` starts out null everywhere.
-- ---------------------------------------------------------------------------
