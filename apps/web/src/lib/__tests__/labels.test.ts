import { describe, it, expect } from 'vitest';
import {
  isActivity,
  trainingKindClass,
  trainingKindKey,
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
  sheetTickKey,
} from '@/lib/labels';
import { en } from '@/lib/i18n/en';
import { TICK_ORDER } from '@/lib/sheet';
import { DisplayRole, isTrainingKind, TRAINING_KINDS, TrainingKind } from '@tog/shared';

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

/*
 * 培训&活动 — one catalog, two shapes (`kind`, migration 0014). Everything the
 * pages branch on reads the STORED code, so a language switch can never change
 * which shape a row is.
 */
describe('training kinds', () => {
  it('ships exactly course and activity, in catalog order', () => {
    expect([...TRAINING_KINDS]).toEqual([TrainingKind.Course, TrainingKind.Activity]);
  });

  it('accepts only a kind the app ships', () => {
    expect(isTrainingKind('course')).toBe(true);
    expect(isTrainingKind('activity')).toBe(true);
    // What the API refuses with a 400 rather than storing.
    expect(isTrainingKind('workshop')).toBe(false);
    expect(isTrainingKind(null)).toBe(false);
    expect(isTrainingKind(undefined)).toBe(false);
  });

  it('maps a kind to a dictionary key, never to text', () => {
    expect(trainingKindKey(TrainingKind.Course)).toBe('trainingKind.course');
    expect(trainingKindKey(TrainingKind.Activity)).toBe('trainingKind.activity');
  });

  it('gives the two shapes different badge tones', () => {
    expect(trainingKindClass(TrainingKind.Course)).toBe('b-brand');
    expect(trainingKindClass(TrainingKind.Activity)).toBe('b-warn');
    // An unknown value reads as a course — the column's own default.
    expect(trainingKindClass('anything')).toBe('b-brand');
  });

  it('isActivity is false for a course, a missing kind and a missing row', () => {
    expect(isActivity({ kind: TrainingKind.Activity })).toBe(true);
    expect(isActivity({ kind: TrainingKind.Course })).toBe(false);
    expect(isActivity({})).toBe(false);
    expect(isActivity(null)).toBe(false);
  });
});

/*
 * 聚会点名 — the sheet's ticks. A Sunday carries two, a hand-added meeting one,
 * and each is rendered through a dictionary key rather than a literal.
 */
describe('sheet ticks', () => {
  it('maps every tick to a key, never to text', () => {
    expect(sheetTickKey('pre_service')).toBe('events.col.preService');
    expect(sheetTickKey('service')).toBe('events.col.service');
    expect(sheetTickKey('attended')).toBe('events.col.attended');
  });

  it('names a key the dictionary actually ships', () => {
    for (const tick of TICK_ORDER) expect(en[sheetTickKey(tick)]).toBeTruthy();
  });
});
