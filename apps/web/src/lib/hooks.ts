'use client';

import { useCallback, useEffect, useState } from 'react';
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

  const reload = useCallback(() => {
    if (!scopedPath) return;
    setLoading(true);
    api
      .get<T>(scopedPath)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
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
