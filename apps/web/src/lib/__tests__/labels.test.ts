import { describe, it, expect } from 'vitest';
import {
  CHURCH_ROLE_OPTIONS,
  churchDisplayRole,
  churchRoleKey,
  isActivity,
  trainingKindClass,
  trainingKindKey,
  roleTagStyle,
  roleDot,
  hasFee,
  trainingMeta,
  enrollmentStatusClass,
  memberStatusKey,
  formatDate,
  formatDateTime,
  formatMoney,
  initialOf,
  groupHealthStatus,
  groupHealthClass,
  groupHealthKey,
  MEMBER_ROLE_FILTERS,
  memberRole,
  ROLE_TAG,
  roleKey,
  sheetTickKey,
} from '@/lib/labels';
import { en } from '@/lib/i18n/en';
import { ms } from '@/lib/i18n/ms';
import { zh } from '@/lib/i18n/zh';
import { TICK_ORDER } from '@/lib/sheet';
import {
  AccountRole,
  ChurchRole,
  DisplayRole,
  GroupPosition,
  isTrainingKind,
  TRAINING_KINDS,
  TrainingKind,
} from '@tog/shared';
import { ACCOUNT_ROLE_OPTIONS, accountRoleClass, accountRoleKey, accountRoleOptionKey } from '@/lib/labels';

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


/*
 * THE DRIFT GUARD.
 *
 * `deacon` and `co_worker` sat in the code enum for months while the database
 * type held neither, so saving a member as 执事 failed outright — two lists,
 * and nothing comparing them. A unit test cannot reach the database, so it
 * guards the half it CAN see: every value the code ships has to be a value the
 * app can actually name and paint. A new role added to the enum and to nothing
 * else fails here, at the point it is cheap to fix, instead of on the first
 * church that picks it.
 *
 * (The other half is `scripts/api-e2e.mjs`, which creates a member as each
 * role against the live database — that is what would have caught the missing
 * enum values.)
 */
describe('roles: every enum value is named, coloured and offered', () => {
  const DICTS = { en, zh, ms };

  it('gives every church role a label in all three languages', () => {
    for (const role of Object.values(ChurchRole))
      for (const [lang, dict] of Object.entries(DICTS))
        expect({ lang, role, label: dict[churchRoleKey(role)] }).toMatchObject({
          label: expect.stringMatching(/\S/),
        });
  });

  it('offers every church role in the member form', () => {
    expect([...CHURCH_ROLE_OPTIONS].sort()).toEqual(Object.values(ChurchRole).sort());
  });

  it('maps every church role onto a display role of its own', () => {
    for (const role of Object.values(ChurchRole)) {
      const shown = churchDisplayRole(role);
      // Never the fallback: a role that lands on 未分组 is one nobody wired up.
      expect({ role, shown }).not.toMatchObject({ shown: DisplayRole.Ungrouped });
      expect(Object.values(DisplayRole)).toContain(shown);
    }
  });

  it('gives every display role a label in all three languages', () => {
    for (const role of Object.values(DisplayRole))
      for (const [lang, dict] of Object.entries(DICTS))
        expect({ lang, role, label: dict[roleKey(role)] }).toMatchObject({
          label: expect.stringMatching(/\S/),
        });
  });

  it('gives every display role its own badge palette, and no two the same', () => {
    for (const role of Object.values(DisplayRole)) expect(ROLE_TAG[role]).toBeTruthy();
    const dots = Object.values(DisplayRole).map((role) => ROLE_TAG[role].dot);
    expect(new Set(dots).size).toBe(dots.length);
  });

  it('offers every display role as a members-list filter', () => {
    // ROLE_ORDER is the ranks; 未分组 is added beside them for the filter, so
    // the filter list is the one that has to cover the whole enum.
    expect([...MEMBER_ROLE_FILTERS].sort()).toEqual(Object.values(DisplayRole).sort());
  });

  it('reads a church-wide role ahead of any group position', () => {
    // 牧师/执事/同工/访客 are what somebody IS to the church; a group position is
    // where they sit in one life group, and must not overwrite it.
    expect(memberRole({ church_role: ChurchRole.Visitor, group_position: GroupPosition.NewMember }))
      .toBe(DisplayRole.Visitor);
    expect(memberRole({ church_role: ChurchRole.Member, group_position: GroupPosition.Leader }))
      .toBe(DisplayRole.Leader);
    expect(memberRole({ church_role: ChurchRole.Member, group_position: null }))
      .toBe(DisplayRole.Ungrouped);
  });
});

