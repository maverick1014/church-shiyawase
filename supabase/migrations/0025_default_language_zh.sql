-- ===========================================================================
-- The default interface language is Chinese, not English
-- ---------------------------------------------------------------------------
-- MUST BE APPLIED BEFORE THE CODE THAT READS IT IS DEPLOYED.
--
-- This mirrors migration 0011, which itself changed the column default from
-- 'zh-CN' to 'en' — the default has moved before and will again, so this is
-- a normal forward migration, not a correction of a mistake.
--
-- Only the DEFAULT changes here: an account that already has a language set
-- (including one already 'en' by deliberate choice) is left exactly as it
-- is — this is about what a brand-new account gets when nobody picks for it,
-- not about repainting every existing account. The matching application-code
-- default (`DEFAULT_LANGUAGE` in packages/shared) lands in the same batch of
-- work as this migration.
-- ===========================================================================

alter table app_users alter column language set default 'zh';

-- ---------------------------------------------------------------------------
-- Rollback
--   alter table app_users alter column language set default 'en';
-- ---------------------------------------------------------------------------
