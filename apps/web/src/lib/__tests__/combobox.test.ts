import { describe, it, expect } from 'vitest';
import { comboboxFilter, nextActiveIndex, type ComboOption } from '@/lib/combobox';

/**
 * The matching behind every member picker in the app. What is asserted here is
 * what a user typing a name actually gets — the component itself only draws it.
 */
const PEOPLE: ComboOption[] = [
  { value: 'a', label: '陈约翰', hint: 'Elder' },
  { value: 'b', label: '陈小美', hint: 'Member' },
  { value: 'c', label: 'Grace Lim', hint: 'Group leader' },
  { value: 'd', label: 'Daniel Tan', hint: 'Member' },
];

describe('comboboxFilter', () => {
  it('offers the whole list when nothing has been typed', () => {
    expect(comboboxFilter(PEOPLE, '')).toHaveLength(4);
    expect(comboboxFilter(PEOPLE, '   ')).toHaveLength(4);
  });

  it('returns a copy, never the caller’s own array', () => {
    const all = comboboxFilter(PEOPLE, '');
    expect(all).not.toBe(PEOPLE);
    expect(all).toEqual([...PEOPLE]);
  });

  it('matches on any part of the label, not just its start', () => {
    expect(comboboxFilter(PEOPLE, 'lim').map((o) => o.value)).toEqual(['c']);
    expect(comboboxFilter(PEOPLE, 'an').map((o) => o.value)).toEqual(['d']);
  });

  it('ignores case', () => {
    expect(comboboxFilter(PEOPLE, 'GRACE').map((o) => o.value)).toEqual(['c']);
    expect(comboboxFilter(PEOPLE, 'grace').map((o) => o.value)).toEqual(['c']);
  });

  it('matches Chinese names, which are data and never translated', () => {
    expect(comboboxFilter(PEOPLE, '陈').map((o) => o.value)).toEqual(['a', 'b']);
    expect(comboboxFilter(PEOPLE, '小美').map((o) => o.value)).toEqual(['b']);
  });

  it('searches the hint as well as the label', () => {
    expect(comboboxFilter(PEOPLE, 'elder').map((o) => o.value)).toEqual(['a']);
  });

  it('requires every word, in any order', () => {
    expect(comboboxFilter(PEOPLE, '陈 elder').map((o) => o.value)).toEqual(['a']);
    expect(comboboxFilter(PEOPLE, 'elder 陈').map((o) => o.value)).toEqual(['a']);
    expect(comboboxFilter(PEOPLE, '陈 leader')).toEqual([]);
  });

  it('collapses runs of whitespace rather than matching on them', () => {
    expect(comboboxFilter(PEOPLE, '  grace   leader ').map((o) => o.value)).toEqual(['c']);
  });

  it('keeps the order it was given', () => {
    expect(comboboxFilter(PEOPLE, 'member').map((o) => o.value)).toEqual(['b', 'd']);
  });

  it('answers empty when nothing matches', () => {
    expect(comboboxFilter(PEOPLE, 'zzz')).toEqual([]);
  });

  it('copes with an option that carries no hint', () => {
    expect(comboboxFilter([{ value: 'x', label: 'Solo' }], 'solo')).toHaveLength(1);
    expect(comboboxFilter([{ value: 'x', label: 'Solo' }], 'member')).toHaveLength(0);
  });
});

describe('nextActiveIndex', () => {
  it('starts at the first option going down, the last going up', () => {
    expect(nextActiveIndex(-1, 4, 1)).toBe(0);
    expect(nextActiveIndex(-1, 4, -1)).toBe(3);
  });

  it('steps one at a time', () => {
    expect(nextActiveIndex(1, 4, 1)).toBe(2);
    expect(nextActiveIndex(2, 4, -1)).toBe(1);
  });

  it('wraps at both ends', () => {
    expect(nextActiveIndex(3, 4, 1)).toBe(0);
    expect(nextActiveIndex(0, 4, -1)).toBe(3);
  });

  it('highlights nothing when the filter left no options', () => {
    expect(nextActiveIndex(-1, 0, 1)).toBe(-1);
    expect(nextActiveIndex(2, 0, -1)).toBe(-1);
  });
});