/**
 * The same drift guard `ChurchRole`/`DisplayRole` already have, for
 * `AccountRole` — which became a much more consequential enum the moment
 * `group_leader` started gating actual API access rather than only a client
 * permission flag: a value missing a label, a class or an offered option is
 * no longer just a cosmetic gap.
 */
describe('AccountRole: every value is named, coloured and offered', () => {
  const DICTS = { en, zh, ms };

  it('gives every account role a label and an option label in all three languages', () => {
    for (const role of Object.values(AccountRole))
      for (const [lang, dict] of Object.entries(DICTS)) {
        expect({ lang, role, label: dict[accountRoleKey(role)] }).toMatchObject({
          label: expect.stringMatching(/\S/),
        });
        expect({ lang, role, option: dict[accountRoleOptionKey(role)] }).toMatchObject({
          option: expect.stringMatching(/\S/),
        });
      }
  });

  it('offers every account role in the 权限角色 dropdown', () => {
    expect([...ACCOUNT_ROLE_OPTIONS].sort()).toEqual(Object.values(AccountRole).sort());
  });

  it('gives every account role its own badge class', () => {
    for (const role of Object.values(AccountRole)) expect(accountRoleClass(role)).toBeTruthy();
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
 * The one "who and when" line (0016) — built once and shown on the catalog
 * card, the detail header and the PUBLIC sign-up page, so what a visitor reads
 * before ringing the PIC is the same thing the admin sees.
 *
 * `t` here renders the English dictionary through the same `{placeholder}`
 * substitution the app uses, so a key that stopped existing (or a placeholder
 * that drifted) fails this test rather than shipping a literal `{name}`.
 */
const t = ((key: keyof typeof en, vars?: Record<string, string | number>) =>
  (en[key] as string).replace(/\{(\w+)\}/g, (whole, name: string) =>
    vars?.[name] === undefined ? whole : String(vars[name]),
  )) as Parameters<typeof trainingMeta>[1];

const COURSE = {
  kind: TrainingKind.Course,
  pic: 'Pastor Tan',
  pic_contact: '012-345 6789',
  total_sessions: 4,
  starts_on: '2026-06-01',
  ends_on: '2026-08-15',
  start_time: null,
  location: null,
};

/**
 * `trainingMeta` answers in ROWS, not one flat list: who runs it on the first,
 * when and where on the second. A phone wrapped the single joined line
 * mid-date ("日期：2026-" / "09-13 14:30"), which is the one part of it that
 * cannot be read broken in half.
 */
describe('trainingMeta', () => {
  it('reads a course as its PIC, contact, session count and date range', () => {
    expect(trainingMeta(COURSE, t)).toEqual([
      ['PIC: Pastor Tan', 'Contact 012-345 6789', '4 sessions'],
      ['2026-06-01 to 2026-08-15'],
    ]);
  });

  it('reads an activity as one occasion: when, and where', () => {
    expect(
      trainingMeta(
        {
          ...COURSE,
          kind: TrainingKind.Activity,
          total_sessions: 1,
          starts_on: '2026-09-12',
          ends_on: '2026-09-12',
          // Postgres hands a `time` back with seconds; the line shows HH:MM.
          start_time: '09:00:00',
          location: 'the church car park',
        },
        t,
      ),
    ).toEqual([
      ['PIC: Pastor Tan', 'Contact 012-345 6789'],
      ['On 2026-09-12 09:00', 'at the church car park'],
    ]);
  });

  it('drops the pieces a row does not have, rather than showing empty ones', () => {
    expect(
      trainingMeta(
        {
          ...COURSE,
          kind: TrainingKind.Activity,
          pic: null,
          pic_contact: null,
          starts_on: '2026-09-12',
          ends_on: '2026-09-12',
          start_time: null,
          location: null,
        },
        t,
      ),
    ).toEqual([['PIC: TBD'], ['On 2026-09-12']]);
  });
});

/*
 * 报名费 — "does this charge?" is asked in three places (the form's payment
 * block, the badges, and the server before it demands a receipt), so it is one
 * function. `numeric` arrives from PostgREST as a STRING, which is the case
 * that would otherwise read as NaN.
 */
describe('hasFee', () => {
  it('is true for a real amount, as a number or as PostgREST’s string', () => {
    expect(hasFee(30)).toBe(true);
    expect(hasFee('30.00')).toBe(true);
    expect(hasFee(0.5)).toBe(true);
  });

  it('is false for free — null, undefined, blank or zero', () => {
    expect(hasFee(null)).toBe(false);
    expect(hasFee(undefined)).toBe(false);
    expect(hasFee('')).toBe(false);
    expect(hasFee('   ')).toBe(false);
    expect(hasFee(0)).toBe(false);
    expect(hasFee('0.00')).toBe(false);
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
