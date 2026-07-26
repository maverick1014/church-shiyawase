import { describe, it, expect } from 'vitest';
import {
  roleTagStyle,
  roleDot,
  categoryBadgeClass,
  enrollmentStatusClass,
  memberStatusLabel,
  formatMoney,
  initialOf,
  groupHealthStatus,
  groupHealthClass,
  GROUP_HEALTH_LABELS,
} from '@/lib/labels';

describe('role labels', () => {
  it('roleTagStyle returns the pastor palette', () => {
    expect(roleTagStyle('牧师')).toEqual({ background: '#fbe3e0', color: '#b3261e' });
  });

  it('roleDot returns the core-member dot colour', () => {
    expect(roleDot('核心成员')).toBe('#2f7ad1');
  });

  it('unknown role falls back to the 未分组 palette', () => {
    expect(roleTagStyle('不存在的身份')).toEqual({ background: '#f0eeec', color: '#9a938f' });
    expect(roleDot('不存在的身份')).toBe('#c3bbb6');
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

describe('memberStatusLabel', () => {
  it('maps member statuses to Chinese labels', () => {
    expect(memberStatusLabel('active')).toBe('在册');
    expect(memberStatusLabel('inactive')).toBe('停止聚会');
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

  it('labels and badge classes cover every status', () => {
    expect(GROUP_HEALTH_LABELS.splittable).toBe('可分植');
    expect(GROUP_HEALTH_LABELS.need_members).toBe('可加人');
    expect(GROUP_HEALTH_LABELS.balanced).toBe('刚好');
    expect(groupHealthClass('splittable')).toBe('b-good');
    expect(groupHealthClass('need_members')).toBe('b-warn');
    expect(groupHealthClass('balanced')).toBe('b-gray');
  });
});

describe('formatting helpers', () => {
  it('formatMoney formats with two decimals', () => {
    expect(formatMoney(200)).toBe('200.00');
  });

  it('initialOf returns the last two chars of a name', () => {
    expect(initialOf('陈约翰')).toBe('约翰');
  });

  it('initialOf returns ? for null', () => {
    expect(initialOf(null)).toBe('?');
  });
});
