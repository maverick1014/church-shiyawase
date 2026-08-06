'use client';

import { createContext, useContext, useMemo } from 'react';
import { DEFAULT_LANGUAGE, Language, normalizeLanguage } from '@tog/shared';
import { en, MessageKey, Messages } from './en';
import { ms } from './ms';
import { zh } from './zh';

/**
 * Interface language for the current session.
 *
 * Lives in its own module (like `lib/hall.tsx`) so any component can translate
 * without importing the shell. The language comes from the signed-in account
 * (`app_users.language`) rather than the URL, so there is no locale routing and
 * no third-party i18n runtime — just a dictionary lookup.
 */
const DICTIONARIES: Record<Language, Messages> = { en, zh, ms };

/** Interpolate `{name}` placeholders; a missing var is left untouched. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    vars[name] === undefined ? whole : String(vars[name]),
  );
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type I18n = {
  lang: Language;
  t: Translate;
};

function translator(lang: Language): Translate {
  const dict = DICTIONARIES[lang] ?? en;
  return (key, vars) => interpolate(dict[key] ?? en[key] ?? key, vars);
}

export const I18nContext = createContext<I18n>({
  lang: DEFAULT_LANGUAGE,
  t: translator(DEFAULT_LANGUAGE),
});

export function I18nProvider({
  lang,
  children,
}: {
  lang: string | null | undefined;
  children: React.ReactNode;
}) {
  const value = useMemo(() => {
    const resolved = normalizeLanguage(lang);
    return { lang: resolved, t: translator(resolved) };
  }, [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The translate function for the active language. */
export function useT(): Translate {
  return useContext(I18nContext).t;
}

/** The active language code — for `Intl` formatting and the settings select. */
export function useLang(): Language {
  return useContext(I18nContext).lang;
}

export type { MessageKey, Messages };
