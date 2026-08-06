import { describe, it, expect } from 'vitest';
import { en } from '@/lib/i18n/en';
import { zh } from '@/lib/i18n/zh';
import { ms } from '@/lib/i18n/ms';
import { LANGUAGES, DEFAULT_LANGUAGE, normalizeLanguage } from '@tog/shared';

const DICTS = { en, zh, ms } as const;

describe('dictionaries', () => {
  it('ships one dictionary per supported language', () => {
    expect(Object.keys(DICTS).sort()).toEqual([...LANGUAGES].sort());
  });

  for (const [lang, dict] of Object.entries(DICTS)) {
    it(`${lang} has exactly the English key set`, () => {
      // A missing key silently falls back to English at runtime, and an extra
      // one is dead weight — both are worth failing the build over.
      const missing = Object.keys(en).filter((k) => !(k in dict));
      const extra = Object.keys(dict).filter((k) => !(k in en));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    it(`${lang} has no blank translations`, () => {
      // 'dash.unit.*' are deliberately empty outside Chinese (English has no
      // measure words), so only flag keys English itself fills in.
      const blank = Object.entries(dict)
        .filter(([k, v]) => v.trim() === '' && en[k as keyof typeof en].trim() !== '')
        .map(([k]) => k);
      expect(blank).toEqual([]);
    });

    it(`${lang} keeps every placeholder the English string uses`, () => {
      const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const drifted = Object.keys(en).filter((k) => {
        const a = vars(en[k as keyof typeof en]);
        const b = vars(dict[k as keyof typeof dict]);
        return a.join(',') !== b.join(',');
      });
      expect(drifted).toEqual([]);
    });
  }
});

describe('normalizeLanguage', () => {
  it('accepts the supported codes as-is', () => {
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('zh')).toBe('zh');
    expect(normalizeLanguage('ms')).toBe('ms');
  });

  it('collapses regional tags onto their base language', () => {
    expect(normalizeLanguage('zh-CN')).toBe('zh');
    expect(normalizeLanguage('zh_TW')).toBe('zh');
    expect(normalizeLanguage('en-US')).toBe('en');
  });

  it('falls back to the default for anything unsupported', () => {
    expect(normalizeLanguage('fr')).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLanguage('')).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLanguage(null)).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
  });
});
