import { describe, expect, it } from 'vitest';
import {
  columnTickState,
  MEETING_TICKS,
  parseColumnKey,
  sheetColumns,
  SUNDAY_TICKS,
} from '../sheet';
import type { SheetMeeting } from '../types';

/*
 * The roll-call sheet's columns are a calendar question, so — like every other
 * date helper — these must hold under any runtime zone. CI and the Worker run
 * in UTC and `TZ=America/New_York npm test` runs them at UTC-4/5, while a
 * 20:00 KL meeting is 12:00 UTC and an 08:00 one is the PREVIOUS UTC day.
 */

const meeting = (over: Partial<SheetMeeting> & { starts_at: string }): SheetMeeting => ({
  id: 'e1',
  title: 'ZZ',
  hall_id: null,
  ...over,
});

describe('sheetColumns', () => {
  it('draws every Sunday of the month, from the calendar', () => {
    const cols = sheetColumns(2026, 8, []);
    expect(cols.map((c) => c.date)).toEqual([
      '2026-08-02',
      '2026-08-09',
      '2026-08-16',
      '2026-08-23',
      '2026-08-30',
    ]);
    expect(cols.every((c) => c.kind === 'sunday')).toBe(true);
    expect(cols[0].key).toBe('sunday:2026-08-02');
  });

  it('gives a Sunday its two ticks and a meeting exactly one', () => {
    const cols = sheetColumns(2026, 8, [meeting({ starts_at: '2026-08-31T12:00:00Z' })]);
    const sunday = cols.find((c) => c.kind === 'sunday');
    const added = cols.find((c) => c.kind === 'meeting');
    expect(sunday?.ticks).toEqual([...SUNDAY_TICKS]);
    expect(added?.ticks).toEqual([...MEETING_TICKS]);
    expect(added?.ticks).toHaveLength(1); // never invent a 会前 for a meeting
  });

  it('sorts a hand-added meeting into place among the Sundays', () => {
    // 31 August 2026, 20:00 in Malaysia — the owner's night prayer meeting.
    const cols = sheetColumns(2026, 8, [
      meeting({ id: 'night', title: 'Night prayer', starts_at: '2026-08-31T12:00:00Z' }),
    ]);
    expect(cols.map((c) => `${c.date}/${c.kind}`)).toEqual([
      '2026-08-02/sunday',
      '2026-08-09/sunday',
      '2026-08-16/sunday',
      '2026-08-23/sunday',
      '2026-08-30/sunday',
      '2026-08-31/meeting',
    ]);
    expect(cols[5].key).toBe('meeting:night');
    expect(cols[5].meeting?.title).toBe('Night prayer');
  });

  it('dates a meeting by its MALAYSIAN day, not the runtime’s', () => {
    // 2026-08-09 08:00 KL is 2026-08-09T00:00Z — still 8 August in New York.
    const [col] = sheetColumns(2026, 8, [
      meeting({ starts_at: '2026-08-09T00:00:00Z' }),
    ]).filter((c) => c.kind === 'meeting');
    expect(col.date).toBe('2026-08-09');
  });

  it('puts a Sunday ahead of a meeting held the same day, whatever its time', () => {
    // 2026-08-02 is a Sunday; this meeting is 07:00 that morning in KL.
    const cols = sheetColumns(2026, 8, [
      meeting({ id: 'early', starts_at: '2026-08-01T23:00:00Z' }),
    ]);
    expect(cols.slice(0, 2).map((c) => c.kind)).toEqual(['sunday', 'meeting']);
    expect(cols[1].date).toBe('2026-08-02');
  });

  it('orders two meetings on one day by time, then title, then id', () => {
    const cols = sheetColumns(2026, 8, [
      meeting({ id: 'b', title: 'Zebra', starts_at: '2026-08-31T12:00:00Z' }),
      meeting({ id: 'a', title: 'Apple', starts_at: '2026-08-31T12:00:00Z' }),
      meeting({ id: 'c', title: 'Early', starts_at: '2026-08-31T02:00:00Z' }),
    ]);
    expect(cols.filter((c) => c.kind === 'meeting').map((c) => c.meeting?.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('ignores nothing and invents nothing: no meetings means Sundays only', () => {
    expect(sheetColumns(2026, 2, []).map((c) => c.date)).toEqual([
      '2026-02-01',
      '2026-02-08',
      '2026-02-15',
      '2026-02-22',
    ]);
  });
});

describe('parseColumnKey', () => {
  it('reads back the key each kind of column hands out', () => {
    expect(parseColumnKey('sunday:2026-08-02')).toEqual({ kind: 'sunday', date: '2026-08-02' });
    expect(parseColumnKey('meeting:abc-123')).toEqual({ kind: 'meeting', eventId: 'abc-123' });
  });

  it('round-trips whatever sheetColumns produced', () => {
    const cols = sheetColumns(2026, 8, [meeting({ id: 'night', starts_at: '2026-08-31T12:00:00Z' })]);
    for (const c of cols) {
      const parsed = parseColumnKey(c.key);
      expect(parsed?.kind).toBe(c.kind);
    }
  });

  it('refuses anything it did not hand out', () => {
    for (const junk of ['', 'sunday', 'sunday:', ':2026-08-02', 'weekday:2026-08-02', null, undefined])
      expect(parseColumnKey(junk)).toBeNull();
  });
});

/**
 * What the check-all in a column header shows, and therefore which way it goes
 * when it is pressed: `all` clears the column (destructive — the page puts that
 * behind a confirmation), anything else fills it.
 */
describe('columnTickState', () => {
  it('is none when a column has no rows at all', () => {
    expect(columnTickState([])).toBe('none');
  });

  it('is none when nobody is ticked', () => {
    expect(columnTickState([false])).toBe('none');
    expect(columnTickState([false, false, false])).toBe('none');
  });

  it('is all when everybody is ticked', () => {
    expect(columnTickState([true])).toBe('all');
    expect(columnTickState([true, true, true])).toBe('all');
  });

  it('is some for anything in between — never rounded to all or none', () => {
    expect(columnTickState([true, false])).toBe('some');
    expect(columnTickState([false, true])).toBe('some');
    expect(columnTickState([true, true, false])).toBe('some');
    expect(columnTickState([false, false, true])).toBe('some');
  });

  it('says all for a single-member column that is ticked', () => {
    // A church hall with one person on the sheet still has to be clearable.
    expect(columnTickState([true])).toBe('all');
  });
});
