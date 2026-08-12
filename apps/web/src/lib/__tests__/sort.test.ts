import { describe, expect, it } from 'vitest';
import { sortRows, type SortValue } from '../sort';

/**
 * The members list's own ordering rule (小组 → 教会身份 → 姓名), expressed the
 * way the page expresses it: a row's group NAME, its role's rank as a number,
 * and the person's name. `null` group = 未分组.
 *
 * The fixture is deliberately ASCII: what is under test is the composite key,
 * not the collator, and a Chinese fixture would quietly assert that whatever
 * ICU the runner shipped with orders 张 and 陈 by pinyin.
 */
type Row = { group: string | null; rank: number; name: string };
const get = (r: Row, key: string): SortValue =>
  key === 'group' ? (r.group ?? undefined) : key === 'rank' ? r.rank : r.name;

const rows: Row[] = [
  { group: 'Grace', rank: 3, name: 'Chan' },
  { group: null, rank: 0, name: 'Chow' },
  { group: 'Agape', rank: 3, name: 'Lee' },
  { group: 'Grace', rank: 1, name: 'Wong' },
  { group: 'Grace', rank: 3, name: 'Ang' },
];
const names = (out: Row[]) => out.map((r) => r.name);

describe('sortRows', () => {
  it('orders by group, then role, then name', () => {
    expect(names(sortRows(rows, get, 'group', 'asc', ['rank', 'name']))).toEqual([
      // Agape before Grace; inside Grace the 执事 (rank 1) outranks the two
      // members, who then fall into name order; 未分组 is last however senior.
      'Lee',
      'Wong',
      'Ang',
      'Chan',
      'Chow',
    ]);
  });

  it('sorts a null group last in both directions', () => {
    expect(names(sortRows(rows, get, 'group', 'asc', ['rank', 'name'])).at(-1)).toBe('Chow');
    expect(names(sortRows(rows, get, 'group', 'desc', ['rank', 'name'])).at(-1)).toBe('Chow');
  });

  it('keeps tiebreakers ascending when the primary column is reversed', () => {
    // The groups reverse; the rank/name order inside Grace must not.
    expect(names(sortRows(rows, get, 'group', 'desc', ['rank', 'name'])).slice(0, 4)).toEqual([
      'Wong',
      'Ang',
      'Chan',
      'Lee',
    ]);
  });

  it('never compares the active column against itself', () => {
    // 'group' named twice must behave exactly as if it were named once.
    expect(names(sortRows(rows, get, 'group', 'asc', ['group', 'rank', 'name']))).toEqual(
      names(sortRows(rows, get, 'group', 'asc', ['rank', 'name'])),
    );
  });

  it('falls back to plain single-key sorting with no tiebreakers', () => {
    expect(names(sortRows(rows, get, 'name'))).toEqual(['Ang', 'Chan', 'Chow', 'Lee', 'Wong']);
  });

  it('does not mutate the rows it was given', () => {
    const input = [...rows];
    sortRows(input, get, 'name');
    expect(input).toEqual(rows);
  });
});
