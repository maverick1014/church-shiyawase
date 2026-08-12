'use client';

import { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';
export type SortValue = string | number | null | undefined;

/** One pair of present cells, compared the way a person reads them. */
function compareValues(a: NonNullable<SortValue>, b: NonNullable<SortValue>): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'zh-CN');
}

/**
 * Sort by `key`, breaking ties with `tiebreak` in order. Pure, so the ordering
 * rule a page states can be unit-tested without rendering it.
 *
 * A tiebreaker is ALWAYS ascending, whichever way the primary column points:
 * reversing "name" because the column beside it was clicked into descending
 * order reads as the list scrambling itself, not as a second sort.
 */
export function sortRows<T>(
  rows: readonly T[],
  getValue: (row: T, key: string) => SortValue,
  key: string,
  dir: SortDir = 'asc',
  tiebreak: readonly string[] = [],
): T[] {
  const keys = [key, ...tiebreak.filter((k) => k !== key)];
  const withValues = rows.map((row) => ({ row, v: keys.map((k) => getValue(row, k)) }));
  withValues.sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const av = a.v[i];
      const bv = b.v[i];
      // A missing cell sorts last whichever way the column points — and is
      // NOT negated by `desc`, or 未分组 would lead the reversed list instead
      // of trailing it. Both missing is simply a tie on this key: try the next.
      if (av == null || bv == null) {
        if (av == null && bv == null) continue;
        return av == null ? 1 : -1;
      }
      const cmp = compareValues(av, bv);
      if (cmp !== 0) return i === 0 && dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
  return withValues.map((x) => x.row);
}

/**
 * Click-to-sort for any table: pass the unsorted rows and a `(row, key) =>
 * value` getter, get back the sorted rows plus the header click handler.
 * Shared by every table page instead of a per-page reimplementation (G4).
 * Nulls/undefined always sort last, regardless of direction.
 *
 * `initial.tiebreak` names the columns that settle a tie — the members list
 * orders by 小组 then 教会身份 then name, which is three keys, not one. It is
 * read once (a page's ordering rule is a constant, not state), and the active
 * column is dropped from it so a key never compares against itself.
 */
export function useSortableRows<T>(
  rows: T[],
  getValue: (row: T, key: string) => SortValue,
  initial?: { key: string; dir?: SortDir; tiebreak?: readonly string[] },
) {
  const [sortKey, setSortKey] = useState<string | null>(initial?.key ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(initial?.dir ?? 'asc');
  const [tiebreak] = useState<readonly string[]>(() => initial?.tiebreak ?? []);

  const sorted = useMemo(
    () => (sortKey ? sortRows(rows, getValue, sortKey, sortDir, tiebreak) : rows),
    [rows, getValue, sortKey, sortDir, tiebreak],
  );

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  return { sorted, sortKey, sortDir, toggleSort };
}
