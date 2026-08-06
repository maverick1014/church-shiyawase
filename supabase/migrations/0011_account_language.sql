-- 0011 — interface language per login account.
--
-- The app ships three languages (English / 简体中文 / Bahasa Melayu) and English
-- is the default. `app_users.language` already existed but was decorative --
-- nothing read it -- and held BCP-47-ish tags ('zh-CN', 'zh-TW') that were the
-- column default rather than anyone's choice. Reset every account to the new
-- default and constrain the column to the three codes the dictionaries are
-- keyed by, so nothing can store a language the app has no dictionary for.

alter table app_users
  alter column language set default 'en';

update app_users set language = 'en';

alter table app_users
  drop constraint if exists app_users_language_check;

alter table app_users
  add constraint app_users_language_check
  check (language in ('en', 'zh', 'ms'));
