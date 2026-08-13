import { describe, expect, it } from 'vitest';
import { groupHealthRollup, monthlyVisitAndActiveTrend, recentSundays, sundayPulse } from '../dashboard';
import { churchInstant } from '../time';
import { ChurchRole, Gender, MemberStatus } from '@tog/shared';
import type { MemberRow } from '../types';

/*
 * Like every other date helper in this app, this must hold under any runtime
 * zone — CI and the Worker run in UTC, `TZ=America/New_York npm test` runs
 * four or five hours behind it, and "the current month" must read the same
 * Malaysian answer either way. `now` is pinned with `churchInstant` rather
 * than left to the system clock, so the test itself is deterministic too.
 */

function member(over: Partial<MemberRow> & { id: string }): MemberRow {
  return {
    full_name: `ZZ ${over.id}`,
    english_name: null,
    email: null,
    phone: null,
    address: null,
    referred_by: null,
    gender: null as Gender | null,
    date_of_birth: null,
    church_role: ChurchRole.Member,
    status: MemberStatus.Active,
    group_id: null,
    group_position: null,
    hall_id: 'hall-1',
    joined_at: null,
    group_joined_at: null,
    notes: null,
    serving_roles: [],
    avatar_url: null,
    ...over,
  };
}

// "Now" is pinned to 2026-08-15 in Malaysia, so the trailing 6 months are
// 2026-03 .. 2026-08.
const now = churchInstant(2026, 8, 15);

describe('monthlyVisitAndActiveTrend', () => {
  it('buckets New Visits by the month joined_at falls in, nulls excluded', () => {
    const members: MemberRow[] = [
      member({ id: 'm1', joined_at: '2026-08-05' }),
      member({ id: 'm2', joined_at: '2026-05-10' }),
      member({ id: 'm3', joined_at: '2026-05-20', church_role: ChurchRole.Visitor }),
      member({ id: 'm4', joined_at: '2026-04-01', status: MemberStatus.Inactive }),
      member({ id: 'm5', joined_at: null }), // excluded — cannot be placed on the timeline
      member({ id: 'm6', joined_at: '2026-01-01' }), // before the 6-month window
    ];

    const trend = monthlyVisitAndActiveTrend(members, 6, now);
    expect(trend.map((p) => p.month)).toEqual([
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
    expect(trend.map((p) => p.visits)).toEqual([0, 1, 2, 0, 0, 1]);
  });

  it('counts Active Members cumulatively, excluding visitors and inactive members', () => {
    const members: MemberRow[] = [
      member({ id: 'm1', joined_at: '2026-08-05' }), // active member, joins in the last month
      member({ id: 'm2', joined_at: '2026-05-10' }), // active member, joins mid-window
      member({ id: 'm3', joined_at: '2026-05-20', church_role: ChurchRole.Visitor }), // excluded: visitor
      member({ id: 'm4', joined_at: '2026-04-01', status: MemberStatus.Inactive }), // excluded: inactive
      member({ id: 'm5', joined_at: null }), // excluded: no date to place them at
      member({ id: 'm6', joined_at: '2026-01-01' }), // active member, joined before the window
    ];

    const trend = monthlyVisitAndActiveTrend(members, 6, now);
    expect(trend.map((p) => p.active)).toEqual([1, 1, 2, 2, 2, 3]);
  });

  it('is a snapshot of TODAY’s status/role projected backward, not a real history', () => {
    // A member active and non-visitor NOW, who joined 3 months into the
    // window, counts as "active" for every month from their join date
    // onward — even though nothing is known about whether they were actually
    // marked active back then.
    const members: MemberRow[] = [member({ id: 'm1', joined_at: '2026-05-01' })];
    const trend = monthlyVisitAndActiveTrend(members, 6, now);
    const byMonth = Object.fromEntries(trend.map((p) => [p.month, p.active]));
    expect(byMonth['2026-04']).toBe(0);
    expect(byMonth['2026-05']).toBe(1);
    expect(byMonth['2026-08']).toBe(1);
  });

  it('returns an empty trend for an empty roster', () => {
    const trend = monthlyVisitAndActiveTrend([], 6, now);
    expect(trend).toHaveLength(6);
    expect(trend.every((p) => p.visits === 0 && p.active === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * The pastoral dashboard (0130)
 * ---------------------------------------------------------------------- */

describe('recentSundays', () => {
  // 2026-08-13 is a Thursday; the Sunday on or before it is 2026-08-09.
  const thursday = new Date('2026-08-13T04:00:00Z');

  it('walks back from the Sunday on or before today, oldest first', () => {
    expect(recentSundays(thursday, 4)).toEqual([
      '2026-07-19',
      '2026-07-26',
      '2026-08-02',
      '2026-08-09',
    ]);
  });

  it('counts today itself when today IS a Sunday', () => {
    const sunday = new Date('2026-08-09T04:00:00Z');
    expect(recentSundays(sunday, 2)).toEqual(['2026-08-02', '2026-08-09']);
  });

  it('crosses a month boundary, because eight Sundays is two months', () => {
    // The reason this walks days rather than listing a month's Sundays.
    const out = recentSundays(thursday, 8);
    expect(out).toHaveLength(8);
    expect(out[0]).toBe('2026-06-21');
    expect(new Set(out.map((d) => d.slice(0, 7))).size).toBeGreaterThan(1);
  });

  it('answers nothing for a non-positive count rather than looping', () => {
    expect(recentSundays(thursday, 0)).toEqual([]);
    expect(recentSundays(thursday, -3)).toEqual([]);
  });
});

describe('sundayPulse', () => {
  const pts = (...service: number[]) =>
    service.map((s, i) => ({ date: `2026-08-0${i + 1}`, preService: 0, service: s }));

  it('compares the latest Sunday against the ones BEFORE it, not including itself', () => {
    // Mean of 10/20/30 is 20, so 40 is +20. Including itself would say +15.
    const out = sundayPulse(pts(10, 20, 30, 40));
    expect(out.latest?.service).toBe(40);
    expect(out.average).toBe(20);
    expect(out.delta).toBe(20);
  });

  it('reports a fall as a negative delta', () => {
    expect(sundayPulse(pts(30, 30, 30, 24)).delta).toBe(-6);
  });

  it('treats an unmarked Sunday as a real zero rather than a gap', () => {
    expect(sundayPulse(pts(20, 0, 20, 20)).average).toBeCloseTo(13.333, 2);
  });

  it('has no average to give from a single Sunday, which is not the same as zero', () => {
    const out = sundayPulse(pts(42));
    expect(out.latest?.service).toBe(42);
    expect(out.average).toBeNull();
    expect(out.delta).toBeNull();
  });

  it('answers empty for no Sundays at all', () => {
    expect(sundayPulse([])).toEqual({ latest: null, average: null, delta: null });
  });
});

describe('groupHealthRollup', () => {
  it('counts each bucket, in the order the page draws them', () => {
    expect(
      groupHealthRollup([
        { status: 'balanced' },
        { status: 'splittable' },
        { status: 'balanced' },
      ]),
    ).toEqual([
      { status: 'splittable', count: 1 },
      { status: 'balanced', count: 2 },
      { status: 'need_members', count: 0 },
    ]);
  });

  it('keeps every bucket even when nothing is in it, so the row never reflows', () => {
    expect(groupHealthRollup([]).map((b) => b.count)).toEqual([0, 0, 0]);
  });
});
