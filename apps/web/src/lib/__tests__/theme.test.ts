import { describe, it, expect } from 'vitest';
import {
  contrastWithWhite,
  DEFAULT_THEME,
  isHexColor,
  isUsableBrand,
  isUsableRail,
  MIN_BRAND_CONTRAST,
  MIN_RAIL_CONTRAST,
  normalizeHexColor,
  THEME_PRESETS,
  THEME_PRESET_KEYS,
  themePreset,
} from '@tog/shared';
import { en } from '@/lib/i18n/en';
import { themeOf } from '@/lib/theme';

/**
 * The theme catalogue and the colour validation behind 教会设置 → 主题颜色.
 *
 * Two things are being protected here. The first is the church's own app: a
 * pair nobody can read is not an alternative look, and neither is a preset
 * whose name never made it into the dictionary. The second is the page itself
 * — these strings end up inside a CSS custom property, so "is this a colour?"
 * has to be answered by a test rather than by hope.
 */
describe('the shipped theme presets', () => {
  it('leads with today’s palette, so nothing changes on deploy', () => {
    // Migration 0017 seeds exactly this pair, and globals.css declares it as
    // the default. A church that never opens the picker must see no change.
    expect(THEME_PRESETS[0]).toMatchObject({
      key: 'charcoal',
      rail: '#201d1b',
      brand: '#a51f24',
    });
    expect(DEFAULT_THEME).toEqual({ preset: 'charcoal', rail: '#201d1b', brand: '#a51f24' });
  });

  it('ships a handful of pairs, each named once', () => {
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(THEME_PRESET_KEYS).size).toBe(THEME_PRESET_KEYS.length);
  });

  it('gives every preset two strict #rrggbb colours', () => {
    for (const p of THEME_PRESETS) {
      expect(isHexColor(p.rail), `${p.key} rail`).toBe(true);
      expect(isHexColor(p.brand), `${p.key} brand`).toBe(true);
      // Stored lowercase, so the value that comes back from the API is the
      // value an <input type="color"> would produce for the same colour.
      expect(p.rail).toBe(p.rail.toLowerCase());
      expect(p.brand).toBe(p.brand.toLowerCase());
    }
  });

  it('never ships a pair the app cannot be read on', () => {
    // The sidebar is light-on-dark and every button puts white text on the
    // brand. A preset that failed this would ship an unreadable app to any
    // church that tapped it.
    for (const p of THEME_PRESETS) {
      expect(isUsableRail(p.rail), `${p.key} rail ${contrastWithWhite(p.rail).toFixed(1)}:1`).toBe(true);
      expect(isUsableBrand(p.brand), `${p.key} brand ${contrastWithWhite(p.brand).toFixed(1)}:1`).toBe(true);
    }
  });

  it('has a name in the dictionary for every preset', () => {
    // Without it the picker renders the raw key at the user (rule G8).
    for (const key of THEME_PRESET_KEYS) expect(en).toHaveProperty(`theme.preset.${key}`);
  });

  it('finds a preset by key and refuses anything else', () => {
    expect(themePreset('charcoal')?.brand).toBe('#a51f24');
    for (const junk of ['Charcoal', 'crimson', '', null, undefined])
      expect(themePreset(junk)).toBeNull();
  });
});

