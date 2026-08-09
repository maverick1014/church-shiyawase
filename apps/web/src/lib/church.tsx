'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { OPTIONAL_MODULES } from '@tog/shared';
import { applyTheme } from './theme';
import { ChurchProfile, ModuleStateRow } from './types';

/**
 * The church record and which add-on modules it runs.
 *
 * Lives in its own module (like `lib/hall.tsx`) so any component can read the
 * church's name — or ask whether a module is on — without importing the shell.
 * The public pages (/login, /d/<token>, /enroll/<id>) have no shell at all and
 * fetch the profile themselves with `useChurchProfile`.
 *
 * The server is authoritative about a disabled module (the gate in
 * `api/[...path]/route.ts` answers 404 for every path it owns); this context
 * only decides what the UI offers, which is the other half of rule G2.
 */
export type ChurchScope = {
  /** null while the fetch is in flight, or if it failed. */
  church: ChurchProfile | null;
  /** Module key → on/off, for every module in the code registry. */
  modules: Record<string, boolean>;
  /**
   * Re-read the module states. The catalog page calls it after a toggle so the
   * sidebar loses (or regains) the entry immediately, instead of the change
   * only showing up on the next full page load.
   */
  reloadModules: () => void;
};

/** Every registry module counted as ON — what we assume before we know. */
const ALL_ON: Record<string, boolean> = Object.fromEntries(
  OPTIONAL_MODULES.map((m) => [m.key, true]),
);

export const ChurchContext = createContext<ChurchScope>({
  church: null,
  modules: ALL_ON,
  reloadModules: () => {},
});

/** The church record for the current page (null until it has loaded). */
export function useChurch(): ChurchProfile | null {
  return useContext(ChurchContext).church;
}

/** The whole scope — for the one page that edits it. */
export function useChurchScope(): ChurchScope {
  return useContext(ChurchContext);
}

/**
 * Is one add-on module switched on for this church? Pages use it to skip a
 * module's fetches and hide its UI — never as the only guard, since the API
 * refuses those paths regardless.
 */
export function useModuleEnabled(key: string): boolean {
  return useContext(ChurchContext).modules[key] ?? true;
}

/**
 * Fetch the public church record once. Used by the shell (which then shares it
 * through the context above) and directly by the public pages, which have no
 * session and so cannot go through the shell.
 *
 * It is also where the church's THEME is applied (`applyTheme`): every surface
 * that renders the church's name already reads this record, so painting the
 * app in its colours needs no second mechanism and cannot be forgotten on a
 * page that has no shell (rule G4).
 */
export function useChurchProfile(): ChurchProfile | null {
  const [church, setChurch] = useState<ChurchProfile | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/church')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c: ChurchProfile) => {
        if (!alive) return;
        applyTheme(c);
        setChurch(c);
      })
      // A church that cannot be read is not worth blocking a login screen for
      // — the caller falls back to a generic name.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return church;
}

/**
 * The module states for this session. Resolves to every module ON if the read
 * fails, so a database that is a migration behind degrades to today's
 * behaviour rather than to an app with no navigation.
 */
export async function fetchModuleStates(): Promise<Record<string, boolean>> {
  try {
    const res = await fetch('/api/church/modules');
    if (!res.ok) return { ...ALL_ON };
    const rows = (await res.json()) as ModuleStateRow[];
    return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
  } catch {
    return { ...ALL_ON };
  }
}
