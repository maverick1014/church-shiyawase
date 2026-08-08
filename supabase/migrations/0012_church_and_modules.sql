-- ===========================================================================
-- The church record, and which add-on modules it runs.
-- ---------------------------------------------------------------------------
-- Until now the church was hardcoded in the frontend ("Tabernacle of Grace" /
-- 主恩堂) and every module was always on. Both become data here, because the
-- app is going to be run for more than one church:
--
--   church          : one row — the name, description and logo the shell, the
--                     login page and the public forms render. Not a tenant
--                     boundary: one deployment still serves exactly one
--                     church (halls are the scope column inside it), so the
--                     row is a singleton and nothing references it but
--                     church_modules.
--   church_modules  : which OPTIONAL modules this church runs. The catalog of
--                     what CAN be switched lives in code
--                     (`OPTIONAL_MODULES` in packages/shared); only the
--                     on/off state lives here, so a module can never be
--                     enabled by name for a feature that does not exist.
--
-- Core surfaces (dashboard, members, groups, events, trainings, accounts,
-- profile) are deliberately absent — they are not switchable.
--
-- Seeding keeps today's behaviour exactly: the one church row carries the
-- current name, and every optional module is seeded ENABLED, so applying this
-- migration changes nothing visible until someone flips a switch in 教会设置.
--
-- Idempotent throughout (`if not exists` / `on conflict do nothing`), like
-- 0004 and 0011 — re-applying it is a no-op rather than an error.
--
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED: the API's
-- /api/church routes and its module gate read these two tables.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The church itself.
-- ---------------------------------------------------------------------------
create table if not exists church (
  id          uuid primary key default gen_random_uuid(),
  -- The full name, shown in the sidebar, on the login card and on the public
  -- forms. It is DATA, not a translation: a church is called the same thing
  -- in every interface language.
  name        text not null,
  -- Optional short form for tight chrome (a phone's sidebar); null = use name.
  short_name  text,
  description text,
  -- Public URL of an uploaded logo in the `branding` storage bucket below.
  -- Null falls back to the bundled /logo.png.
  logo_url    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists church_set_updated_at on church;
create trigger church_set_updated_at
  before update on church
  for each row execute function set_updated_at();

-- Seed the single row with the name the app has been hardcoding, so nothing
-- regresses on deploy. Guarded on the table being empty rather than on a
-- conflict target: the row has no natural key, and a second run must not add
-- a second church.
-- The description is left null rather than filled with a motto nobody wrote:
-- this seed exists to preserve what the app already showed, and the app never
-- showed a tagline. The church types their own in 教会设置.
insert into church (name, short_name, description)
select 'Tabernacle of Grace', '主恩堂', null
where not exists (select 1 from church);

-- ---------------------------------------------------------------------------
-- Add-on modules this church runs.
-- ---------------------------------------------------------------------------
-- `module` is the registry key from packages/shared (e.g. 'discipleship').
-- Kept as free text rather than an enum on purpose: the authoritative list is
-- the code registry, and the API rejects a key that is not in it, so an enum
-- here would only mean a migration every time the catalog grows.
create table if not exists church_modules (
  church_id  uuid    not null references church(id) on delete cascade,
  module     text    not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (church_id, module)
);

drop trigger if exists church_modules_set_updated_at on church_modules;
create trigger church_modules_set_updated_at
  before update on church_modules
  for each row execute function set_updated_at();

-- Every optional module starts ENABLED, so the app behaves exactly as it does
-- today until someone turns one off. `on conflict do nothing` leaves an
-- existing choice alone, which is what makes re-running this safe.
insert into church_modules (church_id, module, enabled)
select c.id, m.module, true
from church c
cross join (values ('discipleship')) as m (module)
on conflict (church_id, module) do nothing;

-- Public storage bucket for the church logo — same mechanism as the member
-- avatars in 0004 (uploads go through the service-role route handler; the
-- bucket is public so the browser can render the image by URL).
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Rollback (manual — Supabase migrations are forward-only here):
--   drop table if exists church_modules;
--   drop table if exists church;
--   delete from storage.buckets where id = 'branding';
-- ---------------------------------------------------------------------------
