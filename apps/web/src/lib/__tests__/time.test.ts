import { describe, expect, it } from 'vitest';
import {
  churchDateKey,
  churchDayOfWeek,
  churchInstant,
  churchParts,
  endOfChurchDate,
  fromChurchInput,
  startOfChurchDay,
  toChurchInput,
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
    // The recurring-events "next occurrence" walk relies on this.
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
