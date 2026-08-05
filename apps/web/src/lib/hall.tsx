'use client';

import { createContext, useContext } from 'react';
import { HallRow } from './types';

/**
 * Hall (堂会) scope for the current session.
 *
 * Lives in its own module rather than in AppShell so `useFetch` can read the
 * active hall without importing the shell (which would be a cycle).
 *
 * The server is authoritative about what a session may see (see the hall gate
 * in `api/[...path]/route.ts`); this context only drives the UI and appends
 * `hall_id` so a full-access account can narrow the view.
 */
export type HallScope = {
  /** Halls this account may see. */
  halls: HallRow[];
  /** Currently viewed hall id; '' = 全部堂会 (full-access accounts only). */
  hallId: string;
  setHallId: (id: string) => void;
  /** True when the account is pinned to one hall by its own permissions. */
  locked: boolean;
};

export const HallContext = createContext<HallScope>({
  halls: [],
  hallId: '',
  setHallId: () => {},
  locked: false,
});

export function useHallScope(): HallScope {
  return useContext(HallContext);
}

/** Append the active hall to a request path (no-op for 全部堂会). */
export function withHallParam(path: string, hallId: string): string {
  if (!hallId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}hall_id=${encodeURIComponent(hallId)}`;
}
