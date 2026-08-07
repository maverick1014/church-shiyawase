import { describe, it, expect } from 'vitest';
import {
  roleTagStyle,
  roleDot,
  categoryBadgeClass,
  enrollmentStatusClass,
  memberStatusKey,
  formatDate,
  formatDateTime,
  formatMoney,
  initialOf,
  groupHealthStatus,
  groupHealthClass,
  groupHealthKey,
} from '@/lib/labels';
import { DisplayRole } from '@tog/shared';

describe('role palette', () => {
  it('roleTagStyle returns the pastor palette', () => {
    expect(roleTagStyle(DisplayRole.Pastor)).toEqual({ background: '#fbe3e0', color: '#b3261e' });
  });

  it('roleDot returns the core-member dot colour', () => {
    expect(roleDot(DisplayRole.CoreMember)).toBe('#2f7ad1');
  });

  it('unknown role falls back to the ungrouped palette', () => {
    expect(roleTagStyle('no-such-role')).toEqual({ background: '#f0eeec', color: '#9a938f' });
    expect(roleDot('no-such-role')).toBe('#c3bbb6');
  });
});

describe('categoryBadgeClass', () => {
  it('always returns b-accent', () => {
    expect(categoryBadgeClass('门徒')).toBe('b-accent');
    expect(categoryBadgeClass(null)).toBe('b-accent');
    expect(categoryBadgeClass('anything')).toBe('b-accent');
  });
});

describe('enrollmentStatusClass', () => {
  it('maps enrollment statuses to badge classes', () => {
    expect(enrollmentStatusClass('completed')).toBe('b-good');
    expect(enrollmentStatusClass('approved')).toBe('b-good');
    expect(enrollmentStatusClass('in_progress')).toBe('b-warn');
    expect(enrollmentStatusClass('dropped')).toBe('b-crit');
    expect(enrollmentStatusClass('pending')).toBe('b-gray');
  });
});

describe('memberStatusKey', () => {
  it('maps member statuses to dictionary keys', () => {
    expect(memberStatusKey('active')).toBe('memberStatus.active');
    expect(memberStatusKey('inactive')).toBe('memberStatus.inactive');
  });
});

describe('groupHealthStatus', () => {
  it('splittable when total > 10 and new members <= 2', () => {
    expect(groupHealthStatus(11, 2)).toBe('splittable');
    expect(groupHealthStatus(15, 0)).toBe('splittable');
  });

  it('not splittable once new members exceed 2, even above 10 total', () => {
    // total=11, new=3 → old=8, new<=old is true but total is not <10, so this
    // falls through to the balanced default rather than need_members.
    expect(groupHealthStatus(11, 3)).toBe('balanced');
  });

  it('need_members when total < 10 and new members <= old members', () => {
    expect(groupHealthStatus(9, 4)).toBe('need_members'); // old=5, 4<=5
    expect(groupHealthStatus(0, 0)).toBe('need_members'); // an empty group needs members
  });

  it('not need_members once new members outnumber old members', () => {
    expect(groupHealthStatus(9, 5)).toBe('balanced'); // old=4, 5<=4 is false
  });

  it('exactly 10 total members falls into balanced (neither >10 nor <10)', () => {
    expect(groupHealthStatus(10, 0)).toBe('balanced');
    expect(groupHealthStatus(10, 10)).toBe('balanced');
  });

  it('keys and badge classes cover every status', () => {
    expect(groupHealthKey('splittable')).toBe('groupHealth.splittable');
    expect(groupHealthKey('need_members')).toBe('groupHealth.need_members');
    expect(groupHealthKey('balanced')).toBe('groupHealth.balanced');
    expect(groupHealthClass('splittable')).toBe('b-good');
    expect(groupHealthClass('need_members')).toBe('b-warn');
    expect(groupHealthClass('balanced')).toBe('b-gray');
  });
});

describe('formatting helpers', () => {
  it('formatMoney formats with two decimals', () => {
    expect(formatMoney(200)).toBe('200.00');
  });

  it('initialOf returns the last two chars of a CJK name', () => {
    expect(initialOf('陈约翰')).toBe('约翰');
  });

  it('initialOf returns the leading initial of a Latin name', () => {
    expect(initialOf('john tan')).toBe('J');
  });

  it('initialOf returns ? for null or blank', () => {
    expect(initialOf(null)).toBe('?');
    expect(initialOf('   ')).toBe('?');
  });
});

describe('date labels', () => {
  it('render in Malaysia time, not the runtime zone', () => {
    // The 10:00 Sunday service, stored as the UTC instant it happens at.
    expect(formatDateTime('2026-08-09T02:00:00Z')).toBe('08-09 10:00');
    // Late-evening UTC is already the next day in Malaysia.
    expect(formatDate('2026-08-08T17:30:00Z')).toBe('2026-08-09');
  });

  it('keep a stored DATE on its own day', () => {
    expect(formatDate('2026-08-31')).toBe('2026-08-31');
  });

  it('fall back rather than crash on empty or malformed values', () => {
    expect(formatDate(null)).toBe('\u2014');
    expect(formatDateTime(undefined)).toBe('\u2014');
    expect(formatDate('nonsense')).toBe('nonsense');
  });
});
