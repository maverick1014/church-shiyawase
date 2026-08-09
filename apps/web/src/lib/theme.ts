import { ChurchTheme, DEFAULT_THEME, normalizeHexColor } from '@tog/shared';

/**
 * The church's theme, applied to the page.
 *
 * A theme is two colours (see `ChurchTheme` in packages/shared): the rail and
 * the brand. Applying one is therefore two custom properties on <html> — every
 * other colour the design system needs is derived from them in `globals.css`
 * with `color-mix()`, so nothing here has to know what a "soft" tint is.
 *
 * ONE mechanism for the whole app (rule G4): `useChurchProfile` calls
 * `applyTheme` the moment the record lands, which covers the shell AND the
 * three pages that have no shell at all (`/login`, `/d/[token]`, `/enroll/[id]`
 * fetch the same public record for the church's name). 教会设置 calls it again
 * on save, so the sidebar changes under the picker instead of on the next load.
 *
 * ---- the first paint ------------------------------------------------------
 * The record arrives over the network, so a page painted before it would show
 * the default charcoal/crimson and then swap — the obvious failure mode for a
 * theme that lives in the database. The last applied pair is therefore cached
 * in localStorage and re-applied by `THEME_BOOT_SCRIPT`, a few lines inlined in
 * <head> that run before the first paint. So:
 *
 *   - a returning visitor (the normal case) never sees the default at all;
 *   - the very first visit on a device paints in the app defaults and switches
 *     when the record arrives — one repaint, no layout shift, and none at all
 *     for a church that kept the default palette;
 *   - a theme changed on another device shows the previous pair for that same
 *     moment, then corrects itself.
 *
 * Nothing blocks render on the fetch, and nothing is baked in at build time:
 * the colours are read from the record every load, so a second church deployed
 * from the same build gets its own.
 */

/** Where the pre-paint script and `applyTheme` meet. */
export const THEME_STORAGE_KEY = 'tog.theme';

/** The theme columns as they ride on a church record (migration 0017). */
export interface ThemeFields {
  theme_preset?: string | null;
  theme_rail?: string | null;
  theme_brand?: string | null;
}

/**
 * The theme a record describes, falling back to the shipped default for
 * anything missing or malformed — a database one migration behind must degrade
 * to today's palette, never to an unstyled page.
 */
export function themeOf(record: ThemeFields | null | undefined): ChurchTheme {
  return {
    preset: record?.theme_preset ?? null,
    rail: normalizeHexColor(record?.theme_rail) ?? DEFAULT_THEME.rail,
    brand: normalizeHexColor(record?.theme_brand) ?? DEFAULT_THEME.brand,
  };
}

/**
 * Paint the app in this theme, and remember it for the next first paint.
 *
 * Safe to call on the server (it simply does nothing) and safe to call with a
 * half-loaded record — `themeOf` normalises first, so an invalid colour can
 * never reach a CSS custom property from here either.
 */
export function applyTheme(record: ThemeFields | null | undefined): ChurchTheme {
  const theme = themeOf(record);
  if (typeof document === 'undefined') return theme;

  const root = document.documentElement;
  root.style.setProperty('--rail', theme.rail);
  root.style.setProperty('--brand', theme.brand);
  // The browser chrome around the page (Android's address bar, an installed
  // PWA's title bar) takes its colour from this tag, which app/layout.tsx can
  // only fill in with a build-time literal — it has no database to read.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme.brand);

  try {
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ rail: theme.rail, brand: theme.brand }),
    );
  } catch {
    // Private mode, a full quota, storage disabled — the theme still applied;
    // only the head start on the next load is lost.
  }
  return theme;
}

/**
 * The pre-paint script, inlined in <head> by `app/layout.tsx`.
 *
 * It re-validates the cached colours against the same strict `#rrggbb` shape
 * the server enforces before putting either into a custom property: this value
 * comes back out of localStorage, and code that interpolates a string into CSS
 * should never trust where the string has been. Anything unexpected is
 * ignored and the stylesheet's defaults stand.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=JSON.parse(localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})||"null");if(!t)return;var h=/^#[0-9a-f]{6}$/i,r=document.documentElement;if(h.test(t.rail))r.style.setProperty("--rail",t.rail);if(h.test(t.brand)){r.style.setProperty("--brand",t.brand);var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t.brand);}}catch(e){}})();`;
