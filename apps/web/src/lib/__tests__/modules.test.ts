import { describe, it, expect } from 'vitest';
import {
  isOptionalModule,
  MODULE_DISCIPLESHIP,
  MODULE_HAPPINESS,
  moduleForApiPath,
  moduleForNavHref,
  OPTIONAL_MODULES,
  OPTIONAL_MODULE_KEYS,
} from '@tog/shared';
import { en } from '@/lib/i18n/en';

/**
 * The add-on module registry. It is what the API gate, the sidebar and the
 * module catalog page all read, so "which paths does this module own" has to
 * be answered the same way in all three — and, just as importantly, a CORE
 * path must never be answerable at all.
 */
describe('optional module registry', () => {
  it('ships the Forty Days and Happiness Groups add-ons, and nothing that is core', () => {
    expect(OPTIONAL_MODULE_KEYS).toContain(MODULE_DISCIPLESHIP);
    expect(OPTIONAL_MODULE_KEYS).toContain(MODULE_HAPPINESS);
    // The seed row in migration 0022 names this exact string — a mismatch
    // here would orphan it, so the constant is pinned rather than just typed.
    expect(MODULE_HAPPINESS).toBe('happiness');
    // Dashboard, members, groups, events, trainings, accounts and the profile
    // are not switchable — a church cannot turn its own member list off.
    for (const core of ['', 'members', 'groups', 'events', 'trainings', 'accounts', 'profile'])
      expect(OPTIONAL_MODULE_KEYS).not.toContain(core);
  });

  it('gives every module a nav href and at least one API prefix', () => {
    for (const m of OPTIONAL_MODULES) {
      expect(m.key).toBeTruthy();
      expect(m.nav.startsWith('/')).toBe(true);
      expect(m.api.length).toBeGreaterThan(0);
    }
  });

  it('has a name, a description and a data-kept line in the dictionary', () => {
    // The catalog page renders these three per row; a module without them
    // would render its raw key at the user.
    for (const key of OPTIONAL_MODULE_KEYS)
      for (const suffix of ['name', 'desc', 'dataKept'])
        expect(en).toHaveProperty(`module.${key}.${suffix}`);
  });
});

describe('isOptionalModule', () => {
  it('accepts a registered key', () => {
    expect(isOptionalModule(MODULE_DISCIPLESHIP)).toBe(true);
  });

  it('rejects anything else — this is what keeps junk out of church_modules', () => {
    expect(isOptionalModule('members')).toBe(false);
    expect(isOptionalModule('Discipleship')).toBe(false);
    expect(isOptionalModule('')).toBe(false);
    expect(isOptionalModule(null)).toBe(false);
    expect(isOptionalModule(undefined)).toBe(false);
  });
});

describe('moduleForApiPath — which module owns an API path', () => {
  it('claims the module root and everything under it', () => {
    // These are the shapes route.ts dispatches on, as segment arrays.
    expect(moduleForApiPath(['discipleship'])).toBe(MODULE_DISCIPLESHIP);
    expect(moduleForApiPath(['discipleship', 'pairs'])).toBe(MODULE_DISCIPLESHIP);
    expect(moduleForApiPath(['discipleship', 'programs', 'abc', 'overview'])).toBe(
      MODULE_DISCIPLESHIP,
    );
    // The PUBLIC mentor form is owned too: switching the module off has to
    // close its links, not leave them answering.
    expect(moduleForApiPath(['discipleship', 'form', 'token123'])).toBe(MODULE_DISCIPLESHIP);
  });

  it('accepts a string path as well as segments', () => {
    expect(moduleForApiPath('/discipleship/pairs')).toBe(MODULE_DISCIPLESHIP);
    expect(moduleForApiPath('discipleship')).toBe(MODULE_DISCIPLESHIP);
  });

  it('claims 幸福小组 — terms, groups and everything under a group', () => {
    expect(moduleForApiPath(['happiness'])).toBe(MODULE_HAPPINESS);
    expect(moduleForApiPath(['happiness', 'terms'])).toBe(MODULE_HAPPINESS);
    expect(moduleForApiPath(['happiness', 'groups', 'abc', 'attendance'])).toBe(MODULE_HAPPINESS);
    expect(moduleForApiPath(['happiness', 'groups', 'abc', 'members', 'def'])).toBe(MODULE_HAPPINESS);
  });

  it('never claims a core path — the gate must not be able to lock the app out', () => {
    for (const path of [
      [],
      ['auth', 'login'],
      ['auth', 'me'],
      ['church'],
      ['church', 'modules'],
      ['church', 'modules', MODULE_DISCIPLESHIP],
      ['members'],
      ['halls'],
      ['version'],
      ['trainings', 'enroll', 'abc'],
    ])
      expect(moduleForApiPath(path)).toBeNull();
  });

  it('matches whole segments only, never a prefix of one', () => {
    // 'discipleships' is not 'discipleship' — a substring match here would
    // gate a path the module does not own.
    expect(moduleForApiPath(['discipleships'])).toBeNull();
    expect(moduleForApiPath(['pre-discipleship'])).toBeNull();
  });
});

describe('moduleForNavHref — which module owns a sidebar entry', () => {
  it('claims its own href and anything below it', () => {
    expect(moduleForNavHref('/discipleship')).toBe(MODULE_DISCIPLESHIP);
    expect(moduleForNavHref('/discipleship/anything')).toBe(MODULE_DISCIPLESHIP);
  });

  it('leaves the core nav entries alone, the dashboard root included', () => {
    for (const href of ['/', '/members', '/groups', '/events', '/trainings', '/settings', '/church'])
      expect(moduleForNavHref(href)).toBeNull();
  });

  it('claims /happiness and anything below it', () => {
    expect(moduleForNavHref('/happiness')).toBe(MODULE_HAPPINESS);
    expect(moduleForNavHref('/happiness/term-1')).toBe(MODULE_HAPPINESS);
    expect(moduleForNavHref('/happiness/group/abc')).toBe(MODULE_HAPPINESS);
  });
});
