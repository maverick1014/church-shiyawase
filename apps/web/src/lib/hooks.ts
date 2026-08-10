'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useHallScope, withHallParam } from './hall';

export function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Every list request carries the active hall, so switching halls in the
  // topbar refetches the whole page. Endpoints that aren't hall-scoped simply
  // ignore the parameter server-side.
  const { hallId } = useHallScope();
  const scopedPath = path === null ? null : withHallParam(path, hallId);

  // A write handler calls reload() right after its own POST/PUT resolves —
  // two reloads can be in flight together (a stray one from a hall switch,
  // a tick-all's own re-fetch racing an earlier tick's), and network jitter
  // does not guarantee they land in the order they were sent. Applying
  // whichever response arrives last, unconditionally, occasionally means
  // applying the STALE one — a just-confirmed write reads as if it never
  // happened. The epoch is what makes only the latest request's response
  // ever reach state, whichever order they actually resolve in.
  const epoch = useRef(0);
  const reload = useCallback(() => {
    if (!scopedPath) return;
    const mine = ++epoch.current;
    setLoading(true);
    api
      .get<T>(scopedPath)
      .then((d) => {
        if (mine !== epoch.current) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (mine !== epoch.current) return;
        setError(e.message);
      })
      .finally(() => {
        if (mine !== epoch.current) return;
        setLoading(false);
      });
  }, [scopedPath]);

  useEffect(() => {
    reload();
  }, [reload]);

  // `loading` flips true on every reload() so callers can disable buttons etc.
  // `initialLoading` is true ONLY before the first successful fetch — use it to
  // gate the full-page spinner so a post-mutation refetch keeps the current UI
  // (and its form state / scroll) on screen instead of remounting it.
  const initialLoading = loading && data === null && error === null;

  return { data, loading, initialLoading, error, reload, setData };
}
