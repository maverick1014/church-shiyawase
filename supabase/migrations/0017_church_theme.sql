-- ===========================================================================
-- The church's theme: two colours on the church record.
-- ---------------------------------------------------------------------------
-- The palette was a constant in `globals.css` — charcoal sidebar, crimson
-- accent, taken from this one church's logo. It becomes DATA here, for the
-- same reason the church's name did in 0012: the app is going to be run for
-- more than one church, and the next one is not crimson.
--
-- A theme is exactly TWO colours, because everything else the design system
-- needs is derived from them in CSS with `color-mix()` (the brand's darker
-- shade and its tint, the charcoal accent, and the sidebar's own light
-- foregrounds). Storing derived shades as well would be four more columns that
-- can drift apart from the two that matter.
--
--   theme_preset — which shipped preset this pair came from
--                  (`THEME_PRESETS` in packages/shared), or NULL when the two
--                  colours were picked by hand. It is a LABEL for what was
--                  chosen, never the source of the colours…
--   theme_rail   — …because the colours themselves are stored. Keeping only
--                  the key would mean that editing a preset's definition in a
--   theme_brand     later release silently restyled every church that had
--                  chosen it. They keep the pair they picked until they pick
--                  another.
--
-- It lives on `church` rather than on `app_users`: a theme is BRANDING, not a
-- personal preference, so one set does the whole congregation — including the
-- login card and the public forms, which have no account to read a preference
-- from.
--
-- Both colours are constrained to a strict `#rrggbb` in the database as well
-- as in the API, because they are interpolated into a CSS custom property: the
-- column is the last line of defence against a stored `red; } html { … }`.
-- The check is deliberately narrower than CSS itself — no shorthand, no
-- colour names, no functions — since every writer (a preset, or an
-- `<input type="color">`) produces exactly this shape.
--
-- Seeding keeps today's appearance exactly: the existing row takes the
-- charcoal/crimson pair the stylesheet has been hardcoding, so applying this
-- migration changes nothing visible until someone picks another theme in
-- 教会设置.
--
-- Idempotent (`if not exists` / `drop … if exists`), like 0012 and 0016 —
-- re-applying it is a no-op rather than an error.
--
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED: `GET /api/church`
-- selects these three columns by name (it is the endpoint the login page and
-- both public forms read the theme from), and 教会设置 writes them.
-- ===========================================================================

alter table church
  add column if not exists theme_preset text;
alter table church
  add column if not exists theme_rail text;
alter table church
  add column if not exists theme_brand text;

-- Today's palette for the row that already exists, before the NOT NULLs below.
update church
   set theme_preset = coalesce(theme_preset, 'charcoal'),
       theme_rail   = coalesce(theme_rail, '#201d1b'),
       theme_brand  = coalesce(theme_brand, '#a51f24');

-- A church always has a theme. `default` covers a future insert; the backfill
-- above covers the row that is already there.
alter table church
  alter column theme_rail set default '#201d1b',
  alter column theme_brand set default '#a51f24';
alter table church
  alter column theme_rail set not null,
  alter column theme_brand set not null;

-- Strict `#rrggbb`, lowercase or upper — never a colour name, a function, or
-- anything with a semicolon in it. `drop … if exists` first so re-applying
-- this replaces the constraint rather than failing on its name.
alter table church
  drop constraint if exists church_theme_rail_check;
alter table church
  add constraint church_theme_rail_check check (theme_rail ~ '^#[0-9a-fA-F]{6}$');
alter table church
  drop constraint if exists church_theme_brand_check;
alter table church
  add constraint church_theme_brand_check check (theme_brand ~ '^#[0-9a-fA-F]{6}$');

-- `theme_preset` is free text on purpose, exactly like `church_modules.module`
-- (0012): the authoritative catalogue is the code registry, and the API
-- refuses a key that is not in it, so an enum here would only mean a migration
-- every time a preset is added. NULL means "custom".

-- ---------------------------------------------------------------------------
-- Rollback (manual — Supabase migrations are forward-only here):
--   alter table church drop constraint if exists church_theme_brand_check;
--   alter table church drop constraint if exists church_theme_rail_check;
--   alter table church
--     drop column if exists theme_brand,
--     drop column if exists theme_rail,
--     drop column if exists theme_preset;
-- The chosen colours are what this removes; the app falls back to the
-- charcoal/crimson defaults in globals.css.
-- ---------------------------------------------------------------------------
