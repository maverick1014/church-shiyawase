import { describe, expect, it } from 'vitest';
import {
  churchDateKey,
  churchDayOfWeek,
  churchInstant,
  churchParts,
  endOfChurchDate,
  fromChurchInput,
  isSundayDate,
  startOfChurchDay,
  sundaysOfMonth,
  toChurchInput,
  weekdayDatesOfMonth,
} from '../time';

/*
 * These all assert Malaysia time (UTC+8) regardless of the runtime's own zone,
 * which is the whole point of the module: CI and the Cloudflare Worker run in
 * UTC, a phone in KL runs in +08, and both must read the same clock.
 */

describe('churchParts', () => {
  it('reads a UTC instant as the Malaysian wall clock', () => {
    expect(churchParts(new Date('2026-08-09T02:00:00Z'))).toEqual({
      year: 2026,
      month: 8,
      day: 9,
      hour: 10,
      minute: 0,
    });
  });

  it('rolls the date forward when UTC is still on the previous day', () => {
    const p = churchParts(new Date('2026-08-08T17:30:00Z'));
    expect([p.year, p.month, p.day, p.hour]).toEqual([2026, 8, 9, 1]);
  });

  it('reports midnight as hour 0, not 24', () => {
    expect(churchParts(new Date('2026-08-08T16:00:00Z')).hour).toBe(0);
  });
});

describe('churchInstant', () => {
  it('is the inverse of churchParts', () => {
    const at = churchInstant(2026, 8, 9, 10, 0);
    expect(at.toISOString()).toBe('2026-08-09T02:00:00.000Z');
    expect(churchParts(at)).toEqual({ year: 2026, month: 8, day: 9, hour: 10, minute: 0 });
  });

  it('normalises an overflowing day into the next month', () => {
    // The roll-call sheet's month window relies on this: the end of December
    // is churchInstant(year, 13, 1).
    expect(churchParts(churchInstant(2026, 8, 33))).toMatchObject({ month: 9, day: 2 });
  });

  it('round-trips every hour of a day', () => {
    for (let h = 0; h < 24; h++) {
      expect(churchParts(churchInstant(2026, 3, 15, h, 30)).hour).toBe(h);
    }
  });
});

describe('day boundaries', () => {
  it('startOfChurchDay is 16:00 UTC the previous day', () => {
    expect(startOfChurchDay(new Date('2026-08-09T02:00:00Z')).toISOString()).toBe(
      '2026-08-08T16:00:00.000Z',
    );
  });

  it('churchDayOfWeek uses the Malaysian date, not the UTC one', () => {
    // 17:30Z Saturday is already Sunday 01:30 in Malaysia.
    expect(churchDayOfWeek(new Date('2026-08-08T17:30:00Z'))).toBe(0);
    expect(churchDayOfWeek(new Date('2026-08-08T15:30:00Z'))).toBe(6);
  });

  it('churchDateKey stamps the Malaysian date', () => {
    expect(churchDateKey(new Date('2026-08-08T17:30:00Z'))).toBe('2026-08-09');
  });
});

describe('form round-trip', () => {
  it('shows a stored instant as its Malaysian clock reading', () => {
    expect(toChurchInput('2026-08-09T02:00:00Z')).toBe('2026-08-09T10:00');
  });

  it('reads a datetime-local value as Malaysian, not as the browser zone', () => {
    expect(fromChurchInput('2026-08-09T10:00')).toBe('2026-08-09T02:00:00.000Z');
  });

  it('round-trips without drift', () => {
    const iso = '2026-12-31T16:45:00.000Z';
    expect(fromChurchInput(toChurchInput(iso))).toBe(iso);
  });

  it('treats empty and malformed input as no value', () => {
    expect(toChurchInput(null)).toBe('');
    expect(toChurchInput('not a date')).toBe('');
    expect(fromChurchInput('')).toBeNull();
    expect(fromChurchInput('2026-08-09')).toBeNull();
  });
});