describe('isHexColor / normalizeHexColor — what may reach a CSS property', () => {
  it('accepts a full six-digit hex, in either case', () => {
    expect(isHexColor('#a51f24')).toBe(true);
    expect(isHexColor('#A51F24')).toBe(true);
    expect(normalizeHexColor('#A51F24')).toBe('#a51f24');
  });

  it('refuses three-digit shorthand — one shape in the database, not two', () => {
    expect(isHexColor('#abc')).toBe(false);
    expect(normalizeHexColor('#abc')).toBeNull();
  });

  it('refuses colours that are not hex at all', () => {
    for (const bad of ['red', 'rgb(1,2,3)', 'a51f24', '#a51f2', '#a51f244', '#ghijkl', ' #a51f24'])
      expect(isHexColor(bad), bad).toBe(false);
  });

  it('refuses an injection attempt outright rather than sanitising it', () => {
    // These are the shapes that matter: the value is interpolated into
    // `--brand: …`, so anything able to close the declaration would let the
    // page be restyled — or a background image be requested — from a stored
    // string. There is no escaping step to get wrong; it is simply not a
    // colour, so it never reaches the property.
    for (const attack of [
      '#fff; } html { display: none } :root { --x: #fff',
      'red; background: url(https://evil.example/x.png)',
      'var(--brand)',
      '#a51f24;',
      '#a51f24 !important',
      'expression(alert(1))',
      'url(javascript:alert(1))',
      '</style><script>alert(1)</script>',
    ])
      expect(isHexColor(attack), attack).toBe(false);
    expect(normalizeHexColor('#fff; } html { display: none }')).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const bad of [null, undefined, 0, {}, ['#a51f24'], true])
      expect(isHexColor(bad)).toBe(false);
  });
});

describe('isUsableRail / isUsableBrand — the pale-colour floor', () => {
  it('measures contrast against white the WCAG way', () => {
    expect(contrastWithWhite('#ffffff')).toBeCloseTo(1, 2);
    expect(contrastWithWhite('#000000')).toBeCloseTo(21, 0);
    expect(contrastWithWhite('not a colour')).toBe(0);
  });

  it('accepts a genuinely dark sidebar and refuses a pale one', () => {
    expect(isUsableRail('#201d1b')).toBe(true);
    expect(isUsableRail('#1a2130')).toBe(true);
    // The failure this floor exists for: a pale rail with white text on it.
    for (const pale of ['#ffffff', '#f6f3f2', '#cccccc', '#888888'])
      expect(isUsableRail(pale), pale).toBe(false);
    expect(contrastWithWhite('#ffffff')).toBeLessThan(MIN_RAIL_CONTRAST);
  });

  it('lets the brand be lighter than the rail, but not white-text-illegible', () => {
    expect(isUsableBrand('#a51f24')).toBe(true);
    expect(isUsableBrand('#a35d1b')).toBe(true);
    for (const pale of ['#ffee00', '#ffffff', '#9ad0b0'])
      expect(isUsableBrand(pale), pale).toBe(false);
    // The brand's floor is the looser of the two — a mid-tone accent is fine
    // on a light surface, a mid-tone sidebar is not.
    expect(MIN_BRAND_CONTRAST).toBeLessThan(MIN_RAIL_CONTRAST);
  });

  it('refuses a non-colour before it ever measures it', () => {
    expect(isUsableRail('#abc')).toBe(false);
    expect(isUsableBrand('black')).toBe(false);
  });
});

describe('themeOf — reading the theme off a church record', () => {
  it('takes the three stored columns', () => {
    expect(
      themeOf({ theme_preset: 'ink', theme_rail: '#1A2130', theme_brand: '#2F6690' }),
    ).toEqual({ preset: 'ink', rail: '#1a2130', brand: '#2f6690' });
  });

  it('falls back to the default pair, never to no colour at all', () => {
    // A record from a database one migration behind, or a failed fetch, has to
    // degrade to today's palette — an unstyled app is not an option. The
    // preset is reported as null rather than guessed at: nothing was chosen,
    // and only the COLOURS have a safe default.
    const fallback = { preset: null, rail: DEFAULT_THEME.rail, brand: DEFAULT_THEME.brand };
    expect(themeOf(null)).toEqual(fallback);
    expect(themeOf({})).toEqual(fallback);
    expect(
      themeOf({ theme_preset: null, theme_rail: 'red', theme_brand: '#fff; }' }),
    ).toEqual({ preset: null, rail: DEFAULT_THEME.rail, brand: DEFAULT_THEME.brand });
  });
});