describe('weekdayDatesOfMonth / sundaysOfMonth', () => {
  it('lists every Sunday of a month, in order', () => {
    // August 2026 starts on a Saturday, so its Sundays are the 2nd onwards.
    expect(sundaysOfMonth(2026, 8)).toEqual([
      '2026-08-02',
      '2026-08-09',
      '2026-08-16',
      '2026-08-23',
      '2026-08-30',
    ]);
  });

  it('includes a Sunday that falls on the 1st', () => {
    // 2026-02-01 is itself a Sunday — an off-by-one here would drop a whole
    // column off the sheet.
    expect(sundaysOfMonth(2026, 2)[0]).toBe('2026-02-01');
    expect(sundaysOfMonth(2026, 2)).toHaveLength(4);
  });

  it('stops at the month boundary in both directions', () => {
    const dec = sundaysOfMonth(2026, 12);
    // December 2026 ends on a Thursday: the last Sunday is the 27th, and the
    // walk must not roll into January.
    expect(dec[dec.length - 1]).toBe('2026-12-27');
    expect(dec.every((d) => d.startsWith('2026-12-'))).toBe(true);
    // …and January's list starts inside January, not on 2026-12-27 + 7.
    expect(sundaysOfMonth(2027, 1)[0]).toBe('2027-01-03');
  });

  it('handles a five-Sunday month and a leap February', () => {
    expect(sundaysOfMonth(2026, 3)).toHaveLength(5);
    expect(sundaysOfMonth(2024, 2)).toEqual([
      '2024-02-04',
      '2024-02-11',
      '2024-02-18',
      '2024-02-25',
    ]);
  });

  it('answers for any weekday, which is what the life-group sheet reads', () => {
    // Every Tuesday of August 2026 — the group sheet used to walk this itself.
    expect(weekdayDatesOfMonth(2026, 8, 2)).toEqual([
      '2026-08-04',
      '2026-08-11',
      '2026-08-18',
      '2026-08-25',
    ]);
  });

  it('is the same list whatever zone the runtime is in', () => {
    // The whole point of running the suite under TZ=America/New_York: these
    // are date LABELS, so a UTC-11 or UTC+8 runtime must not shift them.
    expect(sundaysOfMonth(2026, 8)[0]).toBe('2026-08-02');
    expect(new Date('2026-08-02T00:00:00Z').getUTCDay()).toBe(0);
  });
});

describe('isSundayDate', () => {
  it('accepts a Sunday and refuses every other day', () => {
    expect(isSundayDate('2026-08-02')).toBe(true);
    expect(isSundayDate('2026-08-03')).toBe(false);
    expect(isSundayDate('2026-08-01')).toBe(false);
  });

  it('refuses a date that does not exist', () => {
    // Date.UTC would roll this into March; the sheet must not accept it.
    expect(isSundayDate('2026-02-31')).toBe(false);
    expect(isSundayDate('2026-13-01')).toBe(false);
  });

  it('refuses anything that is not a bare YYYY-MM-DD', () => {
    expect(isSundayDate('')).toBe(false);
    expect(isSundayDate(null)).toBe(false);
    expect(isSundayDate(undefined)).toBe(false);
    expect(isSundayDate('2026-08-02T10:00:00Z')).toBe(false);
    expect(isSundayDate('nope')).toBe(false);
  });
});

describe('endOfChurchDate', () => {
  it('covers the whole Malaysian day, not just up to 08:00', () => {
    const end = endOfChurchDate('2026-08-31')!;
    // A course ending 2026-08-31 is still running at 09:00 that morning…
    expect(new Date('2026-08-31T01:00:00Z') < end).toBe(true);
    // …and at 23:59 that night…
    expect(new Date('2026-08-31T15:59:00Z') < end).toBe(true);
    // …but not once Malaysia has ticked over to the 1st.
    expect(new Date('2026-08-31T16:00:00Z') < end).toBe(false);
  });

  it('returns null for a missing or malformed date', () => {
    expect(endOfChurchDate(null)).toBeNull();
    expect(endOfChurchDate('')).toBeNull();
    expect(endOfChurchDate('nope')).toBeNull();
  });
});
